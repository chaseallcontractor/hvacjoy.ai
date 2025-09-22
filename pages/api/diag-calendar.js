// pages/api/diag-calendar.js
import { google } from "googleapis";

export default async function handler(req, res) {
  try {
    const json = Buffer.from(process.env.GOOGLE_SA_JSON_BASE64, "base64").toString("utf8");
    const creds = JSON.parse(json);

    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    });

    const calendar = google.calendar({ version: "v3", auth });

    // List calendars this service account can see
    const { data } = await calendar.calendarList.list();
    const items = (data.items || []).map(c => ({ id: c.id, summary: c.summary, accessRole: c.accessRole }));

    return res.status(200).json({
      ok: true,
      serviceAccount: creds.client_email,
      calendarsVisible: items,
      expectCalendarId: process.env.GOOGLE_CALENDAR_ID,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}
