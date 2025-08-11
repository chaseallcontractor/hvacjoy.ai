// pages/api/twilio-webhook.js
// Twilio Voice webhook: Gather speech -> call /api/chat -> speak reply
import querystring from 'querystring';

export const config = {
  api: { bodyParser: false }, // Disable Next.js default parser for raw Twilio form data
};

function sendXml(res, twiml) {
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml);
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function baseUrlFromReq(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host;
  return `${proto}://${host}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Manually read and parse Twilio's x-www-form-urlencoded body
  let rawBody = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => (rawBody += chunk));
    req.on('end', resolve);
  });
  const body = querystring.parse(rawBody);

  const from = body.From || 'Unknown';
  const speech = body.SpeechResult || '';

  // If we have caller speech, send it to /api/chat
  if (speech) {
    try {
      const resp = await fetch(`${baseUrlFromReq(req)}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caller: from, speech }),
      });

      let reply = "I'm here to help with HVAC questions and scheduling.";
      if (resp.ok) {
        const data = await resp.json();
        if (data?.reply) reply = String(data.reply);
      }

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${escapeXml(reply)}</Say>
  <Pause length="1"/>
  <Gather input="speech" action="/api/twilio-webhook" method="POST" speechTimeout="auto">
    <Say voice="Polly.Joanna">Anything else I can help with?</Say>
  </Gather>
</Response>`;
      return sendXml(res, twiml);
    } catch (err) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Sorry, I ran into a problem. I will connect you to a live agent.</Say>
  <Hangup/>
</Response>`;
      return sendXml(res, twiml);
    }
  }

  // First turn: greet caller and start speech gather
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thanks for calling HVAC Joy. Please briefly describe your issue after the tone.</Say>
  <Gather input="speech" action="/api/twilio-webhook" method="POST" speechTimeout="auto"/>
</Response>`;
  return sendXml(res, twiml);
}
