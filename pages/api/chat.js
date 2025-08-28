/* eslint-disable */
// pages/api/chat.js
import { getSupabaseAdmin } from '../../lib/supabase-admin';

const SYSTEM_PROMPT = `
You are “Joy,” the inbound phone agent for a residential H.V.A.C. company.
Primary goal: warmly book service, set expectations, and capture complete job details. Do not diagnose.

VOICE & STYLE
- Warm, professional, concise. Short sentences (<= 14 words).
- Always show brief empathy after the issue, then IMMEDIATELY ask the next specific question.
- Confirm important items back to the caller as you capture them.

SAFETY & GUARDRails
- Only give these prices:
  - Diagnostic visit: $50 per non-working unit.
  - Maintenance visit: $50 for non-members.
- Never promise exact arrival times; offer a window and a call-ahead.
- If smoke, sparks, gas smell, or health risk: advise 911 and escalate to a human.
- Do not argue about pricing; note and escalate.

CALL FLOW (capture + confirm)
- Full name
- Service address (line1, city, state, zip) + entry/parking notes
- Best callback number
- Unit count and locations
- Brand (if known)
- Symptoms (no cool/heat, airflow, icing, noises, ants)
- Thermostat setpoint and current reading
- Pricing disclosure
- Schedule (preferred date/window & call-ahead)
- Membership check
- Summarize & confirm details; then close politely and end the call.

MANDATORY BEHAVIOR
- After empathy, ALWAYS pose a clear question to capture the next missing field.
- Do NOT re-ask questions for slots that are already non-null (see "KNOWN SLOTS").
- When booking is confirmed and details complete, set done=true and include a short “goodbye”.

OUTPUT FORMAT (one JSON object):
{
  "reply": "<Joy's next line, voice-ready, empathy + a specific question>",
  "slots": { ... see schema ... },
  "done": false | true,
  "goodbye": null | "<polite closing>"
}

SLOTS SCHEMA:
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

DONE RULE
- Set done=true only after: name, address (line1/city/state/zip), callback_number,
  pricing_disclosed=true, and either preferred_date or preferred_window is set.
- Provide a short "goodbye" (e.g., "You’re set for <window>. We’ll call ahead. Thank you. Goodbye.")
`;

function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

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

    // Detect if greeting already happened to avoid repeats
    const greetingSaid = history.some(
      (m) =>
        m.role === 'assistant' &&
        m.content.toLowerCase().includes('this call may be recorded') &&
        m.content.toLowerCase().includes('this is joy')
    );

    const steering =
      (greetingSaid
        ? "Continue the call. Do not repeat the greeting."
        : "Start with the greeting, then proceed to capture details.") +
      "\nKNOWN SLOTS (do not re-ask if non-null):\n" +
      JSON.stringify(lastSlots || {}, null, 2) +
      "\nREMINDER: Empathize briefly, then ALWAYS ask the next specific question.";

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "assistant", content: steering },
      { role: "user", content: speech }
    ];

    const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS || '15000', 10);
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

    if (!resp?.ok) {
      const text = await resp?.text();
      console.error("OpenAI error", text);
      return res.status(200).json({
        reply: "I’m here to help. What’s the street address, city, and zip?",
        slots: lastSlots || {},
        done: false,
        goodbye: null,
        model: "gpt-4o-mini",
        usage: null,
      });
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content ?? "{}";

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      parsed = {
        reply: "I’m here with you. What’s the street address, city, and zip?",
        slots: lastSlots || {},
        done: false,
        goodbye: null,
      };
    }

    if (typeof parsed.reply !== "string") {
      parsed.reply = "Thanks for sharing that. What’s the next detail—street address, city, and zip?";
    }
    if (!parsed.slots || typeof parsed.slots !== "object") parsed.slots = lastSlots || {};
    if (typeof parsed.done !== "boolean") parsed.done = false;
    if (parsed.done && typeof parsed.goodbye !== "string") {
      parsed.goodbye = "You’re set. We’ll call ahead. Thank you for choosing H.V.A.C. Joy. Goodbye.";
    }

    return res.status(200).json({
      reply: parsed.reply,
      slots: parsed.slots,
      done: parsed.done,
      goodbye: parsed.goodbye || null,
      model: "gpt-4o-mini",
      usage: data?.usage ?? null,
    });
  } catch (err) {
    console.error("chat handler error", err);
    return res.status(200).json({
      reply: "Sorry—please continue when ready. What’s the street address, city, and zip?",
      slots: {},
      done: false,
      goodbye: null,
      error: "Server error",
      detail: err?.message ?? String(err),
    });
  }
}
