// pages/api/diag-calendar.js
import { google } from "googleapis";

export default async function handler(req, res) {
  try {
    const json = Buffer.from(process.env.GOOGLE_SA_JSON_BASE64, "base64").toString("utf8");
    const creds = JSON.parse(json);

    // Normalize private_key newlines if they were stored as '\n'
    const privateKey =
      (creds.private_key || '').includes('\\n')
        ? creds.private_key.replace(/\\n/g, '\n')
        : creds.private_key;

    // Read-only on purpose: this is a diagnostics endpoint
    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: privateKey,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });

    const calendar = google.calendar({ version: "v3", auth });

    // List calendars this service account can see
    const { data } = await calendar.calendarList.list();
    const items = (data.items || []).map(c => ({
      id: c.id,
      summary: c.summary,
      accessRole: c.accessRole,
      timeZone: c.timeZone || null,
    }));

    // Try to read a few upcoming events from the configured calendar (if provided)
    const calendarId = process.env.GOOGLE_CALENDAR_ID || null;
    let upcoming = [];
    let calendarCheck = null;

    if (calendarId) {
      try {
        // confirm we can see this calendar
        const calMeta = await calendar.calendars.get({ calendarId });
        calendarCheck = {
          id: calMeta.data.id,
          summary: calMeta.data.summary,
          timeZone: calMeta.data.timeZone || null,
        };

        // list next 5 events
        const nowISO = new Date().toISOString();
        const ev = await calendar.events.list({
          calendarId,
          timeMin: nowISO,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 5,
        });

        upcoming = (ev.data.items || []).map(e => ({
          id: e.id,
          summary: e.summary || "(no title)",
          start: e.start?.dateTime || e.start?.date || null,
          end: e.end?.dateTime || e.end?.date || null,
          location: e.location || null,
        }));
      } catch (err) {
        calendarCheck = { error: err.message };
      }
    }

    return res.status(200).json({
      ok: true,
      serviceAccount: creds.client_email,
      defaultTimeZone: process.env.DEFAULT_TZ || "America/New_York",
      calendarsVisible: items,
      expectCalendarId: calendarId,
      calendarCheck,
      upcoming,
      notes: [
        "Share your target Google Calendar with the service account email above (Make changes to events) for booking.",
        "This endpoint uses read-only scope intentionally; writing happens via your insertCalendarEvent() helper with a write scope.",
      ],
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}
