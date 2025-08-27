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
  // Prefer forwarded headers from Cloudflare/Render; default to https
  const protoHeader = req.headers['x-forwarded-proto'] || '';
  const proto = protoHeader.split(',')[0]?.trim() || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function ttsUrlAbsolute(baseUrl, text, voice) {
  const params = new URLSearchParams({ text });
  if (voice) params.set('voice', voice);
  return `${baseUrl}/api/tts?${params.toString()}`;
}

// small helper so we don't duplicate insert code
async function logTurn({ supabase, caller, callSid, text, role, meta = {} }) {
  if (!text) return;
  const { error } = await supabase.from('call_transcripts').insert([
    {
      caller_phone: caller || null,
      text: String(text).slice(0, 5000),
      role, // 'caller' | 'assistant'
      call_sid: callSid || null,
      turn_index: Date.now(), // bigint-friendly
      meta,
    },
  ]);
  if (error) console.error('Supabase insert failed:', error.message);
}

function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
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

  // Precompute absolute URLs
  const baseUrl = baseUrlFromReq(req);
  const actionUrl = `${baseUrl}/api/twilio-webhook`;

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

      // 2) Ask your chat endpoint for the assistant reply (+ slots)
      // We'll pass the *last known* slots from the most recent assistant turn
      // so the model avoids re-asking already-filled questions.
      let reply = "Thanks — one moment.";
      let slots = { pricing_disclosed: false, emergency: false };

      try {
        // read last assistant meta.slots if available
        const { data: lastTurns } = await supabase
          .from('call_transcripts')
          .select('role, meta, turn_index')
          .eq('call_sid', callSid)
          .order('turn_index', { ascending: false })
          .limit(3);

        const lastAssistant = (lastTurns || []).find(t => t.role === 'assistant');
        const lastSlots = lastAssistant?.meta?.slots || {};

        // timeout wrapper for /api/chat call
        const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS || '12000', 10);
        const t = withTimeout(CHAT_TIMEOUT_MS);

        const resp = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ caller: from, speech, callSid, lastSlots }),
          signal: t.signal,
        }).catch(e => { throw e; })
          .finally(() => t.cancel());

        if (resp?.ok) {
          const data = await resp.json();
          if (data?.reply) reply = String(data.reply);
          if (data && typeof data.slots === 'object') slots = data.slots;
        } else {
          const text = await resp?.text();
          console.error('Chat API error:', text);
          reply = "Thanks. I caught that. One moment while I get the next step.";
        }
      } catch (e) {
        console.error('Chat API error:', e);
        reply = "Thanks. I heard you. Give me just a moment.";
      }

      // 3) Log assistant turn WITH meta.slots
      await logTurn({
        supabase,
        caller: from,
        callSid,
        text: reply,
        role: 'assistant',
        meta: { slots },
      });

      // 4) Respond to the caller with ElevenLabs audio and gather next turn
      const replyUrl = ttsUrlAbsolute(baseUrl, reply);

      const twiml =
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${replyUrl}</Play>
  <Pause length="1"/>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="3"/>
  <Pause length="2"/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;

      return sendXml(res, twiml);
    } catch (err) {
      console.error('Webhook error:', err);

      const fallbackUrl = ttsUrlAbsolute(
        baseUrl,
        'Sorry, I ran into a problem. I will connect you to a live agent.'
      );

      const twiml =
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${fallbackUrl}</Play>
  <Hangup/>
</Response>`;

      return sendXml(res, twiml);
    }
  }

  // First turn greeting (play, then listen)
  const greeting = 'Thanks for calling HVAC Joy. Please briefly describe your issue after the tone.';
  const greetingUrl = ttsUrlAbsolute(baseUrl, greeting);

  const twiml =
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="3">
    <Play>${greetingUrl}</Play>
  </Gather>
  <Pause length="2"/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;

  return sendXml(res, twiml);
}
