// pages/api/twilio-webhook.js
// Twilio Voice webhook: log caller + assistant turns to Supabase,
// call /api/chat for the reply, then Play ElevenLabs TTS.

import querystring from 'querystring';
import { getSupabaseAdmin } from '../../lib/supabase-admin';

export const config = { api: { bodyParser: false } };

function sendXml(res, twiml) {
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml);
}

function baseUrlFromReq(req) {
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

// log helper
async function logTurn({ supabase, caller, callSid, text, role, meta = {} }) {
  if (!text && !meta) return;
  const { error } = await supabase.from('call_transcripts').insert([{
    caller_phone: caller || null,
    text: (text ?? '').toString().slice(0, 5000),
    role,                   // 'caller' | 'assistant'
    call_sid: callSid || null,
    turn_index: Date.now(), // BIGINT friendly
    meta,
  }]);
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

  // parse Twilio form body
  let rawBody = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => (rawBody += chunk));
    req.on('end', resolve);
  });
  const body = querystring.parse(rawBody);

  const from = body.From || 'Unknown';
  const callSid = body.CallSid || null;
  const speech = body.SpeechResult || '';           // may be empty
  const baseUrl = baseUrlFromReq(req);
  const actionUrl = `${baseUrl}/api/twilio-webhook`;

  const supabase = getSupabaseAdmin();

  // First turn greeting (single intro as requested)
  if (!speech) {
    const intro =
      'Welcome to H.V.A.C Joy. To ensure the highest quality service, this call may be recorded and monitored. How can I help today?';

    const introUrl = ttsUrlAbsolute(baseUrl, intro);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${introUrl}</Play>
  <Pause length="1"/>
  <!-- Keep Joy fast, but let caller finish naturally -->
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US"/>
  <!-- If Twilio didn’t detect speech, politely reprompt once -->
  <Play>${ttsUrlAbsolute(baseUrl, "Sorry, I didn’t catch that. Could you repeat that?")}</Play>
  <Pause length="1"/>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US"/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
    return sendXml(res, twiml);
  }

  // we have caller speech → loop
  try {
    // log caller turn
    await logTurn({ supabase, caller: from, callSid, text: speech, role: 'caller' });

    // read last known slots from the most recent assistant turn, if any
    let lastSlots = {};
    try {
      const { data: lastTurns } = await supabase
        .from('call_transcripts')
        .select('role, meta, turn_index')
        .eq('call_sid', callSid)
        .order('turn_index', { ascending: false })
        .limit(5);
      const lastAssistant = (lastTurns || []).find(t => t.role === 'assistant');
      if (lastAssistant?.meta?.slots) lastSlots = lastAssistant.meta.slots;
    } catch (_) {}

    // call our chat brain with timeout
    const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS || '12000', 10);
    const t = withTimeout(CHAT_TIMEOUT_MS);

    let reply = 'One moment.';
    let slots = lastSlots;
    let done = false;
    let goodbye = null;

    try {
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
        if (typeof data?.done === 'boolean') done = data.done;
        if (typeof data?.goodbye === 'string') goodbye = data.goodbye;
      } else {
        const text = await resp?.text();
        console.error('Chat API error:', text);
        reply = "Thanks. I heard you. Give me just a moment.";
      }
    } catch (e) {
      console.error('Chat API error:', e);
      reply = "Thanks. I heard you. Give me just a moment.";
    }

    // log assistant turn (store merged slots so next turn won’t re-ask)
    await logTurn({
      supabase, caller: from, callSid, text: reply, role: 'assistant', meta: { slots, done, goodbye }
    });

    if (done) {
      const replyUrl = ttsUrlAbsolute(baseUrl, reply);
      const byeText = goodbye || "Thank you. You’re all set. We’ll call ahead. Goodbye.";
      const byeUrl = ttsUrlAbsolute(baseUrl, byeText);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${replyUrl}</Play>
  <Pause length="1"/>
  <Play>${byeUrl}</Play>
  <Hangup/>
</Response>`;
      return sendXml(res, twiml);
    }

    // continue loop — keep Joy quick (1s), but let caller finish naturally
    const replyUrl = ttsUrlAbsolute(baseUrl, reply);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${replyUrl}</Play>
  <Pause length="1"/>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US"/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
    return sendXml(res, twiml);
  } catch (err) {
    console.error('Webhook error:', err);
    const fallbackUrl = ttsUrlAbsolute(
      baseUrl,
      'Sorry, I ran into a problem. I will connect you to a live agent.'
    );
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${fallbackUrl}</Play>
  <Hangup/>
</Response>`;
    return sendXml(res, twiml);
  }
}
