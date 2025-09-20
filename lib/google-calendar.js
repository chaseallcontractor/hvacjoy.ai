// lib/google-calendar.js
import { google } from 'googleapis';

// Build a fresh JWT client at runtime
function getServiceAccountJWT() {
  const b64 = process.env.GOOGLE_SA_JSON_BASE64;
  if (!b64) {
    throw new Error('GOOGLE_SA_JSON_BASE64 is not set');
  }

  let json;
  try {
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    json = JSON.parse(decoded);
  } catch (e) {
    throw new Error('GOOGLE_SA_JSON_BASE64 is not valid base64 JSON');
  }

  const privateKey =
    (json.private_key || '').includes('\\n')
      ? json.private_key.replace(/\\n/g, '\n')
      : json.private_key;

  return new google.auth.JWT({
    email: json.client_email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
}

/**
 * Insert a Google Calendar event
 * @param {string} calendarId - e.g. "...@group.calendar.google.com"
 * @param {object} eventObject - Calendar v3 event resource
 */
export async function insertCalendarEvent(calendarId, eventObject) {
  if (!calendarId) throw new Error('calendarId is required');

  const auth = getServiceAccountJWT();
  await auth.authorize();

  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.insert({
    calendarId,
    requestBody: eventObject,
    supportsAttachments: false,
  });

  return res.data; // contains id, htmlLink, etc.
}
