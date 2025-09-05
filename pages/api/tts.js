// pages/api/tts.js
// Proxies ElevenLabs TTS and returns an MP3 Twilio can <Play>

export const config = {
  api: {
    responseLimit: false, // allow binary/audio
    bodyParser: false,    // not posting JSON here; we read query only
  },
};

// Prefer the standardized names, but support legacy ones for compatibility
const ELEVEN_KEY =
  process.env.ELEVEN_API_KEY ||
  process.env.ELEVEN_LABS_API_KEY || // legacy
  '';

const DEFAULT_VOICE_ID =
  process.env.ELEVEN_VOICE_ID ||
  process.env.ELEVENLABS_VOICE_ID || // legacy
  process.env.TTS_VOICE || // optional global override
  '';

function pickVoiceId(req) {
  // Accept both ?voice= and ?voiceId=
  const qp = req.query || {};
  const qVoice = (qp.voice ?? qp.voiceId ?? '').toString().trim();
  return qVoice || DEFAULT_VOICE_ID;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // text from query; cap length to keep latency reasonable
    const text = (req.query?.text ?? '').toString().slice(0, 1200);
    const voiceId = pickVoiceId(req);

    if (!text || !voiceId || !ELEVEN_KEY) {
      return res.status(400).json({
        error: 'Missing text, voiceId, or API key',
        have: {
          text: Boolean(text),
          voiceId: Boolean(voiceId),
          apiKey: Boolean(ELEVEN_KEY),
        },
      });
    }

    const elevenUrl =
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
      `?optimize_streaming_latency=0&output_format=mp3_44100_128`;

    const resp = await fetch(elevenUrl, {
      method: 'POST',
      headers: {
        accept: 'audio/mpeg',
        'content-type': 'application/json',
        'xi-api-key': ELEVEN_KEY,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      return res.status(500).json({ error: 'ElevenLabs TTS failed', detail });
    }

    const audio = Buffer.from(await resp.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(audio);
  } catch (err) {
    return res.status(500).json({ error: 'TTS proxy error', detail: String(err) });
  }
}
