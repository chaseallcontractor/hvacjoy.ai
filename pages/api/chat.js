/* eslint-disable */
// pages/api/chat.js
import { getSupabaseAdmin } from '../../lib/supabase-admin';

/** ---------- Prompt with empathy + H.V.A.C. pronunciation ---------- */
const SYSTEM_PROMPT = `
You are “Joy,” the inbound phone agent for a residential H.V.A.C. company.
Primary goal: warmly book service, set expectations, and capture complete job details. Do not diagnose.

# Voice & Style
- Warm, professional, concise. Short sentences (<= 14 words).
- Say “H.V.A.C.” (spell it), not “hvac.”
- Confirm important items; read back briefly.
- If caller states a problem, begin your reply with a brief empathy line,
  e.g., “I’m sorry that’s happening. We’ll take care of you.”

# Safety & Guardrails
- Only give these prices:
  - Diagnostic visit: $50 per non-working unit.
  - Maintenance visit: $50 for non-members.
- Never promise exact arrival times. Offer a window and a call-ahead.
- If smoke, sparks, gas smell, or health risk: "Please call 911 now and exit the home." Escalate to human dispatcher.
- Do not argue about pricing. Note dispute and escalate.
- Ask permission before any hold.

# Call Flow
1) Opening (only once per call):
   "To ensure the highest quality service, this call may be recorded and monitored.
    Thank you for calling—this is Joy. How can I help today?"
2) Identify & verify (capture + confirm):
   - Full name (spell if unsure)
   - Service address + gate/entry/parking notes
   - Best callback number
3) Problem discovery (capture + confirm):
   - How many systems and where?
   - Brand (if known)
   - Symptoms (no cool/heat, airflow, icing, noises, ants/pests)
   - Thermostat setpoint and current reading
4) Pricing disclosure (before scheduling):
   "Our diagnostic visit is $50 per non-working unit. A maintenance visit is $50 for non-members.
    The technician will assess and provide a quote before any repair."
5) Scheduling:
   - Offer earliest availability, give an arrival window, add call-ahead.
   - For multiple units, note the visit may take longer.
   - If the caller gives appointment info, set: preferred_date, preferred_window, confirmed_appointment (true/false).
6) Membership check (after booking).
7) Confirm & summarize.
8) Close & goodbye (after confirmation):
   "You’re set for <date/window>. We’ll call ahead. Thank you for choosing us. Goodbye."

# Output format (one JSON object)
Return:
{
  "reply": "<Joy's next line (voice-ready, short sentences, sympathetic if they described a problem)>",
  "slots": { ... see schema ... },
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
  "confirmed_appointment": null | true | false,
  "call_ahead": null | true | false,
  "hazards_pets_ants_notes": null | "<string>",
  "pricing_disclosed": true | false,
  "emergency": false | true
}

# Behavior
- Use conversation context below. Do NOT repeat the opening after it has been said.
- Do NOT re-ask a question if that slot is non-null in the known slot state.
- Mark done=true only after all are true:
  full_name, callback_number, service_address.line1/city/state/zip,
  pricing_disclosed=true, preferred_date or preferred_window is set,
  and confirmed_appointment=true.
- When done=true, reply should be the final confirmation (no new questions) and include a short goodbye.
`;

function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

/** fetch last ~20 turns for context */
async function fetchHistoryMessages(callSid) {
  if (!callSid) return [];
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('call_transcripts')
      .select('role, text, turn_index')
      .eq('call_sid', callSid)
      .order('turn_index', { ascending: true })
      .limit(20);

    if (error || !data) return [];

    return data.map((row) => ({
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: row.text || ''
    }));
  } catch (e) {
    console.error('fetchHistoryMessages error', e);
    return [];
  }
}

/** slot helpers: deep merge + done detector */
function deepMergeSlots(prev = {}, next = {}) {
  const out = { ...prev, ...next };
  if (prev.service_address || next.service_address) {
    out.service_address = { ...(prev.service_address || {}), ...(next.service_address || {}) };
  }
  if (prev.thermostat || next.thermostat) {
    out.thermostat = { ...(prev.thermostat || {}), ...(next.thermostat || {}) };
  }
  return out;
}
function nonEmpty(v) { return v !== null && v !== undefined && String(v).trim() !== ''; }
function bookingDone(slots) {
  if (!slots) return false;
  const sa = slots.service_address || {};
  const hasAddress = [sa.line1, sa.city, sa.state, sa.zip].every(nonEmpty);
  const basics =
    nonEmpty(slots.full_name) &&
    nonEmpty(slots.callback_number) &&
    hasAddress &&
    slots.pricing_disclosed === true;

  const haveWhen = nonEmpty(slots.preferred_date) || nonEmpty(slots.preferred_window);
  const confirmed = slots.confirmed_appointment === true;

  return basics && haveWhen && confirmed;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { speech = "", caller = "", callSid = "", lastSlots = {} } = req.body || {};
    if (!speech) return res.status(400).json({ error: 'Missing "speech" in body' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY is not set" });

    const history = await fetchHistoryMessages(callSid);

    const greetingSaid = history.some(
      (m) =>
        m.role === 'assistant' &&
        m.content.toLowerCase().includes('this call may be recorded') &&
        m.content.toLowerCase().includes('this is joy')
    );

    const steering =
      (greetingSaid
        ? "Continue the call. Do not repeat the greeting."
        : "Start the call with the greeting, then proceed to capture caller details.") +
      "\nKnown slots (do not re-ask if a field is non-null):\n" +
      JSON.stringify(lastSlots || {}, null, 2);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "assistant", content: steering },
      { role: "user", content: speech }
    ];

    const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || '20000', 10); // ↑ prevent freezes
    const t = withTimeout(OPENAI_TIMEOUT_MS);

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages,
      }),
      signal: t.signal,
    }).catch(e => { throw e; })
      .finally(() => t.cancel());

    // fallback if OpenAI slow/unavailable
    if (!resp?.ok) {
      const text = await resp?.text();
      console.error("OpenAI error", text);
      return res.status(200).json({
        reply:
          "I’m sorry you’re dealing with that. Let’s keep going—may I have the street address, city, and zip?",
        slots: lastSlots || {},
        done: false,
        goodbye: null,
        model: "gpt-4o-mini",
        usage: null,
      });
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content ?? "{}";

    // parse & guard
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {
        reply:
          "I’m sorry that’s happening. Let’s keep going—what’s the street address, city, and zip?",
        slots: {},
        done: false,
        goodbye: null,
      };
    }

    if (typeof parsed.reply !== "string") {
      parsed.reply =
        "I’m sorry about that. What’s the street address, city, and zip?";
    }
    if (!parsed.slots || typeof parsed.slots !== "object") parsed.slots = {};

    // merge new slots with last known
    const mergedSlots = deepMergeSlots(lastSlots || {}, parsed.slots || {});
    // compute done if model didn't
    const finalDone = typeof parsed.done === 'boolean' ? parsed.done : bookingDone(mergedSlots);

    let goodbye = parsed.goodbye || null;
    if (finalDone && !goodbye) {
      const when =
        mergedSlots.preferred_date && mergedSlots.preferred_window
          ? `${mergedSlots.preferred_date} (${mergedSlots.preferred_window})`
          : mergedSlots.preferred_date || mergedSlots.preferred_window || "the scheduled window";
      goodbye = `You're all set for ${when}. Thank you for choosing us. Goodbye.`;
    }

    return res.status(200).json({
      reply: parsed.reply,
      slots: mergedSlots,
      done: finalDone,
      goodbye,
      model: "gpt-4o-mini",
      usage: data?.usage ?? null,
    });
  } catch (err) {
    console.error("chat handler error", err);
    return res.status(200).json({
      reply:
        "I’m sorry for the hiccup. Let’s continue—what’s the street address, city, and zip?",
      slots: {},
      done: false,
      goodbye: null,
      error: "Server error",
      detail: err?.message ?? String(err),
    });
  }
}
