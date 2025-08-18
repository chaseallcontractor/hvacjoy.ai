// pages/api/twilio-webhook.js
// Twilio Voice webhook: Gather speech -> call /api/chat -> Play ElevenLabs reply
import querystring from 'querystring';

export const config = {
  api: { bodyParser: false }, // we read Twilio's raw form body ourselves
};

function sendXml(res, twiml) {
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml);
}

function baseUrlFromReq(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function ttsUrl(req, text) {
  const url = `${baseUrlFromReq(req)}/api/tts?text=${encodeURIComponent(text)}`;
  return url;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Parse Twilio x-www-form-urlencoded body
  let rawBody = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => (rawBody += chunk));
    req.on('end', resolve);
  });
  const body = querystring.parse(rawBody);

  const from = body.From || 'Unknown';
  const speech = body.SpeechResult || '';

  // If caller said something, get AI reply then Play it with ElevenLabs
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

      const audioUrl = ttsUrl(req, reply);

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Pause length="1"/>
  <Gather input="speech" action="/api/twilio-webhook" method="POST" speechTimeout="auto">
    <Play>${ttsUrl(req, 'Anything else I can help with?')}</Play>
  </Gather>
</Response>`;
      return sendXml(res, twiml);
    } catch (err) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl(req, 'Sorry, I ran into a problem. I will connect you to a live agent.')}</Play>
  <Hangup/>
</Response>`;
      return sendXml(res, twiml);
    }
  }

  // First turn: greet and start speech gather using ElevenLabs
  const greeting = 'Thanks for calling HVAC Joy. Please briefly describe your issue after the tone.';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/twilio-webhook" method="POST" speechTimeout="auto">
    <Play>${ttsUrl(req, greeting)}</Play>
  </Gather>
</Response>`;
  return sendXml(res, twiml);
}
