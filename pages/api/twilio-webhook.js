// pages/api/twilio-webhook.js
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

// ======================== Helpers =========================================

// Insert a transcript row
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

// Detect if we've already played/logged the intro
async function introAlreadyPlayed(supabase, callSid) {
  if (!callSid) return false;
  try {
    const { data } = await supabase
      .from('call_transcripts')
      .select('role, meta, text')
      .eq('call_sid', callSid)
      .order('turn_index', { ascending: false })
      .limit(20);

    for (const row of (data || [])) {
      if (row.role === 'assistant') {
        if (row?.meta?.type === 'intro') return true;
        const t = (row.text || '').toLowerCase();
        if (t.includes('welcome to h.v.a.c joy')) return true; // fallback
      }
    }
  } catch (_) {}
  return false;
}

// Get the last assistant question text (ends with "?") or saved meta.last_question
async function getLastAssistantQuestion(supabase, callSid) {
  try {
    const { data } = await supabase
      .from('call_transcripts')
      .select('role, text, meta, turn_index')
      .eq('call_sid', callSid)
      .order('turn_index', { ascending: false })
      .limit(12);

    for (const row of (data || [])) {
      if (row.role !== 'assistant') continue;
      if (row?.meta?.last_question) return String(row.meta.last_question);
      const t = (row.text || '').trim();
      if (t.endsWith('?')) return t;
    }
  } catch (_) {}
  return null;
}

// Treat obviously noisy STT as “not understood”
function isUnclear(text = '') {
  const t = (text || '').trim().toLowerCase();
  if (!t) return true;                 // silence
  if (t.length <= 2) return true;      // very short grunts
  if (/\b(play|he told|audio|uh|umm?|hmm?)\b/.test(t)) return true;
  return false;
}

// Build a slot-aware goodbye (respect call_ahead)
function makeGoodbyeFromSlots(slots = {}) {
  const firstName = (slots.full_name || '').split(' ')[0] || '';
  const date = slots.preferred_date ? String(slots.preferred_date) : '';
  const window = slots.preferred_window ? ` in the ${slots.preferred_window} window` : '';
  const when = date ? ` on ${date}${window}` : (window || '');
  const nameBit = firstName ? `, ${firstName}` : '';
  const callAheadBit = (slots.call_ahead === false)
    ? ' We will arrive within your window without a call-ahead.'
    : ' We will call ahead before arriving.';
  return `Thank you${nameBit}. You’re scheduled${when}.${callAheadBit} Goodbye.`;
}

// If the model's confirmation promises a call-ahead but slot says no, normalize it
function normalizeCallAheadInText(text = '', slots = {}) {
  if (slots.call_ahead === false) {
    return text.replace(/(you'?ll|we will|we’ll).*call[- ]ahead.*?(?=\.|$)/gi,
      'You are set in the selected arrival window');
  }
  return text;
}

// ======================== Handler =========================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Parse Twilio form body
  let rawBody = '';
  await new Promise((resolve) => {
    req.on('data', (chunk) => (rawBody += chunk));
    req.on('end', resolve);
  });
  const body = querystring.parse(rawBody);

  const from = body.From || 'Unknown';
  const callSid = body.CallSid || null;
  const speech = body.SpeechResult || ''; // may be empty
  const baseUrl = baseUrlFromReq(req);
  const actionUrl = `${baseUrl}/api/twilio-webhook`;

  const supabase = getSupabaseAdmin();

  // ===== GREETING vs REPROMPT vs RE-ASK SAME QUESTION ======================

  const introPlayed = await introAlreadyPlayed(supabase, callSid);

  // If nothing meaningful was heard
  if (!speech || isUnclear(speech)) {
    if (!introPlayed) {
      // TRUE FIRST TURN → greet once, and LOG it so the chat side knows
      const intro =
        'Welcome to H.V.A.C Joy. To ensure the highest quality service, this call may be recorded and monitored. How can I help today?';
      await logTurn({ supabase, caller: from, callSid, text: intro, role: 'assistant', meta: { type: 'intro' } });
      const introUrl = ttsUrlAbsolute(baseUrl, intro);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${introUrl}</Play>
  <Pause length="1"/>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US"/>
  <Play>${ttsUrlAbsolute(baseUrl, "Sorry, I didn’t catch that. Could you repeat that?")}</Play>
  <Pause length="1"/>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US"/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
      return sendXml(res, twiml);
    } else {
      // MID-CALL UNCLEAR → re-ask the same question (NOT the greeting)
      const lastQ = await getLastAssistantQuestion(supabase, callSid);
      const prompt = lastQ || 'Sorry, I didn’t catch that. Could you please repeat that?';
      const url = ttsUrlAbsolute(baseUrl, prompt);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${url}</Play>
  <Pause length="1"/>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US"/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
      return sendXml(res, twiml);
    }
  }

  // ===== We have caller speech → normal loop ===============================

  try {
    // log caller turn
    await logTurn({ supabase, caller: from, callSid, text: speech, role: 'caller' });

    // read last known slots & last question from the most recent assistant turn
    let lastSlots = {};
    let lastQuestion = null;
    try {
      const { data: lastTurns } = await supabase
        .from('call_transcripts')
        .select('role, meta, text, turn_index')
        .eq('call_sid', callSid)
        .order('turn_index', { ascending: false })
        .limit(6);

      const lastAssistant = (lastTurns || []).find(t => t.role === 'assistant');
      if (lastAssistant?.meta?.slots) lastSlots = lastAssistant.meta.slots;
      if (lastAssistant?.meta?.last_question) lastQuestion = lastAssistant.meta.last_question;
      else if ((lastAssistant?.text || '').trim().endsWith('?')) lastQuestion = (lastAssistant.text || '').trim();
    } catch (_) {}

    // call our chat brain with timeout
    const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS || '12000', 10);
    const t = withTimeout(CHAT_TIMEOUT_MS);

    let reply = 'One moment.';
    let slots = lastSlots;
    let done = false;
    let goodbye = null;
    let needs_confirmation = false;

    try {
      const resp = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caller: from, speech, callSid, lastSlots, lastQuestion }),
        signal: t.signal,
      }).catch(e => { throw e; })
        .finally(() => t.cancel());

      if (resp?.ok) {
        const data = await resp.json();
        if (data?.reply) reply = String(data.reply);
        if (data && typeof data.slots === 'object') slots = data.slots;
        if (typeof data?.done === 'boolean') done = data.done;
        if (typeof data?.goodbye === 'string') goodbye = data.goodbye;
        if (typeof data?.needs_confirmation === 'boolean') needs_confirmation = data.needs_confirmation;
      } else {
        const text = await resp?.text();
        console.error('Chat API error:', text);
        reply = "Thanks. I heard you. Give me just a moment.";
      }
    } catch (e) {
      console.error('Chat API error:', e);
      reply = "Thanks. I heard you. Give me just a moment.";
    }

    // If the model's confirmation contradicts call_ahead=false, normalize
    reply = normalizeCallAheadInText(reply, slots);

    // log assistant turn; save last_question if this reply ends with "?"
    const meta = { slots, done, goodbye };
    const trimmed = (reply || '').trim();
    if (trimmed.endsWith('?')) meta.last_question = trimmed;

    await logTurn({
      supabase, caller: from, callSid, text: reply, role: 'assistant', meta
    });

    // Finish or keep gathering
    if (done) {
      const replyUrl = ttsUrlAbsolute(baseUrl, reply);
      const byeText = (goodbye && goodbye.trim()) ? goodbye : makeGoodbyeFromSlots(slots);
      const byeUrl = ttsUrlAbsolute(baseUrl, byeText);

      if (needs_confirmation) {
        // Ask and wait for a final yes/correction
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${replyUrl}</Play>
  <Pause length="1"/>
  <Gather input="speech" action="${actionUrl}" method="POST" speechTimeout="auto" language="en-US"/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
        return sendXml(res, twiml);
      } else {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${replyUrl}</Play>
  <Pause length="1"/>
  <Play>${byeUrl}</Play>
  <Hangup/>
</Response>`;
        return sendXml(res, twiml);
      }
    }

    // continue loop
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
