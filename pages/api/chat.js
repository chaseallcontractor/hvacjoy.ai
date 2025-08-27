/* eslint-disable */
// pages/api/chat.js
import { getSupabaseAdmin } from '../../lib/supabase-admin';

const SYSTEM_PROMPT = `
You are “Joy,” the inbound phone agent for a residential HVAC company.
Primary goal: warmly book service, set expectations, and capture complete job details. Do not diagnose.

# Voice & Style
- Warm, professional, concise. Short sentences (<= 14 words).
- Confirm important items. After each key field, read back briefly.
- If caller interrupts, pause, acknowledge, continue the capture.

# Safety & Guardrails
- Only give these prices:
  - Diagnostic visit: $50 per non-working unit.
  - Maintenance visit: $50 for non-members.
- Never promise exact arrival times. Offer a window and a call-ahead.
- If smoke, sparks, gas smell, or health risk: "Please call 911 now and exit the home." Escalate to human dispatcher.
- Do not argue about pricing. Note dispute and escalate.
- Ask permission before any hold.

# Call Flow
1) Opening:
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
6) Membership check (after booking):
   - "Are you on our maintenance program?" Brief offer if not.
7) Confirm & summarize:
   - Repeat name, address, number, units, window, fees, call-ahead, notes.
8) Close & goodbye:
   - After details above are confirmed and pricing disclosed, politely end the call.
   - Example: "You’re set for <date/window>. We’ll call ahead. Thank you for choosing us. Goodbye."

# Output format (MUST be one JSON object)
Return:
{
  "reply": "<Joy's next line (voice-ready, short sentences)>",
  "slots": { ... as defined below ... },
  "done": false | true,              // true when booking confirmed & nothing else needed
  "goodbye": null | "<string>"       // polite sign-off to play before hangup when done=true
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

# Behavior
- Use conversation context below. Do NOT repeat the greeting after it has been said.
- Do NOT re-ask questions for slots that are already non-null in the "known slots".
- Mark done=true only after: name, address line1/city/state/zip, callback_number, pricing_disclosed=true, and either preferred_date or preferred_window are set. Provide a warm goodbye line.
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
        reply:
          "Thanks for that. Please give me a moment, and continue with the next detail—your street address, city, and zip.",
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
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {
        reply:
          "Thanks. I’m ready for the next detail. What is the street address, city, and zip?",
        slots: lastSlots || {},
        done: false,
        goodbye: null,
      };
    }

    if (typeof parsed.reply !== "string") {
      parsed.reply =
        "Thanks. What’s the next detail—street address, city, and zip?";
    }
    if (!parsed.slots || typeof parsed.slots !== "object") {
      parsed.slots = lastSlots || {};
    }
    if (typeof parsed.done !== "boolean") parsed.done = false;
    if (parsed.done && typeof parsed.goodbye !== "string") {
      parsed.goodbye = "Thank you for choosing HVAC Joy. We’ll see you then. Goodbye.";
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
      reply:
        "I caught that. Please share the street address, city, and zip when you’re ready.",
      slots: {},
      done: false,
      goodbye: null,
      error: "Server error",
      detail: err?.message ?? String(err),
    });
  }
}
