import { insertCalendarEvent } from "../../lib/google-calendar";

function tomorrowAt(hh, mm = "00") {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const yyyy = d.getFullYear();
  const mm2 = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm2}-${dd}T${String(hh).padStart(2, "0")}:${mm}:00`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Use GET for the test" });
    }

    const startISO = tomorrowAt(9, "00");
    const endISO   = tomorrowAt(10, "00");

    const eventObject = {
      summary: "HVAC Joy – Test Booking",
      description: "Created by the /api/book smoke test route.",
      location: "Test Address",
      start: { dateTime: startISO, timeZone: process.env.DEFAULT_TZ || "America/New_York" },
      end:   { dateTime: endISO,   timeZone: process.env.DEFAULT_TZ || "America/New_York" },
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
    };

    const data = await insertCalendarEvent(process.env.GOOGLE_CALENDAR_ID, eventObject);
    return res.status(200).json({ ok: true, id: data.id, htmlLink: data.htmlLink });
  } catch (e) {
    const detail = e?.response?.data || e?.message || String(e);
    console.error("book error detail:", detail);
    return res.status(500).json({ ok: false, error: "Unexpected error", detail });
  }
}
