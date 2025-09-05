/* eslint-disable */
// pages/api/chat.js
import { getSupabaseAdmin } from '../../lib/supabase-admin';

const SYSTEM_PROMPT = `
You are “Joy,” the inbound phone agent for a residential H.V.A.C company.
Primary goal: warmly book service, set expectations, and capture complete job details. Do not diagnose.

Voice & Style
- Warm, professional, concise. Short sentences (<= 14 words).
- When a caller reports a problem or discomfort, briefly acknowledge and comfort.
- Confirm important items briefly after capturing them.
- Avoid meta talk (“we already did this”). Be forward-looking and helpful.

Safety & Guardrails
- Only give these prices:
  - Diagnostic visit: $50 per non-working unit.
  - Maintenance visit: $50 for non-members.
- Never promise exact arrival times. Offer a window and a call-ahead.
- If smoke, sparks, gas smell, or health risk: advise 911 and escalate.
- Ask permission before any hold.

Call Flow
1) Greeting (only once per call).
2) Capture + confirm:
   - Full name
   - **Full service address** (single question: street, city, state, zip). Then reflect it back for yes/no confirmation.
   - Best callback number
3) Problem discovery:
   - Unit count and locations
   - Brand (if known)
   - Symptoms (no cool/heat, airflow, icing, noises, ants/pests)
   - Thermostat setpoint and current reading
4) Pricing disclosure before scheduling.
5) Scheduling:
   - Offer earliest availability, **ask for a date**, then arrival window + call-ahead.
6) Membership check (after booking).
7) Confirm & summarize.
8) Close politely.

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
  "preferred_date": null | "<ISO or natural language>",
  "preferred_window": null | "morning" | "afternoon" | "flexible_all_day" | "<time window>",
  "call_ahead": null | true | false,
  "hazards_pets_ants_notes": null | "<string>",
  "pricing_disclosed": true | false,
  "emergency": false | true,

  "pending_fix": null | { "field": "<path>", "prompt": "<follow-up question>" },
  "confirmation_pending": null | true | false,
  "summary_reads": null | <number>,
  "address_confirm_pending": null | true | false,
  "callback_confirm_pending": null | true | false
}

Behavior
- Continue the call. Do not repeat the greeting (“Welcome to H.V.A.C Joy…”).
- Do NOT ask again for any slot already non-null in "known slots".
- Ask for the **full address** in one question; if the caller gives only street (no city/state/zip), ask specifically for the missing parts — do not claim the address is “updated.”
- Require a date for booking (not only a window). Ask for date first, then window.
- If the caller corrects a prior detail, acknowledge, update, and confirm the new value.
- When done is reached, read a short summary **once**, then ask “Is everything correct?”
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
  return null;
}
function statementMentionsPricing(text) {
  const t = (text || '').toLowerCase();
  return /\bdiagnostic\b/.test(t) && /(?:\$|usd\s*)?50\b/.test(t);
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

// ----------------- Parsing helpers ------------------
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

// Normalize punctuation for address parsing (handles "2478. Kaley walk. …")
function cleanAddressText(line = '') {
  return line
    .replace(/(\d)\.(?=\s|$)/g, '$1')
    .replace(/\s*\.\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
const STREET_SUFFIX =
  '(?:Street|St|Drive|Dr|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Court|Ct|Way|Walk|Trail|Trl|Circle|Cir|Parkway|Pkwy|Place|Pl|Terrace|Ter|Trace|Pass|Path|Point|Pt|Loop|Run|Highway|Hwy|Cove|Cv)';

function parseFullAddress(line) {
  const txt = cleanAddressText(line);

  // City non-greedy, word boundary before ZIP, then fallback path
  const re = new RegExp(
    `\\b(\\d{2,8}\\s+[A-Za-z0-9.\\s,]+?${STREET_SUFFIX})\\b[, ]+\\s*` +
    `([A-Za-z][A-Za-z\\s]+?)\\s*,?\\s*` +                    // city (non-greedy)
    `(?:(${STATE_NAME_RE.source})|([A-Za-z]{2}))\\b\\s+` +   // state (full or 2-letter)
    `(\\d{5})(?:-\\d{4})?\\b`,
    'i'
  );

  let m = txt.match(re);
  if (m) {
    const stateToken = m[3] || m[4];
    const state = normState(stateToken);
    if (!state) return null;
    return {
      line1: m[1].replace(/\s+,/g, ' ').replace(/\s{2,}/g, ' ').trim(),
      city: m[2].trim(),
      state,
      zip: m[5]
    };
  }

  // Fallback: combine line1 + city/state/zip parsed separately
  const line1 = parseAddressLine1(txt);
  const csz = parseCityStateZip(txt);
  if (line1 && csz) return { line1, ...csz };
  return null;
}

function parseAddressLine1(text) {
  const txt = cleanAddressText(text);
  const m = (txt || '').match(new RegExp(`\\b(\\d{2,8}\\s+[A-Za-z0-9.\\s,]+?${STREET_SUFFIX})\\b`, 'i'));
  return m ? m[1].replace(/\s+,/g, ' ').replace(/\s{2,}/g, ' ').trim() : null;
}
function parseCityStateZip(text = '') {
  const txt = cleanAddressText(text);
  const m = (txt || '').match(
    new RegExp(
      `\\b([A-Za-z][A-Za-z\\s]+?),?\\s*(?:(${STATE_NAME_RE.source})|([A-Za-z]{2}))\\s+(\\d{5})(?:-\\d{4})?\\b`,
      'i'
    )
  );
  if (!m) return null;
  const city = m[1].trim();
  const stateToken = m[2] || m[3];
  const state = normState(stateToken);
  if (!state) return null;
  const zip = m[4];
  return { city, state, zip };
}
function parseThermostatSetpoint(text) {
  const t = (text || '').toLowerCase();
  const twoNums = t.match(/\b(\d{1,3})\b.*\bnot\b.*\b(\d{1,3})\b/) || t.match(/\bnot\b.*\b(\d{1,3})\b.*\b(\d{1,3})\b/);
  if (twoNums) {
    const a = parseInt(twoNums[1], 10);
    const b = parseInt(twoNums[2], 10);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return Math.max(a, b);
  }
  const direct = t.match(/\b(set\s*point|setpoint|thermostat)\b.*\b(is|at)\b[^0-9]*?(\d{1,3})\b/);
  if (direct) {
    const val = parseInt(direct[3], 10);
    if (!Number.isNaN(val)) return val;
  }
  return null;
}
function parseThermostatCurrent(text) {
  const m = (text || '').match(/\b(?:current|now|reading)\b[^0-9]*?(\d{1,3})\b/i);
  return m ? parseInt(m[1], 10) : null;
}
function parsePhone(text) {
  const digits = (text || '').replace(/\D+/g, '');
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    return { full: `${last10.slice(0,3)}-${last10.slice(3,6)}-${last10.slice(6)}`, complete: true };
  }
  if (digits.length >= 6) return { partial: digits, complete: false };
  return null;
}
function parseUnitCount(text) {
  const m = (text || '').match(/\b(\d+)\s*(?:unit|units|ac|systems?)\b/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

// ----------------- Steer/clean replies ------------------
function wantsToContinue(text='') {
  return /\b(let'?s\s*(continue|keep going|proceed)|already told you|move on)\b/i.test(text || '');
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
  const booked = !!(slots.preferred_window && slots.preferred_date);
  if (!booked && /member|maintenance program/i.test(reply)) {
    return 'Great—thanks. Let’s finish your booking first.';
  }
  return reply;
}
function nextMissingPrompt(s) {
  const addr = s.service_address || {};
  if (!s.full_name) return 'Can I have your full name?';
  if (!s.callback_number) return 'Great. What’s the best callback number?';
  if (!(addr.line1 && addr.city && addr.state && addr.zip)) {
    return 'Please say the full service address in one sentence, including street, city, state, and zip.';
  }
  if (s.unit_count == null) return 'How many AC units do you have, and where are they located?';
  if (!((s.thermostat||{}).setpoint != null && (s.thermostat||{}).current != null)) {
    return 'What is the thermostat setpoint and the current reading?';
  }
  if (s.pricing_disclosed !== true) return 'Our diagnostic visit is $50 per non-working unit. Shall we proceed?';
  if (!s.preferred_date) return 'What day works for your visit? The earliest availability is tomorrow.';
  if (!s.preferred_window) return 'What time window works for you—morning or afternoon?';
  return null;
}

// ---- Repeat guard for time window question
function sameQuestionRepeatGuard(lastQ, newQ, speech, mergedSlots) {
  if (!lastQ || !newQ) return { newReply: null, updated: false };
  if (lastQ.trim() !== newQ.trim()) return { newReply: null, updated: false };
  const win = inferPreferredWindowFrom(speech);
  if (win && !mergedSlots.preferred_window) {
    mergedSlots.preferred_window = win;
    return {
      newReply: `Got it — we'll reserve the ${win} window. Which day works best for you?`,
      updated: true
    };
  }
  return { newReply: null, updated: false };
}

// Suppress pricing repeats after it’s been disclosed
function suppressPricingIfAlreadyDisclosed(reply, mergedSlots) {
  if (mergedSlots.pricing_disclosed === true && /diagnostic/i.test(reply) && /\$?50\b/.test(reply)) {
    return 'Great—thanks for confirming. Let’s get your visit on the calendar.';
  }
  return reply;
}

// Empathy: broader trigger + require explicit "sorry/apologize"
function addEmpathy(speech, reply) {
  const t = (speech || '').toLowerCase();
  const problem =
    /\b(no (cool|cold|heat)|not (cooling|cold|working)|blowing (hot|warm)|very hot|unit.*(down|out)|ac (is )?(out|down|broke|broken|busted)|system (is )?(out|down|broken|broke))\b/.test(t);
  if (problem && !/\b(sorry|apologiz)/i.test(reply)) {
    return `I’m sorry to hear that. ${reply}`;
  }
  return reply;
}

// quick yes/no helpers
function isAffirmation(text='') {
  return /\b(yes|yep|yeah|correct|that'?s (right|correct)|looks good|sounds good|ok|okay|proceed|continue|let'?s continue|go ahead|move on|that works)\b/i.test(text);
}
function isNegation(text='') {
  return /\b(no|nope|nah|not (right|correct)|change|fix|update|wrong)\b/i.test(text);
}

// Summary helper
function summaryFromSlots(s) {
  const name = s.full_name || 'Unknown';
  const addr = s.service_address || {};
  const addrLine = [addr.line1, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
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
- Appointment: ${date || 'scheduled'}${window ? ` (${window})` : ''}
- ${callAhead}
- Diagnostic fee: $50.`;
}

// REQUIRE both date and window now
function serverSideDoneCheck(slots) {
  const s = slots || {};
  const addr = s.service_address || {};
  return (
    !!s.full_name &&
    !!s.callback_number &&
    !!addr.line1 && !!addr.city && !!addr.state && !!addr.zip &&
    s.pricing_disclosed === true &&
    !!s.preferred_date &&
    !!s.preferred_window
  );
}

// ---- Address progress: accept ONLY a complete, one-line address
function handleAddressProgress_STRICT(speech, slots) {
  const s = { ...(slots || {}) };

  const haveAll =
    s.service_address &&
    s.service_address.line1 &&
    s.service_address.city &&
    s.service_address.state &&
    s.service_address.zip;
  if (haveAll) return { slots: s, reply: null, handled: false };

  const full = parseFullAddress(speech);
  if (full) {
    s.service_address = { ...(s.service_address || {}), ...full };
    s.address_confirm_pending = true;
    return {
      slots: s,
      reply: `Thank you. I have ${full.line1}, ${full.city}, ${full.state} ${full.zip}. Is that correct?`,
      handled: true
    };
  }

  return {
    slots: s,
    reply: 'Please say the full service address in one sentence, including street, city, state, and zip. For example: 123 Main Street, Washington, DC 10001.',
    handled: true
  };
}

// ---- Phone progress: accept full 10; set confirm gate; reject partial unless phone was asked
function handlePhoneProgress(speech, slots, lastQuestion = '') {
  const s = { ...(slots || {}) };
  if (s.callback_number) return { slots: s, reply: null, handled: false };

  const p = parsePhone(speech);
  if (!p) return { slots: s, reply: null, handled: false };

  const askedForPhone = /\b(callback|best (phone|number)|phone number|callback number)\b/i.test(lastQuestion || '');

  if (p.complete || askedForPhone) {
    if (p.complete) {
      s.callback_number = p.full;
      s.callback_confirm_pending = true;
      return {
        slots: s,
        reply: `Thanks. I have your callback number as ${p.full}. Is that correct?`,
        handled: true
      };
    }
    // We asked for phone but only heard a partial number
    return {
      slots: s,
      reply: 'I heard the beginning. What’s the full 10-digit callback number?',
      handled: true
    };
  }

  // We did NOT ask for phone and it’s not a complete 10 digits: ignore (prevents ZIP/house # collisions)
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

    // Merge slots upfront
    let mergedSlots = { ...(lastSlots || {}) };
    if (mergedSlots.confirmation_pending !== true) mergedSlots.confirmation_pending = false;
    if (!mergedSlots.summary_reads) mergedSlots.summary_reads = 0;

    // We’ll reuse this for phone gating and steering
    const priorLastQuestion = getLastAssistantQuestion(history) || '';
    const effectiveLastQ = lastQuestion || priorLastQuestion;

    // --- FINAL CONFIRMATION GATE ---
    if (mergedSlots.confirmation_pending === true) {
      if (isAffirmation(speech) && !isNegation(speech)) {
        mergedSlots.confirmation_pending = false;
        const bye = "You’re set. We’ll call ahead before arriving. Thank you for choosing H.V.A.C Joy. Goodbye.";
        return res.status(200).json({
          reply: "Great—thanks. You’re all set.",
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
          reply: "No problem—what would you like to change?",
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }

      // Unclear → ask for explicit yes/no or change
      return res.status(200).json({
        reply: "If everything is correct, please say “yes.” Otherwise, tell me what to change.",
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
          reply: enforceHVACBranding(addEmpathy(speech, prompt)),
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }
      if (isNegation(speech)) {
        // Try to parse the corrected address immediately
        const corrected = parseFullAddress(speech);
        if (corrected) {
          mergedSlots.address_confirm_pending = true;
          mergedSlots.service_address = { ...(mergedSlots.service_address||{}), ...corrected };
          const text = `Sorry about that—thank you. I have ${corrected.line1}, ${corrected.city}, ${corrected.state} ${corrected.zip}. Is that correct?`;
          return res.status(200).json({
            reply: enforceHVACBranding(addEmpathy(speech, text)),
            slots: mergedSlots,
            done: false,
            goodbye: null,
            needs_confirmation: false,
            model: 'gpt-4o-mini',
            usage: null,
          });
        }
        mergedSlots.address_confirm_pending = false;
        mergedSlots.service_address = { line1: null, line2: null, city: null, state: null, zip: null };
        return res.status(200).json({
          reply: enforceHVACBranding(addEmpathy(speech, 'Sorry about that—what is the correct full address? Please say it in one sentence, including street, city, state, and zip.')),
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }
      return res.status(200).json({
        reply: enforceHVACBranding(addEmpathy(
          speech,
          `Is this address correct: ${[addr.line1, addr.city, addr.state, addr.zip].filter(Boolean).join(', ')}? Please say yes or no.`
        )),
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
      if (isAffirmation(speech) && !isNegation(speech)) {
        mergedSlots.callback_confirm_pending = false;
        const prompt = nextMissingPrompt(mergedSlots) || 'Great—thanks. What day works for your visit? The earliest is tomorrow.';
        return res.status(200).json({
          reply: enforceHVACBranding(addEmpathy(speech, prompt)),
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
          reply: enforceHVACBranding(addEmpathy(speech, 'No problem—what’s the full 10-digit callback number?')),
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }
      return res.status(200).json({
        reply: enforceHVACBranding(addEmpathy(speech, `I have ${n} as your callback number. Is that correct? Please say yes or no.`)),
        slots: mergedSlots,
        done: false,
        goodbye: null,
        needs_confirmation: false,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    // ---- Strict address capture (one-line only)
    const addrProgress = handleAddressProgress_STRICT(speech, mergedSlots);
    if (addrProgress.handled) {
      mergedSlots = addrProgress.slots;
      const empathetic = addEmpathy(speech, addrProgress.reply);
      return res.status(200).json({
        reply: enforceHVACBranding(empathetic),
        slots: mergedSlots,
        done: false,
        goodbye: null,
        needs_confirmation: false,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    // ---- Phone progress (accept full 10; ignore partials unless we asked)
    const phoneProgress = handlePhoneProgress(speech, mergedSlots, effectiveLastQ);
    if (phoneProgress.handled) {
      mergedSlots = phoneProgress.slots;
      const empathetic = addEmpathy(speech, phoneProgress.reply);
      return res.status(200).json({
        reply: enforceHVACBranding(empathetic),
        slots: mergedSlots,
        done: false,
        goodbye: null,
        needs_confirmation: false,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    // ---- “let’s continue / move on” → next missing item (but not during gates)
    if (!mergedSlots.confirmation_pending && !mergedSlots.address_confirm_pending && !mergedSlots.callback_confirm_pending && wantsToContinue(speech)) {
      const prompt = nextMissingPrompt(mergedSlots) || 'Great—thanks. What day works for your visit? The earliest is tomorrow.';
      return res.status(200).json({
        reply: enforceHVACBranding(addEmpathy(speech, prompt)),
        slots: mergedSlots,
        done: false,
        goodbye: null,
        needs_confirmation: false,
        model: 'gpt-4o-mini',
        usage: null,
      });
    }

    // ---- Normal LLM step ---------------------------------------------------
    const priorLastQ = priorLastQuestion; // already computed
    const lastQ = lastQuestion || priorLastQ;

    const steering =
      'Continue the call. Do not repeat the greeting.' +
      '\nAsk for the FULL service address (street, city, state, zip) in one question; if the caller gives only street, ask specifically for the city/state/zip.' +
      '\nRequire a date for booking. Ask for date first, then time window.' +
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
        reply: enforceHVACBranding(addEmpathy(speech, 'Thanks. Please say the full service address in one sentence, including street, city, state, and zip.')),
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
        reply: 'Thanks. What’s the next detail—your full service address with city, state, and zip?',
        slots: {},
        done: false,
        goodbye: null,
        needs_confirmation: false,
      };
    }

    if (typeof parsed.reply !== 'string') {
      parsed.reply = 'Thanks. What’s the next detail—your full service address with city, state, and zip?';
    }
    if (!parsed.slots || typeof parsed.slots !== 'object') parsed.slots = {};

    // merge with old slots
    mergedSlots = mergeSlots(mergedSlots, parsed.slots);

    // heuristics
    if (!mergedSlots.preferred_window) {
      const win = inferPreferredWindowFrom(speech);
      if (win) mergedSlots.preferred_window = win;
    }
    if (mergedSlots.pricing_disclosed !== true) {
      const lastAssistantLines = [...history, { role: 'assistant', content: parsed.reply || '' }]
        .filter(m => m.role === 'assistant')
        .slice(-8)
        .map(m => m.content || '');
      if (lastAssistantLines.some(statementMentionsPricing)) {
        mergedSlots.pricing_disclosed = true;
      }
    }
    {
      // Only infer call-ahead when the last asked question was about call-ahead
      const inferred = inferYesNoCallAhead(speech);
      if (inferred !== null && /call[- ]ahead/i.test(lastQ || '')) {
        mergedSlots.call_ahead = inferred;
      }
    }

    // If the model tries to schedule before price disclosure, force the price line
    if (mergedSlots.pricing_disclosed !== true &&
        /(?:schedule|book|calendar|what day works|time window|morning|afternoon)/i.test(parsed.reply || '')) {
      parsed.reply = 'Our diagnostic visit is $50 per non-working unit. Shall we proceed?';
    }

    // Time-window repeat guard
    const guard = sameQuestionRepeatGuard(lastQ, parsed.reply, speech, mergedSlots);
    if (guard.updated) parsed.reply = guard.newReply;

    // Prevent repeated thermostat question if both values are present
    if (/thermostat.*setpoint.*current/i.test(parsed.reply) &&
        (mergedSlots.thermostat && mergedSlots.thermostat.setpoint != null && mergedSlots.thermostat.current != null)) {
      parsed.reply = 'Great—thanks. Our diagnostic visit is $50 per non-working unit. What day works for your visit?';
    }

    // If the model says "schedule" but we’re missing required pieces, push next missing prompt
    if (/schedule|book|calendar/i.test(parsed.reply) && !serverSideDoneCheck(mergedSlots)) {
      const prompt = nextMissingPrompt(mergedSlots);
      if (prompt) parsed.reply = prompt;
    }

    // Final cleanups
    parsed.reply = suppressPricingIfAlreadyDisclosed(parsed.reply, mergedSlots);
    parsed.reply = suppressMembershipUntilBooked(parsed.reply, mergedSlots);
    parsed.reply = addEmpathy(speech, parsed.reply);
    parsed.reply = stripRepeatedGreeting(history, parsed.reply);
    parsed.reply = enforceHVACBranding(parsed.reply);

    // done?
    const serverDone = serverSideDoneCheck(mergedSlots);

    let needs_confirmation = false;
    let replyOut = parsed.reply;
    if (serverDone) {
      // Only read the summary the first time we reach done
      if ((mergedSlots.summary_reads || 0) < 1) {
        replyOut = "Here’s a quick summary:\n" + summaryFromSlots(mergedSlots) + "\nIs everything correct? If not, say what you’d like to change.";
        mergedSlots.summary_reads = (mergedSlots.summary_reads || 0) + 1;
      } else {
        replyOut = 'Is everything correct? If not, say what you’d like to change.';
      }
      needs_confirmation = true;
      mergedSlots.confirmation_pending = true;
    }

    return res.status(200).json({
      reply: replyOut,
      slots: mergedSlots,
      done: serverDone && !needs_confirmation,
      goodbye: serverDone && !needs_confirmation
        ? (parsed.goodbye || "You’re set. We’ll call ahead before arriving. Thank you for choosing H.V.A.C Joy. Goodbye.")
        : null,
      needs_confirmation,
      model: 'gpt-4o-mini',
      usage: data?.usage ?? null,
    });
  } catch (err) {
    console.error('chat handler error', err);
    return res.status(200).json({
      reply: enforceHVACBranding(addEmpathy(speech, "I caught that. When you’re ready, please say the full service address in one sentence, including street, city, state, and zip.")),
      slots: (req.body && req.body.lastSlots) || {},
      done: false,
      goodbye: null,
      needs_confirmation: false,
      error: 'Server error',
      detail: err?.message ?? String(err),
    });
  }
}
