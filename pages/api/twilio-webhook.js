// pages/api/twilio-webhook.js
// Twilio Voice webhook: log caller + assistant turns to Supabase,
// call /api/chat for the reply, then Play ElevenLabs TTS.

import querystring from 'querystring';
import { getSupabaseAdmin } from '../../lib/supabase-admin';

export const config = {
  api: { bodyParser: false },
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
  return `${baseUrlFromReq(req)}/api/tts?text=${encodeURIComponent(text)}`;
}

// small helper so we don't duplicate insert code
async function logTurn({ supabase, caller, callSid, text, role }) {
  if (!text) return;
  const { error } = await supabase.from('call_transcripts').insert([
    {
      caller_phone: caller || null,
      text: String(text).slice(0, 5000), // safety
      role,                               // 'caller' | 'assistant'
      call_sid: callSid || null,
      // quick ordering; you can switch to a proper counter later if you want
      turn_index: Date.now(),
      meta: {},
    },
  ]);
  if (error) console.error('Supabase insert failed:', error.message);
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
  const callSid = body.CallSid || null;
  const speech = body.SpeechResult || '';

  // If caller spoke, log it, get the AI reply, log it, and respond with TTS
  if (speech) {
    try {
      const supabase = getSupabaseAdmin();

      // 1) Log caller turn
      await logTurn({
        supabase,
        caller: from,
        callSid,
        text: speech,
        role: 'caller',
      });

      // 2) Ask your chat endpoint for the assistant reply
      let reply = "I'm here to help with HVAC questions and scheduling.";
      try {
        const resp = await fetch(`${baseUrlFromReq(req)}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ caller: from, speech }),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data?.reply) reply = String(data.reply);
        }
      } catch (e) {
        console.error('Chat API error:', e);
      }

      // 3) Log assistant turn
      await logTurn({
        supabase,
        caller: from,
        callSid,
        text: reply,
        role: 'assistant',
      });

      // 4) Respond to the caller with ElevenLabs audio
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl(req, reply)}</Play>
  <Pause length="1"/>
  <Gather input="speech" action="/api/twilio-webhook" method="POST" speechTimeout="auto">
    <Play>${ttsUrl(req, 'Anything else I can help with?')}</Play>
  </Gather>
</Response>`;
      return sendXml(res, twiml);
    } catch (err) {
      console.error('Webhook error:', err);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${ttsUrl(req, 'Sorry, I ran into a problem. I will connect you to a live agent.')}</Play>
  <Hangup/>
</Response>`;
      return sendXml(res, twiml);
    }
  }

  // First turn greeting
  const greeting =
    'Thanks for calling HVAC Joy. Please briefly describe your issue after the tone.';
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/twilio-webhook" method="POST" speechTimeout="auto">
    <Play>${ttsUrl(req, greeting)}</Play>
  </Gather>
</Response>`;
  return sendXml(res, twiml);
}
