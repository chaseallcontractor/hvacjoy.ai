// pages/api/twilio-webhook.js
// Twilio Voice webhook: logs turns to Supabase, calls /api/chat for reply,
// plays ElevenLabs TTS, and loops. Handles first-turn intro + no-speech nudges.

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

// Ensure “H.V.A.C.”, brand spellings, etc. come out right in TTS.
function normalizeForTTS(s) {
  return String(s || '')
    .replace(/\bHVAC\b/gi, 'H.V.A.C.') // spell out HVAC
    .replace(/\bA\/C\b/gi, 'A C');     // common cleanup for A/C
}

function ttsUrlAbsolute(baseUrl, text, voice) {
  const params = new URLSearchParams({ text: normalizeForTTS(text) });
  if (voice) params.set('voice', voice);
  return `${baseUrl}/api/tts?${params.toString()}`;
}

// Small helper so we don't duplicate insert code
async function logTurn({ supabase, caller, callSid, text, role, meta = {} }) {
  if (!text) return;
  const { error } = await supabase.from('call_transcripts').insert([{
    caller_phone: caller || null,
    text: String(text).slice(0, 5000),
    role, // 'caller' | 'assistant'
    call_sid: callSid || null,
    turn_index: Date.now(), // bigint-friendly
    meta,
  }]);
  if (error) console.error('Supabase insert failed:', error.message);
}

function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

// Pick the next question from the last known slots when caller is silent
function nextQuestionFromSlots(slots = {}) {
  const addr = slots.service_address || {};
  if (!slots.full_name) return "May I have your full name, please?";
  if (!addr.line1 || !addr.city || !addr.state || !addr.zip)
    return "What is the street address, city, state, and zip code for the visit?";
  if (!slots.callback_number) return "What’s the best callback number if we get disconnected?";
  if (slots.unit_count == null) return "How many H.V.A.C. systems are affected, and where are they located?";
  if (!slots.brand) return "Do you happen to know the brand of the system?";
  if (!Array.isArray(slots.symptoms) || slots.symptoms.length === 0)
    return "What symptoms are you noticing—no cooling, weak airflow, noises, or icing?";
  const th = slots.thermostat || {};
  if (th.setpoint == null || th.current == null)
    return "What is the thermostat setpoint, and what does it read right now?";
  if (slots.pricing_disclosed !== true)
    return "Our diagnostic visit is $50 per non-working unit. Shall I proceed with scheduling?";
  if (!slots.preferred_date && !slots.preferred_window)
    return "What day works for you, and do you prefer morning, afternoon, or flexible-all-day?";
  return "Is there anything else I should note—gate codes, pets, or parking notes?";
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

  const baseUrl = baseUrlFromReq(req);
  const actionUrl = `${baseUrl}/api/twilio-webhook`;

  const supabase = getSupabaseAdmin();

  // If caller spoke, log it, get the AI reply, log it, and respond with TTS
  if (speech) {
    try {
      await logTurn({ supabase, caller: from, callSid, text: speech, role: 'caller' });

      let reply = "Thanks — one moment.";
      let slots = { pricing_disclosed: false, emergency: false };
      let done = false;
      let goodbye = null;

      try {
        // Read last assistant slots to help /api/chat avoid re-asking
        const { data: lastTurns } = await supabase
          .from('call_transcripts')
          .select('role, meta, turn_index')
          .eq('call_sid', callSid)
          .order('turn_index', { ascending: false })
          .limit(3);

        const lastAssistant = (lastTurns || []).find(t => t.role === 'assistant');
        const lastSlots = lastAssistant?.meta?.slots || {};

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
          if (typeof data?.done === 'boolean') done = data.done;
          if (typeof data?.goodbye === 'string') goodbye = data.goodbye;
        } else {
          const txt = await resp?.text();
          console.error('Chat API error:', txt);
          reply = "Thanks. I caught that. One moment while I get the next step.";
        }
      } catch (e) {
        console.error('Chat API error:', e);
        reply = "Thanks. I heard you. Give me just a moment.";
      }

      await logTurn({ supabase, caller: from, callSid, text: reply, role: 'assistant', meta: { slots, done, goodbye } });

      if (done) {
        const replyUrl = ttsUrlAbsolute(baseUrl, reply);
        const byeText = goodbye || "Thank you. You’re all set. We look forward to helping you. Goodbye.";
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

      const replyUrl = ttsUrlAbsolute(baseUrl, reply);
      const twiml =
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${replyUrl}</Play>
  <Pause length="1"/>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto"/>
  <Pause length="1"/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
      return sendXml(res, twiml);
    } catch (err) {
      console.error('Webhook error:', err);
      const fallbackUrl = ttsUrlAbsolute(baseUrl, 'Sorry, I ran into a problem. I will connect you to a live agent.');
      const twiml =
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${fallbackUrl}</Play>
  <Hangup/>
</Response>`;
      return sendXml(res, twiml);
    }
  }

  // No speech received this turn -> nudge, not the intro (unless this is the very first turn)
  let hasHistory = false;
  try {
    const { count } = await supabase
      .from('call_transcripts')
      .select('id', { count: 'exact', head: true })
      .eq('call_sid', callSid);
    hasHistory = (count || 0) > 0;
  } catch {
    hasHistory = false;
  }

  if (!hasHistory) {
    // FIRST TURN: play the single intro
    const intro = 'Welcome to H.V.A.C. Joy. To ensure the highest quality service, this call may be recorded and monitored. How can I help today?';
    const introUrl = ttsUrlAbsolute(baseUrl, intro);
    const twiml =
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto">
    <Play>${introUrl}</Play>
  </Gather>
  <Pause length="1"/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
    return sendXml(res, twiml);
  }

  // Later turn but silence: ask the next missing detail using last saved slots
  let lastSlots = {};
  try {
    const { data } = await supabase
      .from('call_transcripts')
      .select('role, meta, turn_index')
      .eq('call_sid', callSid)
      .order('turn_index', { ascending: false })
      .limit(5);
    const lastAssistant = (data || []).find(r => r.role === 'assistant');
    lastSlots = lastAssistant?.meta?.slots || {};
  } catch {}

  const nudge = nextQuestionFromSlots(lastSlots);
  const nudgeUrl = ttsUrlAbsolute(baseUrl, nudge);
  const twiml =
`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${nudgeUrl}</Play>
  <Pause length="1"/>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto"/>
  <Pause length="1"/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
  return sendXml(res, twiml);
}
