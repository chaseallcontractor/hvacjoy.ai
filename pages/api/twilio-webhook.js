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

// Replace HVAC with H.V.A.C. so TTS pronounces it correctly.
function normalizeForTTS(s) {
  if (!s) return s;
  return s
    .replace(/\bHVAC\b/gi, 'H.V.A.C.')
    .replace(/\bHvac\b/g, 'H.V.A.C.');
}

// Simple detector for “problem” statements; triggers empathy injection.
const SYMPTOM_HINTS = [
  /no (cool|cooling|heat|heating)/i,
  /(blowing|blows) (hot|warm|cold)/i,
  /(not|won[’']?t) (work|turn on|start|run)/i,
  /broke|broken|down|leak|leaking|ice|icing|iced|smell|odor/i,
  /loud|noise|noisy|buzz|grind|rattle|bang/i,
  /thermostat.*(not|won[’']?t)/i,
  /error|fault|alarm|code/i,
];

function looksLikeAProblem(speech) {
  if (!speech) return false;
  return SYMPTOM_HINTS.some((re) => re.test(speech));
}

function ensureEmpathy(reply) {
  if (!reply) return reply;
  // If reply already empathetic, keep it; else prefix a short line.
  if (/(sorry|that’s|that's|understand|totally get)/i.test(reply)) return reply;
  return `I'm sorry you're dealing with that. ${reply}`;
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

      // 2) Ask your chat endpoint for the assistant reply (+ slots + done)
      let reply = "Thanks—one moment.";
      let slots = { pricing_disclosed: false, emergency: false };
      let done = false;
      let goodbye = null;

      try {
        // read last assistant meta.slots if available (helps avoid re-asking)
        const { data: lastTurns } = await supabase
          .from('call_transcripts')
          .select('role, meta, turn_index')
          .eq('call_sid', callSid)
          .order('turn_index', { ascending: false })
          .limit(3);

        const lastAssistant = (lastTurns || []).find(t => t.role === 'assistant');
        const lastSlots = lastAssistant?.meta?.slots || {};

        // timeout wrapper for /api/chat call
        const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS || '20000', 10);
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
          if (typeof data?.done === 'boolean') done = data.done;
          if (typeof data?.goodbye === 'string') goodbye = data.goodbye;
        } else {
          const text = await resp?.text();
          console.error('Chat API error:', text);
          reply = "Thanks. I captured that. Let’s keep going.";
        }
      } catch (e) {
        console.error('Chat API error:', e);
        reply = "Thanks. I heard you. Let’s keep going.";
      }

      // Inject empathy if caller described a problem
      let replyForTts = looksLikeAProblem(speech) ? ensureEmpathy(reply) : reply;
      // Normalize for TTS (H.V.A.C.)
      replyForTts = normalizeForTTS(replyForTts);

      // 3) Log assistant turn WITH meta.slots
      await logTurn({
        supabase,
        caller: from,
        callSid,
        text: replyForTts,
        role: 'assistant',
        meta: { slots, done, goodbye },
      });

      // 4) Build TwiML depending on whether we're finished
      if (done) {
        const replyUrl = ttsUrlAbsolute(baseUrl, replyForTts);
        const byeText =
          normalizeForTTS(
            goodbye ||
            "Thank you. You’re all set. We look forward to helping you. Goodbye."
          );
        const byeUrl = ttsUrlAbsolute(baseUrl, byeText);

        const twiml =
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${replyUrl}</Play>
  <Pause length="1"/>
  <Play>${byeUrl}</Play>
  <Hangup/>
</Response>`;

        return sendXml(res, twiml);
      }

      // Otherwise, continue the loop with 1-second pacing
      const replyUrl = ttsUrlAbsolute(baseUrl, replyForTts);

      const twiml =
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${replyUrl}</Play>
  <Pause length="1"/>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="1"/>
  <Pause length="1"/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;

      return sendXml(res, twiml);
    } catch (err) {
      console.error('Webhook error:', err);

      const fallbackUrl = ttsUrlAbsolute(
        baseUrl,
        normalizeForTTS('Sorry, I hit a snag. I will connect you to a teammate.')
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

  // FIRST TURN: Play Joy's intro ONCE at the start of the call.
const intro = 'Welcome to H.V.A.C. Joy. To ensure the highest quality service, this call may be recorded and monitored. How can I help today?';
const introUrl = ttsUrlAbsolute(baseUrl, normalizeForTTS(intro));

const twiml =
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="1">
    <Play>${introUrl}</Play>
  </Gather>
  <Pause length="1"/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;

return sendXml(res, twiml);

}

