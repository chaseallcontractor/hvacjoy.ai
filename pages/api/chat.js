/* eslint-disable */
// pages/api/chat.js
import { getSupabaseAdmin } from '../../lib/supabase-admin';
import { insertCalendarEvent } from '../../lib/google-calendar.js';

// --- Timezone (Georgia/Eastern by default) ---
const DEFAULT_TZ = process.env.DEFAULT_TZ || 'America/New_York';
// NEW: default state if caller doesn't say it
const DEFAULT_STATE = process.env.DEFAULT_STATE || 'GA';

// Pricing from env (kept for future use; not spoken automatically)
const DIAG_FEE  = process.env.DIAG_FEE  ? Number(process.env.DIAG_FEE)  : 89;
const MAINT_FEE = process.env.MAINT_FEE ? Number(process.env.MAINT_FEE) : 179;

// Persona/prompt (neutral, polite tone; no gendered address)
// UPDATED: no proactive pricing; no thermostat/brand/symptom prompts
const SYSTEM_PROMPT = `
You are “Joy,” the inbound phone agent for a residential H.V.A.C company.
Primary goal: warmly book service, set expectations, and capture complete job details. Do not diagnose.

Voice & Style
- Friendly, professional, and concise (≤ 14 words).
- Use plain language (≈ 8th grade). Natural “please” and “thank you.”
- When the caller says “thank you,” respond with “It’s my pleasure.”
- Avoid gendered address (no sir/ma’am, no Mr./Ms.). Keep it neutral.
- Briefly acknowledge discomfort or problems, then help.

Safety & Guardrails
- Do not proactively quote prices. If the caller asks about pricing, answer briefly and move on.
- Never promise exact arrival times. Offer a window and a call-ahead.
- If smoke, sparks, gas smell, or health risk: advise calling 911 and escalate.
- Do not discuss competitor pricing or quote repair costs beyond policy.
- Ask permission before any hold.

Call Flow
1) Greeting (only once per call).
2) Capture + confirm:
   - Full name
   - **Full service address** (single question: street, city, and zip). Then reflect it back for yes/no confirmation.
   - Best callback number
3) Scheduling:
   - Offer earliest availability; **ask for a date**, then arrival window + call-ahead.
   - If the caller provides a **specific time**, accept it instead of a window.
   - If caller is flexible all day, note "flexible_all_day."
4) Membership check (after booking).
5) Confirm politely (no long read-back).
6) Close politely.

Edge Scripts (use when relevant)
- Ants/pests: “Thanks for sharing that. Please avoid spraying chemicals before the technician arrives.”
- Reschedule: “Of course—happy to help. What new time works best?”
- Irate caller: “I understand this is frustrating. I can secure your details, explain today’s fees, and book the earliest available appointment.”

Output format (single JSON):
{
  "reply": "<Joy's next line>",
  "slots": { ...see schema... },
  "done": false | true,
  "goodbye": null | "<string>",
  "needs_confirmation": false | true
}

slots schema:
{
  "full_name": null | "<string>",
  "callback_number": null | "<string>",
  "service_address": {
    "line1": null | "<string>",
    "line2": null | "<string>",
    "city": null | "<string>",
    "state": null | "<string>",
    "zip": null | "<string>",
    "gate_or_entry_notes": null | "<string>",
    "parking_notes": null | "<string>"
  },
  "unit_count": null | <number>,
  "unit_locations": null | "<string>",
  "brand": null | "<string>",
  "symptoms": [],
  "thermostat": { "setpoint": null | "<string|number>", "current": null | "<string|number>" },
  "membership_status": null | "member" | "non_member" | "unknown",
  "preferred_date": null | "<YYYY-MM-DD or natural language>",
  "preferred_time": null | "<HH:MM 24h>",
  "preferred_window": null | "morning" | "afternoon" | "flexible_all_day" | "<time window>",
  "call_ahead": null | true | false,
  "hazards_pets_ants_notes": null | "<string>",
  "pricing_disclosed": true | false,
  "emergency": false | true,

  "pending_fix": null | { "field": "<path>", "prompt": "<follow-up question>" },
  "confirmation_pending": null | true | false,
  "summary_reads": null | <number>,
  "address_confirm_pending": null | true | false,
  "callback_confirm_pending": null | true | false,

  "_phone_partial": null | "<digits so far>"
}

Behavior
- Continue the call. Do not repeat the greeting (“Welcome to H.V.A.C Joy…”).
- Do NOT ask again for any slot already non-null in "known slots".
- Ask for the **full address** in one question; if the caller gives only street (no city/zip), ask specifically for the missing parts — do not claim the address is “updated.”
- Require a date for booking. Ask for date first, then window **unless a specific time was provided**.
- If the caller corrects a prior detail, acknowledge, update, and confirm the new value.
- When done is reached, do NOT read any summary and do NOT ask “Is everything correct?” — simply close politely.
`.trim();

function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

async function fetchHistoryMessages(callSid) {
  if (!callSid) return [];
  try {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from('call_transcripts')
      .select('role, text, turn_index')
      .eq('call_sid', callSid)
      .order('turn_index', { ascending: true })
      .limit(60);

    return (data || []).map(r => ({
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.text || ''
    })); 
  } catch (e) {
    console.error('fetchHistoryMessages error', e);
    return [];
  }
}

// ----------------- Slot merge -----------------
function mergeSlots(oldSlots = {}, newSlots = {}) {
  const merged = { ...(oldSlots || {}) };
  for (const [k, v] of Object.entries(newSlots || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      merged[k] = mergeSlots(merged[k] || {}, v);
    } else if (Array.isArray(v)) {
      merged[k] = v.length ? v : (merged[k] || []);
    } else {
      merged[k] = (v ?? merged[k] ?? null);
    }
  }
  return merged;
}

// ---------- Heuristics ----------
function inferPreferredWindowFrom(text) {
  const t = (text || '').toLowerCase();
  if (/\bmorning\b/.test(t)) return 'morning';
  if (/\bafternoon\b/.test(t)) return 'afternoon';
  if (/\bevening\b/.test(t)) return 'afternoon';
  if (/\bflexible\b.*\ball day\b|\ball day\b.*\bflexible\b/i.test(t)) return 'flexible_all_day';
  return null;
}
function inferYesNoCallAhead(text) {
  const t = (text || '').toLowerCase();
  if (/\b(yes|yeah|yep|sure|please do|that works|ok|okay)\b/.test(t)) return true;
  if (/\b(no|nope|nah|don’t|do not|no thanks|not necessary)\b/.test(t)) return false;
  return null;
}
function getLastAssistantQuestion(history) {
  const assistantLines = (history || []).filter(m => m.role === 'assistant').map(m => m.content);
  for (let i = assistantLines.length - 1; i >= 0; i--) {
    const line = (assistantLines[i] || '').trim();
    if (line.endsWith('?')) return line;
  }
  return null;
}

// ----------------- Address parsing support ------------------

// Normalize “one two three four …” (and “oh/o”=0) at the **start** of the line.
function normalizeLeadingNumberWords(s = '') {
  if (!s) return s;
  const map = {
    zero: '0', oh: '0', o: '0',
    one: '1', two: '2', three: '3', four: '4', five: '5',
    six: '6', seven: '7', eight: '8', nine: '9'
  };
  // strip filler words the ASR sometimes inserts
  let text = s.replace(/\b(comma|period|dot|dash|hyphen)\b/gi, ' ');
  // scan tokens from the start until a non-number token
  const tokens = text.split(/[\s,.-]+/);
  let i = 0, digits = '';
  while (i < tokens.length) {
    const t = (tokens[i] || '').toLowerCase();
    if (t in map) { digits += map[t]; i++; continue; }
    if (/^\d+$/.test(t)) { digits += t; i++; continue; }
    if (t === 'and') { i++; continue; } // ignore “and”
    break;
  }
  if (digits.length >= 1) {
    const rest = tokens.slice(i).join(' ');
    return `${digits} ${rest}`.trim();
  }
  return text;
}

const STATE_MAP = {
  alabama:'AL', alaska:'AK', arizona:'AZ', arkansas:'AR', california:'CA', colorado:'CO',
  connecticut:'CT', delaware:'DE', 'district of columbia':'DC', florida:'FL', georgia:'GA',
  hawaii:'HI', idaho:'ID', illinois:'IL', indiana:'IN', iowa:'IA', kansas:'KS', kentucky:'KY',
  louisiana:'LA', maine:'ME', maryland:'MD', massachusetts:'MA', michigan:'MI', minnesota:'MN',
  mississippi:'MS', missouri:'MO', montana:'MT', nebraska:'NE', nevada:'NV', 'new hampshire':'NH',
  'new jersey':'NJ', 'new mexico':'NM', 'new york':'NY', 'north carolina':'NC', 'north dakota':'ND',
  ohio:'OH', oklahoma:'OK', oregon:'OR', pennsylvania:'PA', 'rhode island':'RI',
  'south carolina':'SC', 'south dakota':'SD', tennessee:'TN', texas:'TX', utah:'UT',
  vermont:'VT', virginia:'VA', washington:'WA', 'west virginia':'WV', wisconsin:'WI', wyoming:'WY'
};

const STATE_NAMES = Object.keys(STATE_MAP);
const STATE_NAME_RE = new RegExp(
  `(?:${STATE_NAMES.map(s => s.replace(/\s+/g, '\\s+')).join('|')})`,
  'i'
);

function normState(s) {
  if (!s) return null;
  const up = s.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(up)) return up;
  const abbr = STATE_MAP[(s||'').toLowerCase()];
  return abbr || null;
}

// Normalize punctuation & spelled numbers for address parsing
function cleanAddressText(line = '') {
  if (!line) return '';
  return normalizeLeadingNumberWords(
    line
      .replace(/(\d)\.(?=\s|$)/g, '$1')   // "2478." -> "2478"
      .replace(/\s*\.\s*/g, ' ')          // ". " -> " "
      .replace(/\s{2,}/g, ' ')            // collapse spaces
      .trim()
  );
}

const STREET_SUFFIX =
  '(?:Street|St|Drive|Dr|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Court|Ct|Way|Walk|Trail|Trl|Circle|Cir|Parkway|Pkwy|Place|Pl|Terrace|Ter|Trace|Pass|Path|Point|Pt|Loop|Run|Highway|Hwy|Cove|Cv)';

function parseFullAddress(line) {
  const txt = cleanAddressText(line);

  // Primary: require a known street suffix (highest precision)
  let re = new RegExp(
    `\\b(\\d{1,8}\\s+[A-Za-z0-9.\\s,]+?${STREET_SUFFIX})\\b[, ]+\\s*` +
    `([A-Za-z][A-Za-z\\s]+?)\\s*,?\\s*` +
    `(?:(${STATE_NAME_RE.source})|([A-Za-z]{2}))?\\b\\s*` + // state now optional
    `(\\d{5})(?:-\\d{4})?\\b`,
    'i'
  );
  let m = txt.match(re);
  if (m) {
    const stateToken = m[3] || m[4];
    const state = normState(stateToken) || null;
    return {
      line1: m[1].replace(/,\s*/g, ' ').replace(/\s{2,}/g, ' ').trim(),
      city: m[2].trim(),
      state,
      zip: m[5]
    };
  }

  // Fallback: **no street-suffix requirement**
  re = new RegExp(
    `\\b(\\d{1,8}\\s+[A-Za-z0-9.\\s,]+?)\\b[, ]+\\s*` +
    `([A-Za-z][A-Za-z\\s]+?)\\s*,?\\s*` +
    `(?:(${STATE_NAME_RE.source})|([A-Za-z]{2}))?\\b\\s*` +
    `(\\d{5})(?:-\\d{4})?\\b`,
    'i'
  );
  m = txt.match(re);
  if (m) {
    const stateToken = m[3] || m[4];
    const state = normState(stateToken) || null;
    return {
      line1: m[1].replace(/,\s*/g, ' ').replace(/\s{2,}/g, ' ').trim(),
      city: m[2].trim(),
      state,
      zip: m[5]
    };
  }

  // Last resort: parse parts separately
  const line1 = parseAddressLine1(txt);
  const csz = parseCityStateZip(txt);
  if (line1 && csz) return { line1: line1.replace(/,\s*/g, ' ').trim(), ...csz };
  return null;
}

function parseAddressLine1(text) {
  const txt = cleanAddressText(text);
  const m = (txt || '').match(new RegExp(`\\b(\\d{1,8}\\s+[A-Za-z0-9.\\s,]+?${STREET_SUFFIX})\\b`, 'i'));
  return m ? m[1].replace(/,\s*/g, ' ').replace(/\s{2,}/g, ' ').trim() : null;
}
function parseCityStateZip(text = '') {
  const txt = cleanAddressText(text);
  const m = (txt || '').match(
    new RegExp(
      `\\b([A-Za-z][A-Za-z\\s]+?),?\\s*(?:(${STATE_NAME_RE.source})|([A-Za-z]{2}))?\\s+(\\d{5})(?:-\\d{4})?\\b`,
      'i'
    )
  );
  if (!m) return null;
  const city = m[1].trim();
  const stateToken = m[2] || m[3];
  const state = normState(stateToken) || null;
  const zip = m[4];
  return { city, state, zip };
}

// ---------- Phone parsing & accumulation ----------
function normalizeDigitWords(s = '') {
  // Convert spoken numbers (“seven”, “oh”) into digits so we can parse phones reliably.
  return (s || '')
    .replace(/\b(oh|o)\b/gi, '0')
    .replace(/\bzero\b/gi, '0')
    .replace(/\bone\b/gi, '1')
    .replace(/\btwo\b/gi, '2')
    .replace(/\bthree\b/gi, '3')
    .replace(/\bfour\b/gi, '4')
    .replace(/\bfive\b/gi, '5')
    .replace(/\bsix\b/gi, '6')
    .replace(/\bseven\b/gi, '7')
    .replace(/\beight\b/gi, '8')
    .replace(/\bnine\b/gi, '9');
}

// Smarter parser: fixes "404-4444 2544", strips country code, formats 3-3-4.
function parsePhone(text) {
  const raw = (text || '').replace(/\D+/g, '');
  const fmt = (d10) => `${d10.slice(0,3)}-${d10.slice(3,6)}-${d10.slice(6)}`;

  if (!raw) return null;

  let digits = raw;
  // Drop leading US country code if present
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);

  if (digits.length === 10) {
    return { full: fmt(digits), complete: true };
  }

  // ASR glitch fixer: 3 + 7/8 digits (e.g., "404-4444 2544" -> 404-444-2544)
  if (digits.length === 11 || digits.length === 12) {
    const area = digits.slice(0, 3);
    const local7 = digits.slice(-7);
    return { full: fmt(area + local7), complete: true };
  }

  if (digits.length > 10) {
    const last10 = digits.slice(-10);
    return { full: fmt(last10), complete: true };
  }

  // 1–9 digits → partial
  return { partial: digits, complete: false };
}

// ----------------- Natural language date/time -----------------
function nowInTZ(tz = DEFAULT_TZ) {
  // Build a Date using formatted parts in the target TZ to avoid server-local drift
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = (t) => Number(fmt.find(p => p.type === t)?.value || 0);
  // Months are 1-based in parts
  return new Date(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
}
const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
function nextWeekdayDate(base, targetName) {
  const name = targetName.toLowerCase();
  const target = WEEKDAYS.indexOf(name);
  if (target < 0) return null;
  const d = new Date(base.getTime());
  const diff = (target - d.getDay() + 7) % 7 || 7; // always future date
  d.setDate(d.getDate() + diff);
  return d;
}
function two(n){ return String(n).padStart(2,'0'); }

// Hardened parser; requires scheduling intent for time-only phrases.
function parseNaturalDateTime(text, tz = DEFAULT_TZ) {
  const t = (text || '').toLowerCase();

  // Require scheduling intent before inferring a date from a time/window
  const schedulingIntentRe = /\b(schedule|scheduling|book|booking|calendar|appointment|appt|visit|tomorrow|today|this (?:morning|afternoon|evening|week)|next (?:sun|mon|tue|wed|thu|fri|sat)|on (?:sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/;
  const hasSchedulingIntent = schedulingIntentRe.test(t);

  const base = nowInTZ(tz);
  let date = null;
  let time = null;
  let inferredWindow = null;

  // date: "tomorrow"
  if (/\btomorrow\b/.test(t)) {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() + 1);
    date = d;
  }

  // date: weekday ("friday", "next tuesday")
  const wd = t.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (wd) {
    const target = wd[2];
    const d = nextWeekdayDate(base, target);
    if (d) date = d;
  }

  // time phrases with clear signals ONLY
  // Accept: "at 2", "at 2 pm", "at 2:30pm", "2:30", "14:15", "2 pm", "11am"
  let m = t.match(/\bat\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!m) m = t.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) m = t.match(/\b(\d{1,2})\s*(am|pm)\b/);

  if (m) {
    if (m[3] || m[2] !== undefined) {
      // has am/pm OR minutes (colon time)
      let hh = Number(m[1]);
      let mm = Number(m[2] || 0);
      const ap = (m[3] || '').toLowerCase();
      if (ap === 'pm' && hh < 12) hh += 12;
      if (ap === 'am' && hh === 12) hh = 0;
      if (!ap && hh === 24) hh = 0;
      if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) time = { hh, mm };
    } else if (m.index === 0 || /\bat\s*$/.test(t.slice(0, m.index + 1))) {
      // bare "at 2" without am/pm → accept as 02:00
      let hh = Number(m[1]);
      if (hh >= 0 && hh <= 23) time = { hh, mm: 0 };
    }
  }

  // window words
  const win = inferPreferredWindowFrom(t);
  if (win) inferredWindow = win;

  // Only infer a date when intent is clearly about scheduling
  if (!date && (time || inferredWindow) && hasSchedulingIntent) {
    const maybe = new Date(base.getTime());
    if (time) { maybe.setHours(time.hh, time.mm, 0, 0); }
    else if (inferredWindow === 'morning') { maybe.setHours(9, 0, 0, 0); }
    else if (inferredWindow === 'afternoon') { maybe.setHours(13, 0, 0, 0); }
    date = (maybe > base) ? maybe : new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  }

  if (!date && !time && !inferredWindow) return null;

  const y = date ? date.getFullYear() : base.getFullYear();
  const mth = date ? date.getMonth() + 1 : base.getMonth() + 1;
  const d = date ? date.getDate() : base.getDate();
  const dateISO = `${y}-${two(mth)}-${two(d)}`;
  const timeHHMM = time ? `${two(time.hh)}:${two(time.mm)}` : null;

  return { dateISO, timeHHMM, inferredWindow };
}

// --- Simple validators + normalizers
function isISODate(d) { return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d); }
function isHHMM(t)    { return typeof t === 'string' && /^\d{2}:\d{2}$/.test(t); }

// "2 pm" | "2:30pm" | "14:15" | "noon" -> "HH:MM" or null
function normalizeTimeToHHMM(text, tz = DEFAULT_TZ) {
  if (!text) return null;
  const t = String(text).trim().toLowerCase();
  if (t === 'noon') return '12:00';
  if (t === 'midnight') return '00:00';
  let m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hh = Number(m[1]);
  let mm = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
    const two2 = (n)=>String(n).padStart(2,'0');
    return `${two2(hh)}:${two2(mm)}`;
  }
  return null;
}

// Force slots.preferred_date to YYYY-MM-DD and preferred_time to HH:MM when possible.
function normalizeDateTimeInSlots(slots, tz = DEFAULT_TZ) {
  const s = { ...(slots || {}) };

  // Preferred date
  if (!isISODate(s.preferred_date) && typeof s.preferred_date === 'string') {
    const parsed = parseNaturalDateTime(s.preferred_date, tz);
    if (parsed?.dateISO) s.preferred_date = parsed.dateISO;
  }
  if (!isISODate(s.preferred_date)) {
    const joined = [s.preferred_date, s.preferred_window, s.preferred_time].filter(Boolean).join(' ');
    const parsed = parseNaturalDateTime(joined || '', tz);
    if (parsed?.dateISO) s.preferred_date = parsed.dateISO;
  }

  // Preferred time
  if (s.preferred_time && !isHHMM(s.preferred_time)) {
    const fixed = normalizeTimeToHHMM(s.preferred_time, tz);
    if (fixed) s.preferred_time = fixed;
    else s.preferred_time = null; // fall back to window
  }

  // Preferred window – keep only known values
  const okWin = new Set(['morning','afternoon','flexible_all_day']);
  if (s.preferred_window && !okWin.has(String(s.preferred_window).toLowerCase())) {
    const w = String(s.preferred_window).toLowerCase();
    if (/morning/.test(w)) s.preferred_window = 'morning';
    else if (/afternoon|evening/.test(w)) s.preferred_window = 'afternoon';
    else if (/flexible.*all.*day|all.*day.*flexible/.test(w)) s.preferred_window = 'flexible_all_day';
    else s.preferred_window = null;
  }

  return s;
}

// ----------------- Detectors & cleaners ----------
function detectedProblem(text = '') {
  const t = (text || '').toLowerCase();
  if (/\bno problem\b/.test(t)) return false;
  return /(no\s+(cool|cold|heat|air|airflow)|not\s+(cooling|cold|heating|working)|won'?t\s+(turn\s*on|start|cool|heat|blow)|stopp?ed\s+(working|cooling|heating)|(ac|a\.?c\.?|unit|system|hvac).*(broke|broken|out|down|leak|leaking|smell|odor|noise|noisy|rattle|buzz|ice|iced|frozen)|(problem|issue|trouble)\s+(with|in|on)\s+(my\s+)?(ac|a\.?c\.?|unit|system|hvac)|\bvery (hot|cold)\b|burning up|freezing)/i.test(t);
}
function addEmpathy(speech, reply) {
  if (detectedProblem(speech) && !/\b(sorry|apologiz)/i.test(reply)) {
    return `I’m sorry to hear that. ${reply}`;
  }
  return reply;
}

// quick yes/no helpers
function isAffirmation(text='') {
  return /\b(yes|yep|yeah|correct|that'?s (right|correct)|looks good|sounds good|ok|okay|proceed|continue|let'?s continue|go ahead|move on|that works)\b/i.test(text);
}
function isNegation(text='') {
  return /\b(no|nope|nah|know|not (right|correct)|change|fix|update|wrong)\b/i.test(text);
}

// Branding & reply guards
function wantsToContinue(text='') {
  const t = text || '';
  if (/\b(let'?s\s*(continue|keep going|proceed)|already told you|move on)\b/i.test(t)) return true;
  if (/^\s*(continue|next|skip|go ahead)\s*$/i.test(t)) return true;
  return false;
}
function enforceHVACBranding(text='') {
  if (!text) return text;
  let out = text.replace(/\bH\s*V\s*A\s*C\b/gi, 'H.V.A.C');
  out = out.replace(/\bH\.?V\.?A\.?C\.?\s+Joy\b/gi, 'H.V.A.C Joy');
  return out;
}
function stripRepeatedGreeting(history, reply) {
  const seenGreeting = (history || []).some(m => /welcome to h\.?v\.?a\.?c\.?\s+joy/i.test(m.content || ''));
  if (!seenGreeting) return reply;
  return reply.replace(/^\s*welcome to h\.?v\.?a\.?c\.?\s+joy.*?(?:\.\s*|\s*$)/i, '').trim();
}
function suppressMembershipUntilBooked(reply, slots) {
  const booked = !!(slots.preferred_date && (slots.preferred_window || slots.preferred_time));
  if (!booked && /member|maintenance program/i.test(reply)) {
    return 'Great—thanks. Let’s finish your booking first.';
  }
  return reply;
}

function nextMissingPrompt(s) {
  const addr = s.service_address || {};
  if (!s.full_name) return 'Can I have your full name, please?';
  if (!s.callback_number) return 'Thank you. What’s the full 10-digit callback number?';
  if (!(addr.line1 && addr.city && addr.zip)) {
    return 'Please say the full service address—street, city, and zip.';
  }
  // Pricing prompt REMOVED per request.
  if (!s.preferred_date) return 'What day works for your visit? The earliest availability is tomorrow.';
  if (!s.preferred_time && !s.preferred_window) {
    return 'What time window works for you—morning, afternoon, or flexible all day?';
  }
  return null;
}
function sameQuestionRepeatGuard(lastQ, newQ, speech, mergedSlots) {
  if (!lastQ || !newQ) return { newReply: null, updated: false };
  if (lastQ.trim() !== newQ.trim()) return { newReply: null, updated: false };
  const win = inferPreferredWindowFrom(speech);
  if (win && !mergedSlots.preferred_window) {
    mergedSlots.preferred_window = win;
    return {
      newReply: `Got it—we'll reserve the ${win} window. Which day works best for you?`,
      updated: true
    };
  }
  return { newReply: null, updated: false };
}

// Detect yes/no-style questions for fast handling
function isYesNoQuestion(q = '') {
  const t = (q || '').toLowerCase();
  return /\b(is (?:that|this) (?:right|correct)|does that work|would you like|can we proceed|okay to proceed|is that ok|is that okay|sound good|look good|call[- ]ahead)\b/.test(t);
}

// (kept for internal use, not spoken)
function summaryFromSlots(s) {
  const name = s.full_name || 'Unknown';
  const addr = s.service_address || {};
  const addrLine = [addr.line1, addr.city, addr.state || DEFAULT_STATE, addr.zip].filter(Boolean).join(', ');
  const units = s.unit_count != null ? `${s.unit_count}` : 'Unknown';
  const locs = s.unit_locations ? `, ${s.unit_locations}` : '';
  const brand = s.brand ? s.brand : 'Unknown';
  const thermo = s.thermostat || {};
  const sp = thermo.setpoint != null ? thermo.setpoint : 'Unknown';
  const cur = thermo.current != null ? thermo.current : 'Unknown';
  const window = s.preferred_window ? s.preferred_window : (s.preferred_date ? '' : 'unspecified');
  const date = s.preferred_date ? s.preferred_date : '';
  const callAhead = (s.call_ahead === false) ? 'No call-ahead' : (s.call_ahead === true ? 'Call-ahead' : 'Call-ahead requested');
  return `- Name: ${name}
- Address: ${addrLine}
- AC units: ${units}${locs}
- Brand: ${brand}
- Thermostat setpoint: ${sp}, current: ${cur}
- Appointment: ${date || 'scheduled'}${window ? ' (' + window + ')' : ''}
- ${callAhead}
- Diagnostic fee: $${DIAG_FEE}.`;
}

function serverSideDoneCheck(slots) {
  const s = slots || {};
  const addr = s.service_address || {};
  const dateOK = isISODate(s.preferred_date);
  const timeOK = !!s.preferred_time && isHHMM(s.preferred_time);
  const winOK  = !!s.preferred_window;
  return (
    !!s.full_name &&
    !!s.callback_number &&
    !!addr.line1 && !!addr.city && !!addr.zip && // state auto-filled if missing
    // pricing_disclosed no longer required
    dateOK &&
    (timeOK || winOK)
  );
}

// --- Map preferred window to start/end times for calendar ---
function windowToTimes(dateISO, window, tz) {
  const d = (dateISO || '').slice(0, 10); // YYYY-MM-DD
  const start = window === 'afternoon' ? `${d}T13:00:00` : `${d}T09:00:00`;
  const end   = window === 'afternoon' ? `${d}T14:00:00` : `${d}T10:00:00`;
  const timeZone = tz || process.env.DEFAULT_TZ || 'America/New_York';
  return {
    start: { dateTime: start, timeZone },
    end:   { dateTime: end,   timeZone },
  };
}

function timeToTimes(dateISO, timeHHMM, tz) {
  const d = (dateISO || '').slice(0, 10);
  const start = `${d}T${timeHHMM || '09:00'}:00`;
  // default 60-minute slot
  const [hh, mm] = (timeHHMM || '09:00').split(':').map(Number);
  const endH = String((hh + 1) % 24).padStart(2, '0');
  const end = `${d}T${endH}:${String(mm).padStart(2,'0')}:00`;
  const timeZone = tz || process.env.DEFAULT_TZ || 'America/New_York';
  return {
    start: { dateTime: start, timeZone },
    end:   { dateTime: end,   timeZone },
  };
}

// --- Pretty, human-friendly date/time for confirmations — TZ-safe
function formatPretty(dateISO, timeHHMM, tz = DEFAULT_TZ) {
  if (!dateISO) return '';

  const [y, m, d] = dateISO.split('-').map(Number);

  // Anchor at noon UTC so the *date* renders correctly in the target TZ
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

  const weekday  = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(anchor);
  const monthDay = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long', day: 'numeric' }).format(anchor);

  let timePart = null;
  if (timeHHMM) {
    const [hh, mm] = timeHHMM.split(':').map(Number);
    const h12 = ((hh % 12) || 12);
    const ampm = hh < 12 ? 'AM' : 'PM';
    timePart = `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
  }

  return timePart ? `${weekday}, ${monthDay} at ${timePart}` : `${weekday}, ${monthDay}`;
}

// ---- Address progress: accept street + city + zip; auto-fill state
function handleAddressProgress_STRICT(speech, slots) {
  const s = { ...(slots || {}) };
  const addr = s.service_address || {};

  // Consider address "good enough" with line1 + city + zip; state will be auto-filled
  const haveEnough = addr.line1 && addr.city && addr.zip;
  if (haveEnough) {
    if (!addr.state) {
      s.service_address = { ...addr, state: DEFAULT_STATE };
    }
    return { slots: s, reply: null, handled: false };
  }

  // Try to parse a full address (street, city, [state], zip)
  const full = parseFullAddress(speech);
  if (full) {
    if (!full.state) full.state = DEFAULT_STATE;
    s.service_address = { ...(s.service_address || {}), ...full };
    s.address_confirm_pending = true;
    const a = s.service_address;
    return {
      slots: s,
      reply: `Thank you. I have ${a.line1}, ${a.city}, ${a.state} ${a.zip}. Is that correct?`,
      handled: true
    };
  }

  // Minimal parse: street + city + zip (state missing)
  const line1 = parseAddressLine1(speech);
  const csz = parseCityStateZip(speech);
  const cityZip = (() => {
    if (csz && csz.city && csz.zip) return { city: csz.city, zip: csz.zip, state: csz.state || null };
    const m = (speech || '').match(/\b([A-Za-z][A-Za-z\s]+?)\s+(\d{5})(?:-\d{4})?\b/);
    return m ? { city: m[1].trim(), zip: m[2], state: null } : null;
  })();

  if (line1 && cityZip) {
    s.service_address = {
      ...(s.service_address || {}),
      line1,
      city: cityZip.city,
      zip: cityZip.zip,
      state: cityZip.state || DEFAULT_STATE
    };
    s.address_confirm_pending = true;
    const a = s.service_address;
    return {
      slots: s,
      reply: `Thank you. I have ${a.line1}, ${a.city}, ${a.state} ${a.zip}. Is that correct?`,
      handled: true
    };
  }

  // Ask again, with simplified wording (no example)
  return {
    slots: s,
    reply: 'Please say the full service address—street, city, and zip.',
    handled: true
  };
}

// ---- Phone progress: accumulate digits across turns & confirm when complete
function handlePhoneProgress(speech, slots) {
  const s = { ...(slots || {}) };
  if (s.callback_number) return { slots: s, reply: null, handled: false };

  // Accept spoken numbers like "seven one two..."
  const heardDigits = normalizeDigitWords(speech || '').replace(/\D+/g, '');
  const existing = (s._phone_partial || '').replace(/\D+/g, '');

  // If nothing number-like has been said yet, bail out.
  if (!heardDigits && !existing) {
    return { slots: s, reply: null, handled: false };
  }

  const combined = (existing + heardDigits).slice(0, 16); // safety cap
  const parsed = parsePhone(combined);

  if (parsed && parsed.complete) {
    s.callback_number = parsed.full;
    s.callback_confirm_pending = true;
    s._phone_partial = '';
    return {
      slots: s,
      reply: `Thanks. I have your callback number as ${parsed.full}. Is that correct?`,
      handled: true
    };
  }

  // Still incomplete—stash what we have and ask for the rest
  if (combined.length > 0) {
    s._phone_partial = combined;
    const remaining = Math.max(10 - combined.length, 1);
    return {
      slots: s,
      reply: `I heard the beginning. Please say the remaining ${remaining} digit${remaining > 1 ? 's' : ''} of the 10-digit number.`,
      handled: true
    };
  }

  return { slots: s, reply: null, handled: false };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { speech = '', caller = '', callSid = '', lastSlots = {}, lastQuestion = '' } = req.body || {};
    if (!speech) return res.status(400).json({ error: 'Missing "speech" in body' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY is not set' });

    const history = await fetchHistoryMessages(callSid);

    // Decorate any reply with empathy (when user reports a problem) + branding
    const E = (r) => enforceHVACBranding(addEmpathy(speech, r));

    // Merge slots upfront
    let mergedSlots = { ...(lastSlots || {}) };
    if (mergedSlots.confirmation_pending !== true) mergedSlots.confirmation_pending = false;
    if (!mergedSlots.summary_reads) mergedSlots.summary_reads = 0;

    // --- EMERGENCY FAST-PATH ---
    if (/\b(smoke|sparks?|gas (smell|leak)|carbon monoxide|fire|danger|burning smell|smoke)\b/i.test(speech || '')) {
      return res.status(200).json({
        reply: E("If you suspect a safety issue, please hang up and call 911 now. I’ll also alert our dispatcher immediately. Are you safe to continue?"),
        slots: mergedSlots,
        done: false,
        goodbye: null,
        needs_confirmation: true,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    // --- FINAL CONFIRMATION GATE ---
    if (mergedSlots.confirmation_pending === true) {
      if (isAffirmation(speech) && !isNegation(speech)) {
        mergedSlots.confirmation_pending = false;
        const bye = "You’re set. We’ll call ahead before arriving. A member of our team will contact you to confirm the appointment. Thank you for calling Smith Heating & Air. Good Bye.";
        return res.status(200).json({
          reply: E(""),
          slots: mergedSlots,
          done: true,
          goodbye: bye,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }

      if (isNegation(speech) || /\b(change|update|fix|wrong|not (right|correct))\b/i.test(speech)) {
        mergedSlots.confirmation_pending = false;
        return res.status(200).json({
          reply: E("No problem—what would you like to change?"),
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }

      return res.status(200).json({
        reply: E("If everything is correct, please say “yes.” Otherwise, tell me what to change."),
        slots: mergedSlots,
        done: false,
        goodbye: null,
        needs_confirmation: true,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    // --- ADDRESS CONFIRMATION GATE ---
    if (mergedSlots.address_confirm_pending === true) {
      const addr = mergedSlots.service_address || {};
      if (isAffirmation(speech) && !isNegation(speech)) {
        mergedSlots.address_confirm_pending = false;
        const prompt = nextMissingPrompt(mergedSlots) || 'Great—thanks. What day works for your visit? The earliest is tomorrow.';
        return res.status(200).json({
          reply: E(prompt),
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }
      if (isNegation(speech)) {
        mergedSlots.address_confirm_pending = false;
        mergedSlots.service_address = { line1: null, line2: null, city: null, state: null, zip: null };
        return res.status(200).json({
          reply: E('Sorry about that—what is the correct full address? Please say it in one sentence: street, city, and zip.'),
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }
      return res.status(200).json({
        reply: E(`Is this address correct: ${[addr.line1, addr.city, (addr.state || DEFAULT_STATE), addr.zip].filter(Boolean).join(', ')}? Please say yes or no.`),
        slots: mergedSlots,
        done: false,
        goodbye: null,
        needs_confirmation: false,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    // --- CALLBACK NUMBER CONFIRMATION GATE ---
    if (mergedSlots.callback_confirm_pending === true) {
      const n = mergedSlots.callback_number || '';
      if (!n) {
        mergedSlots.callback_confirm_pending = false;
        return res.status(200).json({
          reply: E('What’s the full 10-digit callback number?'),
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }

      if (isAffirmation(speech) && !isNegation(speech)) {
        mergedSlots.callback_confirm_pending = false;
        const prompt = nextMissingPrompt(mergedSlots) || 'Great—thanks. What day works for your visit? The earliest is tomorrow.';
        return res.status(200).json({
          reply: E(prompt),
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }
      if (isNegation(speech)) {
        mergedSlots.callback_confirm_pending = false;
        mergedSlots.callback_number = null;
        return res.status(200).json({
          reply: E('No problem—what’s the full 10-digit callback number?'),
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }
      return res.status(200).json({
        reply: E(`I have ${n} as your callback number. Is that correct? Please say yes or no.`),
        slots: mergedSlots,
        done: false,
        goodbye: null,
        needs_confirmation: false,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    // ---- Strict address capture (street+city+zip accepted; state auto-fill)
    const addrProgress = handleAddressProgress_STRICT(speech, mergedSlots);
    if (addrProgress.handled) {
      mergedSlots = addrProgress.slots;
      return res.status(200).json({
        reply: E(addrProgress.reply),
        slots: mergedSlots,
        done: false,
        goodbye: null,
        needs_confirmation: false,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    // ---- Phone progress (accumulate & format)
    const phoneProgress = handlePhoneProgress(speech, mergedSlots);
    if (phoneProgress.handled) {
      mergedSlots = phoneProgress.slots;
      return res.status(200).json({
        reply: E(phoneProgress.reply),
        slots: mergedSlots,
        done: false,
        goodbye: null,
        needs_confirmation: false,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    // ---- Natural-language date/time capture
    const parsedDT = parseNaturalDateTime(speech, DEFAULT_TZ);
    if (parsedDT) {
      if (!mergedSlots.preferred_date) mergedSlots.preferred_date = parsedDT.dateISO;
      if (parsedDT.timeHHMM && !mergedSlots.preferred_time) mergedSlots.preferred_time = parsedDT.timeHHMM;
      if (parsedDT.inferredWindow && !mergedSlots.preferred_window && !mergedSlots.preferred_time) {
        mergedSlots.preferred_window = parsedDT.inferredWindow;
      }
    }
    mergedSlots = normalizeDateTimeInSlots(mergedSlots, DEFAULT_TZ);

    // ---- Continue / move on → next missing
    if (!mergedSlots.confirmation_pending && !mergedSlots.address_confirm_pending && !mergedSlots.callback_confirm_pending && wantsToContinue(speech)) {
      const prompt = nextMissingPrompt(mergedSlots) || 'Great—thanks. What day works for your visit? The earliest is tomorrow.';
      return res.status(200).json({
        reply: E(prompt),
        slots: mergedSlots,
        done: false,
        goodbye: null,
        needs_confirmation: false,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    // NEW: “No” to a yes/no question → repeat the same question (do not advance)
    const priorLastQuestion = getLastAssistantQuestion(history) || '';
    const lastQ = lastQuestion || priorLastQuestion;
    if (!mergedSlots.confirmation_pending && !mergedSlots.address_confirm_pending && !mergedSlots.callback_confirm_pending) {
      if (isNegation(speech) && isYesNoQuestion(lastQ)) {
        return res.status(200).json({
          reply: E(`No problem—let’s try that again. ${lastQ}`),
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }
      if (isAffirmation(speech) && isYesNoQuestion(lastQ)) {
        if (/call[- ]ahead/i.test(lastQ)) mergedSlots.call_ahead = true;

        const prompt = nextMissingPrompt(mergedSlots) || 'Great—thanks. What day works for your visit? The earliest is tomorrow.';
        return res.status(200).json({
          reply: E(prompt),
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }
    }

    // ---- Normal LLM step ---------------------------------------------------
    const steering =
      'Continue the call. Do not repeat the greeting.' +
      '\nAsk for the FULL service address (street, city, and zip) in one question; if the caller gives only street, ask specifically for the city/zip.' +
      '\nRequire a date for booking. Ask for date first, then time window. If the caller provides a specific time, accept it instead of a window.' +
      '\nDo not proactively quote prices.' +
      '\nIf the caller’s reply does NOT answer your last question, politely re-ask the same question and continue.' +
      '\nIf the caller says we already discussed something, skip repeating it and continue forward.' +
      (lastQ ? `\nLast question you asked was:\n"${lastQ}"` : '') +
      '\nKnown slots (do not re-ask if non-null):\n' +
      JSON.stringify(mergedSlots || {}, null, 2);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'assistant', content: steering },
      { role: 'user', content: speech }
    ];

    const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || '15000', 10);
    const t = withTimeout(OPENAI_TIMEOUT_MS);

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages,
      }),
      signal: t.signal,
    }).catch(e => { throw e; }).finally(() => t.cancel());

    if (!resp?.ok) {
      const text = await resp?.text();
      console.error('OpenAI error', text);
      return res.status(200).json({
        reply: E('Thanks. Please say the full service address—street, city, and zip.'),
        slots: mergedSlots,
        done: false,
        goodbye: null,
        needs_confirmation: false,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content ?? '{}';

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      parsed = {
        reply: 'Thanks. What’s the next detail—your full service address: street, city, and zip?',
        slots: {},
        done: false,
        goodbye: null,
        needs_confirmation: false,
      };
    }

    if (typeof parsed.reply !== 'string') {
      parsed.reply = 'Thanks. What’s the next detail—your full service address: street, city, and zip?';
    }
    if (!parsed.slots || typeof parsed.slots !== 'object') parsed.slots = {};

    // merge with old slots
    mergedSlots = mergeSlots(mergedSlots, parsed.slots);

    // normalize date/time fields so downstream code gets ISO + HH:MM
    mergedSlots = normalizeDateTimeInSlots(mergedSlots, DEFAULT_TZ);

    // sanitize: never allow confirm gate without a number
    if (mergedSlots.callback_confirm_pending && !mergedSlots.callback_number) {
      mergedSlots.callback_confirm_pending = false;
    }

    // heuristics
    if (!mergedSlots.preferred_window && !mergedSlots.preferred_time) {
      const win = inferPreferredWindowFrom(speech);
      if (win) mergedSlots.preferred_window = win;
    }

    // “schedule” but missing required → push next missing prompt
    if (/schedule|book|calendar/i.test(parsed.reply) && !serverSideDoneCheck(mergedSlots)) {
      const prompt = nextMissingPrompt(mergedSlots);
      if (prompt) parsed.reply = prompt;
    }

    // “It’s my pleasure” micro-hook (once)
    const saidThanks = /\b(thanks|thank you|appreciate it)\b/i.test(speech || '');
    if (saidThanks && !mergedSlots._pleasure_ack && !/\bit'?s my pleasure\b/i.test(parsed.reply)) {
      parsed.reply = `${parsed.reply} It’s my pleasure.`;
      mergedSlots._pleasure_ack = true;
    }

    // Final cleanups
    parsed.reply = suppressMembershipUntilBooked(parsed.reply, mergedSlots);
    parsed.reply = addEmpathy(speech, parsed.reply);
    parsed.reply = stripRepeatedGreeting(history, parsed.reply);
    parsed.reply = enforceHVACBranding(parsed.reply);

    // done?
    const serverDone = serverSideDoneCheck(mergedSlots);

    if (serverDone) {
      // Create the calendar event before ending the call
      try {
        const s = mergedSlots || {};
        const addr = s.service_address || {};
        const title = `HVAC Joy – ${s.full_name || 'Service Call'}`;
        const location = [addr.line1, addr.city, (addr.state || DEFAULT_STATE), addr.zip].filter(Boolean).join(', ');

        const description = [
          `Callback: ${s.callback_number || 'N/A'}`,
          s.unit_count != null ? `Units: ${s.unit_count}` : null,
          s.unit_locations ? `Locations: ${s.unit_locations}` : null,
          s.brand ? `Brand: ${s.brand}` : null,
          (s.thermostat && s.thermostat.setpoint != null && s.thermostat.current != null)
            ? `Thermostat: set ${s.thermostat.setpoint}, current ${s.thermostat.current}` : null,
          Array.isArray(s.symptoms) && s.symptoms.length ? `Symptoms: ${s.symptoms.join(', ')}` : null,
          s.call_ahead === false ? 'Call-ahead: NO' : 'Call-ahead: YES',
        ].filter(Boolean).join('\n');

        // Defensive normalization
        const sNorm = normalizeDateTimeInSlots(s, DEFAULT_TZ);
        const safeDateISO = isISODate(sNorm.preferred_date) ? sNorm.preferred_date : null;
        const safeTimeHHMM = isHHMM(sNorm.preferred_time) ? sNorm.preferred_time : null;

        let startEnd;
        if (safeTimeHHMM) {
          startEnd = timeToTimes(safeDateISO, safeTimeHHMM, DEFAULT_TZ);
        } else {
          startEnd = windowToTimes(safeDateISO, sNorm.preferred_window, DEFAULT_TZ);
        }

        await insertCalendarEvent(process.env.GOOGLE_CALENDAR_ID, {
          summary: title,
          location,
          description,
          start: startEnd.start,
          end: startEnd.end,
          reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
        });
      } catch (e) {
        console.error('Calendar insert failed:', e?.response?.data || e);
      }

      // Close cleanly
      const s = mergedSlots || {};
      const sNorm = normalizeDateTimeInSlots(s, DEFAULT_TZ);
      const safeDateISO = isISODate(sNorm.preferred_date) ? sNorm.preferred_date : null;
      const safeTimeHHMM = isHHMM(sNorm.preferred_time) ? sNorm.preferred_time : null;

      const pretty = safeDateISO ? formatPretty(safeDateISO, safeTimeHHMM || null, DEFAULT_TZ) : null;
      const windowNote = (!safeTimeHHMM && sNorm.preferred_window) ? ` in the ${sNorm.preferred_window} window` : '';
      const whenLine = pretty ? `You’re scheduled for ${pretty}${windowNote}.` : 'Your appointment is scheduled.';
      const callAheadBit = (sNorm.call_ahead === false)
        ? ' We will arrive within your window without a call-ahead.'
        : ' We’ll call ahead before arriving.';
      const goodbyeLine = `${whenLine}${callAheadBit} A member of our team will contact you to confirm the appointment. Thank you for calling Smith Heating & Air. Good Bye.`;

      return res.status(200).json({
        reply: E(""),
        slots: mergedSlots,
        done: true,
        goodbye: goodbyeLine,
        needs_confirmation: false,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    return res.status(200).json({
      reply: parsed.reply,
      slots: mergedSlots,
      done: false,
      goodbye: null,
      needs_confirmation: false,
      model: 'gpt-4o-mini',
      usage: null,
    });
  } catch (err) {
    console.error('chat handler error', err);
    return res.status(200).json({
      reply: enforceHVACBranding("I caught that. When you’re ready, please say the full service address—street, city, and zip."),
      slots: (req.body && req.body.lastSlots) || {},
      done: false,
      goodbye: null,
      needs_confirmation: false,
      error: 'Server error',
      detail: err?.message ?? String(err),
    });
  }
}
