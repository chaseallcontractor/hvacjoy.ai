/* eslint-disable */
// pages/api/chat.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { speech = "", caller = "" } = req.body || {};
    if (!speech) return res.status(400).json({ error: 'Missing "speech" in body' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY is not set" });

    // === new system prompt (voice-optimized, guardrails, slot schema) ===
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
8) Handoff: save notes; escalate emergencies or complex billing/warranty.

# Edge scripts (use when relevant)
- Ants/insects: "Thanks for letting me know—ants can interfere with controls. Please avoid spraying chemicals into the unit before the technician arrives. We'll inspect on site."
- Icing: "Please switch the system off at the thermostat to let any ice melt before the visit."
- Flexible-all-day: "Great—I'll note you're flexible. The technician will call before heading your way."
- Not at home: "Do we have permission to access the outdoor unit? Any gate or pet notes?"
- Warranty: "I'll note model/serial for the technician; warranty eligibility will be confirmed on site."
- Reschedule: "I can move that for you. What new day works—morning or afternoon?"
- Irate: "I understand why you're upset, and I want to help. I can capture the issue, outline today's visit charges, and get you the earliest appointment."

# Output format (MUST be a single JSON object with these keys)
Return:
{
  "reply": "<what Joy should say, voice-ready, short sentences>",
  "slots": {
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
}

# Behavior
- Fill slots progressively; unknowns stay null.
- Never invent times or any prices beyond the two listed fees.
- If emergency == true, prioritize the emergency script and escalation.
`.trim();

    // === call OpenAI with JSON mode ===
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        response_format: { type: "json_object" }, // force JSON
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Caller: ${caller || "Unknown"}\n` +
              `Speech: ${speech}\n\n` +
              `Return JSON with { reply, slots } exactly as specified.`,
          },
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(502).json({ error: "OpenAI error", detail: text });
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content ?? "{}";

    // defensive parse + safe fallbacks so TTS never breaks
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {
        reply:
          "Sorry, I had trouble just now. Could you repeat that so I can help you book?",
        slots: { pricing_disclosed: false, emergency: false },
      };
    }

    if (typeof parsed.reply !== "string") {
      parsed.reply =
        "Thanks for calling. How can I help you with heating or cooling today?";
    }
    if (!parsed.slots || typeof parsed.slots !== "object") {
      parsed.slots = { pricing_disclosed: false, emergency: false };
    }

    // Back-compat: you can keep reading 'reply' only if you want.
    return res.status(200).json({
      reply: parsed.reply,
      slots: parsed.slots,
      model: "gpt-4o-mini",
      usage: data?.usage ?? null,
    });
  } catch (err) {
    console.error("chat handler error", err);
    return res.status(500).json({
      reply:
        "I'm having trouble right now. May I have a teammate call you right back?",
      slots: { emergency: false },
      error: "Server error",
      detail: err?.message ?? String(err),
    });
  }
}
