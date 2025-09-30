// pages/api/twilio-webhook.js
import querystring from 'querystring';
import { getSupabaseAdmin } from '../../lib/supabase-admin';

export const config = { api: { bodyParser: false } };

// Voice + timezone (Georgia defaults to Eastern Time)
const SELECTED_VOICE = process.env.TTS_VOICE || null;
const DEFAULT_TZ = process.env.DEFAULT_TZ || 'America/New_York';

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

// Ensure the brand is pronounced like the intro everywhere it’s spoken.
function pronounceBrandForTTS(text = '') {
  if (!text) return text;
  return text.replace(/\bH\.?\s*V\.?\s*A\.?\s*C\.?\s+Joy\b/gi, 'H. V. A. C Joy');
}

function ttsUrlAbsolute(baseUrl, text, voice) {
  const spoken = pronounceBrandForTTS(text || '');
  const params = new URLSearchParams({ text: spoken });
  if (voice) params.set('voice', voice);
  return `${baseUrl}/api/tts?${params.toString()}`;
}

function formatPretty(dateISO, timeHHMM, tz = DEFAULT_TZ) {
  if (!dateISO) return '';
  const [y, m, d] = dateISO.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(anchor);
  const monthDay = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long', day: 'numeric' }).format(anchor);
  let timePart = null;
  if (timeHHMM) {
    const [hh, mm] = timeHHMM.split(':').map(Number);
    const h12 = ((hh % 12) || 12); const ampm = hh < 12 ? 'AM' : 'PM';
    timePart = `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
  }
  return timePart ? `${weekday}, ${monthDay} at ${timePart}` : `${weekday}, ${monthDay}`;
}

// ---------- DB logging ----------
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

// ---- robust extractor for the last question (even without "?")
function extractLastQuestionLine(text = '') {
  if (!text) return null;
  const trimmed = String(text).trim();
  const m = trimmed.match(/([^?]*\?)[^?]*$/);
  if (m) return m[1].trim();
  const patterns = [
    /(is|was)\s+(that|this)\s+(right|correct)\.?$/i,
    /(does|do)\s+that\s+work\.?$/i,
    /(would|will)\s+you\s+like\s+to\s+proceed\.?$/i,
    /(can|may)\s+we\s+proceed\.?$/i,
    /okay\s+to\s+proceed\.?$/i,
    /sound\s+good\.?$/i,
    /look\s+good\.?$/i,
    /call[- ]ahead\??$/i,
    /is\s+(this|that)\s+okay\.?$/i,
  ];
  for (const re of patterns) if (re.test(trimmed)) return trimmed;
  return null;
}

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
      if (row?.meta?.type === 'intro') continue;
      if (row?.meta?.last_question) return String(row.meta.last_question);
      const t = (row.text || '').trim();
      const q = extractLastQuestionLine(t);
      if (q) return q;
    }
  } catch (_) {}
  return null;
}

// ---------- “unclear” logic (fixed to accept yes/no with punctuation) ----------
function normalizeASR(s = '') {
  return String(s || '')
    .toLowerCase()
    .replace(/[“”"‘’]/g, '')      // smart quotes
    .replace(/[.!?,;:]/g, '')     // trailing punctuation
    .replace(/\s+/g, ' ')
    .trim();
}
function isAffirmationLite(s = '') {
  const t = normalizeASR(s);
  return /\b(yes|yep|yeah|yah|ya|yup|sure|ok|okay|correct|right|affirmative|uh huh|uh-huh|that(?:'|’)s (?:right|correct))\b/i.test(t);
}
function isNegationLite(s = '') {
  const t = normalizeASR(s);
  return /\b(no|nope|nah|negative|not (?:right|correct)|incorrect|wrong)\b/i.test(t);
}
function isYesNoLike(s = '') {
  return isAffirmationLite(s) || isNegationLite(s);
}
function isUnclear(text = '') {
  const t = normalizeASR(text);
  if (!t) return true;
  // ✅ Treat any yes/no (with punctuation/noise stripped) as clear
  if (isYesNoLike(t)) return false;
  if (t.length <= 2) return true;
  if (/\b(play|he told|audio|uh|umm?|hmm?)\b/.test(t)) return true;
  return false;
}

function userSaysWeAreScheduling(text = '') {
  return /\b(scheduling|schedule|book|at the end|ready to book|set (it|this) up)\b/i.test(text || '');
}

// ---------- Call-ahead helpers ----------
function makeGoodbyeFromSlots(slots = {}) {
  const firstName = (slots.full_name || '').split(' ')[0] || '';
  const pretty = formatPretty(slots.preferred_date, slots.preferred_time || null, DEFAULT_TZ);
  const when = pretty ? ` on ${pretty}` : '';
  const nameBit = firstName ? `, ${firstName}` : '';
  const callAheadBit = (slots.call_ahead === false) ? ' We will arrive within your window without a call-ahead.' : ' We will call ahead before arriving.';
  const confirmNote = ' A member of our team will contact you to confirm the appointment.';
  return `Thank you${nameBit}. You’re scheduled${when}.${callAheadBit}${confirmNote} Thank you for calling Smith Heating & Air. Good Bye.`;
}

function normalizeCallAheadInText(text = '', slots = {}) {
  if (slots.call_ahead === false) {
    return text.replace(/(you'?ll|we will|we’ll).*call[- ]ahead.*?(?=\.|$)/gi, 'You are set in the selected arrival window');
  }
  return text;
}

// ---------- Sympathy helpers ----------
const PROBLEM_RE = /(no\s+(cool|cold|heat|air|airflow)|not\s+(cooling|cold|heating|working)|(not\s+(?:blow|blowing)\s+(?:cold|cool)|no\s+(?:cold|cool)\s+air)|won'?t\s+(turn\s*on|start|cool|heat|blow)|stopp?ed\s+(working|cooling|heating)|(ac|a\.?c\.?|unit|system|hvac).*(broke|broken|out|down|leak|leaking|smell|odor|noise|noisy|rattle|buzz|ice|iced|frozen)|(problem|issue|trouble)\s+(with|in|on)\s+(my\s+)?(ac|a\.?c\.?|unit|system|hvac)|\bvery\s+(hot|cold)\b|burning up|freezing)/i;
function detectedProblem(text = '') {
  const t = (text || '').toLowerCase();
  if (/\bno problem\b/.test(t)) return false;
  return PROBLEM_RE.test(t);
}
function maybeAddEmpathyOnFallback(userText, reply) {
  if (detectedProblem(userText) && !/sorry|apologiz/i.test(reply)) {
    return `I’m sorry to hear that. ${reply}`;
  }
  return reply;
}

// Common <Gather> attributes (added lots of “yes” variants)
function gatherAttrs(actionUrl) {
  return `input="speech" action="${actionUrl}" method="POST" language="en-US" speechTimeout="auto" hints="yes, yeah, ya, yup, correct, that is correct, that’s correct, no, nope, not correct, incorrect, looks good, sounds good, proceed, continue, move on, next, skip, go ahead, morning, afternoon, street, drive, road, avenue, boulevard, lane, court, way, walk, trail, circle, parkway, pkwy, place, terrace, point, loop, run, Dallas, Kennesaw, Georgia, GA, zip, zero one two three four five six seven eight nine, oh, o, A through Z" profanityFilter="false"`;
}

// ---------- Handler ----------
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
  const speech = body.SpeechResult || '';
  const baseUrl = baseUrlFromReq(req);
  const actionUrl = `${baseUrl}/api/twilio-webhook`;

  if (!callSid) console.warn('Twilio webhook without CallSid; suppressing intro replay.');

  const supabase = getSupabaseAdmin();
  const introPlayed = await introAlreadyPlayed(supabase, callSid);

  // 🔧 First/noisy turn handling — do NOT intercept clear yes/no anymore
  if ((!speech || (isUnclear(speech) && !isYesNoLike(speech))) && !userSaysWeAreScheduling(speech)) {
    if (!introPlayed) {
      const introDisplay =
        'Welcome to H.V.A.C Joy. To ensure the highest quality service, this call may be recorded and monitored. How can I help today?';

      await logTurn({ supabase, caller: from, callSid, text: introDisplay, role: 'assistant', meta: { type: 'intro' } });

      const welcome = 'Welcome to Smith Heating & Air. I am your digital assistant Joy. To ensure the highest quality service, this call may be recorded and monitored. How can I help today?';
      const welcomeUrl = ttsUrlAbsolute(baseUrl, welcome, SELECTED_VOICE);
      const didntCatchUrl = ttsUrlAbsolute(baseUrl, 'Sorry, I didn’t catch that. Please say the full service address—street, city, and zip.', SELECTED_VOICE);

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${welcomeUrl}</Play>
  <Pause length="1"/>
  <Gather ${gatherAttrs(actionUrl)}/>
  <Play>${didntCatchUrl}</Play>
  <Pause length="1"/>
  <Gather ${gatherAttrs(actionUrl)}/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
      return sendXml(res, twiml);
    } else {
      const lastQ = await getLastAssistantQuestion(supabase, callSid);
      const prompt = lastQ || 'Sorry, I didn’t catch that. Could you please repeat that?';
      const url = ttsUrlAbsolute(baseUrl, prompt, SELECTED_VOICE);
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${url}</Play>
  <Pause length="1"/>
  <Gather ${gatherAttrs(actionUrl)}/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
      return sendXml(res, twiml);
    }
  }

  // Normal loop
  try {
    await logTurn({ supabase, caller: from, callSid, text: speech, role: 'caller' });

    let lastSlots = {};
    let lastQuestion = null;
    try {
      const { data: lastTurns } = await supabase
        .from('call_transcripts')
        .select('role, meta, text, turn_index')
        .eq('call_sid', callSid)
        .order('turn_index', { ascending: false })
        .limit(40);

      const lastAssistantWithSlots = (lastTurns || []).find(
        t => t.role === 'assistant' && t?.meta?.slots && Object.keys(t.meta.slots || {}).length > 0
      );
      if (lastAssistantWithSlots?.meta?.slots) lastSlots = lastAssistantWithSlots.meta.slots;

      const lastAssistantWithQMeta = (lastTurns || []).find(
        t => t.role === 'assistant' && t?.meta?.last_question && t?.meta?.type !== 'intro'
      );
      if (lastAssistantWithQMeta) {
        lastQuestion = String(lastAssistantWithQMeta.meta.last_question);
      } else {
        const qRow = (lastTurns || []).find(
          t => t.role === 'assistant' && t?.meta?.type !== 'intro' && extractLastQuestionLine((t.text || '').trim())
        );
        if (qRow) lastQuestion = extractLastQuestionLine((qRow.text || '').trim());
      }
    } catch (_) {}

    const CHAT_TIMEOUT_MS = parseInt(process.env.CHAT_TIMEOUT_MS || '12000', 10);
    const controller = withTimeout(CHAT_TIMEOUT_MS);

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
        signal: controller.signal,
      }).catch(e => { throw e; })
        .finally(() => controller.cancel());

      if (resp?.ok) {
        const data = await resp.json();
        if (data?.reply !== undefined) reply = String(data.reply || '');
        if (data && typeof data.slots === 'object') slots = data.slots;
        if (typeof data?.done === 'boolean') done = data.done;
        if (typeof data?.goodbye === 'string') goodbye = data.goodbye;
        if (typeof data?.needs_confirmation === 'boolean') needs_confirmation = data.needs_confirmation;
      } else {
        const text = await resp?.text();
        console.error('Chat API error:', text);
        const reask = lastQuestion || "Sorry, I didn’t catch that. Could you please repeat that?";
        reply = maybeAddEmpathyOnFallback(speech, reask);
      }
    } catch (e) {
      console.error('Chat API error:', e);
      const reask = lastQuestion || "Sorry, I didn’t catch that. Could you please repeat that?";
      reply = maybeAddEmpathyOnFallback(speech, reask);
    }

    // respect call-ahead preference in any generated line
    reply = normalizeCallAheadInText(reply, slots);

    const meta = { slots, done, goodbye };
    const trimmed = (reply || '').trim();
    const lastQForMeta = extractLastQuestionLine(trimmed);
    if (lastQForMeta) meta.last_question = lastQForMeta;

    await logTurn({ supabase, caller: from, callSid, text: reply, role: 'assistant', meta });

    if (done) {
      const byeText = (goodbye && goodbye.trim()) ? goodbye : makeGoodbyeFromSlots(slots);
      const parts = [];
      parts.push('<?xml version="1.0" encoding="UTF-8"?>');
      parts.push('<Response>');
      if (trimmed) {
        const replyUrl = ttsUrlAbsolute(baseUrl, reply, SELECTED_VOICE);
        parts.push(`  <Play>${replyUrl}</Play>`);
        parts.push('  <Pause length="1"/>');
      }
      const byeUrl = ttsUrlAbsolute(baseUrl, byeText, SELECTED_VOICE);
      parts.push(`  <Play>${byeUrl}</Play>`);
      parts.push('  <Hangup/>');
      parts.push('</Response>');
      return sendXml(res, parts.join('\n'));
    }

    const replyUrl = ttsUrlAbsolute(baseUrl, reply, SELECTED_VOICE);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${replyUrl}</Play>
  <Pause length="1"/>
  <Gather ${gatherAttrs(actionUrl)}/>
  <Redirect method="POST">${actionUrl}</Redirect>
</Response>`;
    return sendXml(res, twiml);
  } catch (err) {
    console.error('Webhook error:', err);
    const fallbackUrl = ttsUrlAbsolute(baseUrl, 'Sorry, I ran into a problem. I will connect you to a live agent.', SELECTED_VOICE);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${fallbackUrl}</Play>
  <Hangup/>
</Response>`;
    return sendXml(res, twiml);
  }
}
