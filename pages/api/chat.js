/* eslint-disable */
// pages/api/chat.js
import { getSupabaseAdmin } from '../../lib/supabase-admin';

const SYSTEM_PROMPT = `
You are “Joy,” the inbound phone agent for a residential H.V.A.C company.
Primary goal: warmly book service, set expectations, and capture complete job details. Do not diagnose.

Voice & Style
- Warm, professional, concise. Short sentences (<= 14 words).
- Acknowledge and comfort after the caller states a problem.
- Confirm important items briefly after capturing them.
- Do not use meta language (e.g., “I already answered your questions”). Be forward-looking and helpful.

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
   - Offer earliest availability + arrival window + call-ahead.
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
  "emergency": false | true
}

Behavior
- Continue the call. Do not repeat the greeting.
- Do NOT ask again for any slot already non-null in "known slots".
- Ask for the **full address** in one question; reflect back for a quick yes/no confirm.
- If the caller’s reply does NOT answer your last question, politely re-ask the same question and continue.
- If the caller corrects a prior detail (e.g., “70 not 17”), acknowledge, update the detail, confirm it, and continue.
- If the caller says “we already talked about this,” skip repeating covered steps and continue forward.
- Set done=true only after:
  full_name, callback_number, service_address.line1/city/state/zip,
  pricing_disclosed=true, and (preferred_date OR preferred_window) are present.
- When done is reached, ALWAYS read a short summary and ask "Is everything correct?" before finalizing.
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
      .limit(50);

    return (data || []).map(r => ({
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.text || ''
    }));
  } catch (e) {
    console.error('fetchHistoryMessages error', e);
    return [];
  }
}

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

// ---------- Heuristics -----------------------------------------------------
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

// ----------------- Corrections & parsing (works anywhere) ------------------
function parseFullAddress(line) {
  const m = (line || '').match(/\b(\d{3,6}\s+[A-Za-z0-9.\s]+?),\s*([A-Za-z][A-Za-z\s]+),\s*([A-Za-z]{2})\s+(\d{5})\b/);
  if (!m) return null;
  return { line1: m[1], city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] };
}
function parseAddressLine1(text) {
  const m = (text || '').match(/\b(\d{3,6}\s+[A-Za-z0-9.\s]+?(?:Street|St|Drive|Dr|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Court|Ct|Way))\b/i);
  return m ? m[1] : null;
}
function parseCityStateZip(text) {
  const m = (text || '').match(/\b([A-Za-z][A-Za-z\s]+),\s*([A-Za-z]{2})\s+(\d{5})\b/);
  if (m) return { city: m[1].trim(), state: m[2].toUpperCase(), zip: m[3] };
  return null;
}
function parseThermostatSetpointCorrection(text) {
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
function parsePhoneCorrection(text) {
  const digits = (text || '').replace(/\D+/g, '');
  if (digits.length === 10) return `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`;
  return null;
}
function parseUnitCount(text) {
  const m = (text || '').match(/\b(\d+)\s*(?:unit|units|ac|systems?)\b/i);
  if (m) return parseInt(m[1], 10);
  return null;
}
function detectCorrections(speech, slots) {
  const s = { ...(slots || {}) };
  let corrected = false;
  const notes = [];

  const full = parseFullAddress(speech);
  if (full) {
    s.service_address = s.service_address || {};
    const changed = s.service_address.line1 !== full.line1
      || s.service_address.city !== full.city
      || s.service_address.state !== full.state
      || s.service_address.zip !== full.zip;
    if (changed) {
      s.service_address = { ...s.service_address, ...full };
      corrected = true;
      notes.push(`service address to ${full.line1}, ${full.city}, ${full.state} ${full.zip}`);
    }
  }

  const line1 = parseAddressLine1(speech);
  if (line1) {
    s.service_address = s.service_address || {};
    if (s.service_address.line1 !== line1) {
      s.service_address.line1 = line1;
      corrected = true;
      notes.push(`address to ${line1}`);
    }
  }

  const csz = parseCityStateZip(speech);
  if (csz) {
    s.service_address = s.service_address || {};
    if (s.service_address.city !== csz.city || s.service_address.state !== csz.state || s.service_address.zip !== csz.zip) {
      s.service_address.city = csz.city;
      s.service_address.state = csz.state;
      s.service_address.zip = csz.zip;
      corrected = true;
      notes.push(`city/state/zip to ${csz.city}, ${csz.state} ${csz.zip}`);
    }
  }

  const newSp = parseThermostatSetpointCorrection(speech);
  if (newSp !== null) {
    s.thermostat = s.thermostat || {};
    if (s.thermostat.setpoint !== newSp) {
      s.thermostat.setpoint = newSp;
      corrected = true;
      notes.push(`thermostat setpoint to ${newSp}°`);
    }
  }

  const phone = parsePhoneCorrection(speech);
  if (phone && s.callback_number !== phone) {
    s.callback_number = phone;
    corrected = true;
    notes.push(`callback number to ${phone}`);
  }

  const uc = parseUnitCount(speech);
  if (uc !== null && s.unit_count !== uc) {
    s.unit_count = uc;
    corrected = true;
    notes.push(`unit count to ${uc}`);
  }

  return { slots: s, corrected, correctionSummary: notes };
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
  const callAhead = (s.call_ahead === false) ? 'No call-ahead' : 'Call-ahead';
  return `- Name: ${name}
- Address: ${addrLine}
- AC units: ${units}${locs}
- Brand: ${brand}
- Thermostat setpoint: ${sp}, current: ${cur}
- Appointment: ${date || 'scheduled'}${window ? ` (${window})` : ''}
- ${callAhead}
- Diagnostic fee: $50.`;
}

function serverSideDoneCheck(slots) {
  const s = slots || {};
  const addr = s.service_address || {};
  const basics =
    !!s.full_name &&
    !!s.callback_number &&
    !!addr.line1 && !!addr.city && !!addr.state && !!addr.zip &&
    s.pricing_disclosed === true &&
    (s.preferred_date || s.preferred_window);
  return basics;
}

// ---- Repeat guard for time window question
function sameQuestionRepeatGuard(lastQ, newQ, speech, mergedSlots) {
  if (!lastQ || !newQ) return { newReply: null, updated: false };
  if (lastQ.trim() !== newQ.trim()) return { newReply: null, updated: false };
  const win = inferPreferredWindowFrom(speech);
  if (win && !mergedSlots.preferred_window) {
    mergedSlots.preferred_window = win;
    return {
      newReply: `Got it — we'll reserve the ${win} window. Do you prefer tomorrow, or another date?`,
      updated: true
    };
  }
  return { newReply: null, updated: false };
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

    // Early corrections (work anywhere)
    let mergedSlots = { ...(lastSlots || {}) };
    {
      const { slots: updatedSlots, corrected, correctionSummary } = detectCorrections(speech, mergedSlots);
      if (corrected) {
        mergedSlots = updatedSlots;
        const msg = `Thanks for the clarification. I've updated ${correctionSummary.join(', ')}. Let's continue.`;
        return res.status(200).json({
          reply: msg,
          slots: mergedSlots,
          done: false,
          goodbye: null,
          needs_confirmation: false,
          model: 'gpt-4o-mini',
          usage: null,
        });
      }
    }

    const priorLastQuestion = getLastAssistantQuestion(history) || '';
    const lastQ = lastQuestion || priorLastQuestion;

    const steering =
      'Continue the call. Do not repeat the greeting.' +
      '\nAsk for the FULL service address (street, city, state, zip) in one question; then reflect it back for a yes/no confirm.' +
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
    }).catch(e => { throw e; })
      .finally(() => t.cancel());

    if (!resp?.ok) {
      const text = await resp?.text();
      console.error('OpenAI error', text);
      return res.status(200).json({
        reply: "Thanks. Please share the full service address, including city, state, and zip.",
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
        reply: "Thanks. What’s the next detail—your full service address with city, state, and zip?",
        slots: {},
        done: false,
        goodbye: null,
        needs_confirmation: false,
      };
    }

    if (typeof parsed.reply !== 'string') {
      parsed.reply = "Thanks. What’s the next detail—your full service address with city, state, and zip?";
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
      const inferred = inferYesNoCallAhead(speech);
      if (inferred !== null) mergedSlots.call_ahead = inferred;
    }

    // Time-window repeat guard
    const guard = sameQuestionRepeatGuard(lastQ, parsed.reply, speech, mergedSlots);
    if (guard.updated) parsed.reply = guard.newReply;

    // done?
    const serverDone = serverSideDoneCheck(mergedSlots);

    // Always provide our summary + confirmation when done
    let needs_confirmation = false;
    let replyOut = parsed.reply;
    if (serverDone) {
      const { slots: correctedSlots, corrected } = detectCorrections(speech, mergedSlots);
      mergedSlots = correctedSlots;
      replyOut = "Here’s a quick summary:\n" + summaryFromSlots(mergedSlots) + "\nIs everything correct?";
      needs_confirmation = true;
    }

    return res.status(200).json({
      reply: serverDone ? replyOut : parsed.reply,
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
      reply: "I caught that. When you’re ready, please share the full service address, including city, state, and zip.",
      slots: lastSlots || {},
      done: false,
      goodbye: null,
      needs_confirmation: false,
      error: 'Server error',
      detail: err?.message ?? String(err),
    });
  }
}
