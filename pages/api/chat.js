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
   - Service address (line1, city, state, zip) + gate/parking notes
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
  "goodbye": null | "<string>"
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
- If the caller’s reply does NOT answer your last question, politely re-ask the same question and continue.
- Be apologetic/comforting right after the caller states a problem.
- Set done=true only after:
  full_name, callback_number, service_address.line1/city/state/zip,
  pricing_disclosed=true, and (preferred_date OR preferred_window) are present.
- Provide a warm closing when done=true.
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
      .select('role, text, turn_index') // meta not needed to render for the model
      .eq('call_sid', callSid)
      .order('turn_index', { ascending: true })
      .limit(40);

    return (data || []).map(r => ({
      role: r.role === 'assistant' ? 'assistant' : 'user',
      content: r.text || ''
    }));
  } catch (e) {
    console.error('fetchHistoryMessages error', e);
    return [];
  }
}

// deep merge helper for slots
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

// ---------- Heuristics to cover model/STT misses ---------------------------
function inferPreferredWindowFrom(text) {
  const t = (text || '').toLowerCase();
  if (/\bmorning\b/.test(t)) return 'morning';
  if (/\bafternoon\b/.test(t)) return 'afternoon';
  if (/\bevening\b/.test(t)) return 'afternoon'; // treat evening as PM window
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

// Find the last assistant question in history (ends with "?")
function getLastAssistantQuestion(history) {
  const assistantLines = (history || []).filter(m => m.role === 'assistant').map(m => m.content);
  for (let i = assistantLines.length - 1; i >= 0; i--) {
    const line = (assistantLines[i] || '').trim();
    if (line.endsWith('?')) return line;
  }
  return null;
}

function applyHeuristics(mergedSlots, history, latestUser, latestAssistant) {
  const slots = { ...(mergedSlots || {}) };

  if (!slots.preferred_window) {
    const win = inferPreferredWindowFrom(latestUser);
    if (win) slots.preferred_window = win;
  }

  if (slots.pricing_disclosed !== true) {
    const lastAssistantLines = [...history, { role: 'assistant', content: latestAssistant || '' }]
      .filter(m => m.role === 'assistant')
      .slice(-8)
      .map(m => m.content || '');
    if (lastAssistantLines.some(statementMentionsPricing)) {
      slots.pricing_disclosed = true;
    }
  }

  // Infer/overwrite call_ahead from latest utterance (latest wins)
  const inferred = inferYesNoCallAhead(latestUser);
  if (inferred !== null) slots.call_ahead = inferred;

  return slots;
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

    // Always steer to continue (intro is handled/logged by webhook)
    const priorLastQuestion = getLastAssistantQuestion(history) || '';
    const lastQ = lastQuestion || priorLastQuestion;

    const steering =
      'Continue the call. Do not repeat the greeting.' +
      '\nIf the caller’s reply does NOT answer your last question, politely re-ask the same question and continue.' +
      (lastQ ? `\nLast question you asked was:\n"${lastQ}"` : '') +
      '\nKnown slots (do not re-ask if non-null):\n' +
      JSON.stringify(lastSlots || {}, null, 2);

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
        reply: "Thanks. Please continue with the next detail—your street address, city, and zip.",
        slots: lastSlots,
        done: false,
        goodbye: null,
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
        reply: "Thanks. What’s the next detail—street address, city, and zip?",
        slots: {},
        done: false,
        goodbye: null,
      };
    }

    // ensure reply and slots
    if (typeof parsed.reply !== 'string') {
      parsed.reply = "Thanks. What’s the next detail—street address, city, and zip?";
    }
    if (!parsed.slots || typeof parsed.slots !== 'object') parsed.slots = {};

    // merge with old slots
    let mergedSlots = mergeSlots(lastSlots, parsed.slots);

    // heuristics
    mergedSlots = applyHeuristics(mergedSlots, history, speech, parsed.reply);

    // done?
    const done = parsed.done === true || serverSideDoneCheck(mergedSlots);
    const goodbye = done
      ? (parsed.goodbye || "You’re set. We’ll call ahead before arriving. Thank you for choosing H.V.A.C Joy. Goodbye.")
      : null;

    return res.status(200).json({
      reply: parsed.reply,
      slots: mergedSlots,
      done,
      goodbye,
      model: 'gpt-4o-mini',
      usage: data?.usage ?? null,
    });
  } catch (err) {
    console.error('chat handler error', err);
    return res.status(200).json({
      reply: "I caught that. When you’re ready, please share the street address, city, and zip.",
      slots: lastSlots || {},
      done: false,
      goodbye: null,
      error: 'Server error',
      detail: err?.message ?? String(err),
    });
  }
}
