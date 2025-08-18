// pages/api/tts.js
// Proxies ElevenLabs TTS and returns an MP3 Twilio can <Play>

export const config = {
  api: {
    responseLimit: false, // allow binary/audio
    bodyParser: true,
  },
};

const VOICE_ID = process.env.ELEVEN_VOICE_ID;        // e.g. 21m00Tcm4TlvDq8ikWAM
const ELEVEN_KEY = process.env.ELEVEN_API_KEY;       // your ElevenLabs API key

export default async function handler(req, res) {
  try {
    const text = String(req.query.text || '').slice(0, 800); // keep it reasonable
    const voiceId = String(req.query.voice || VOICE_ID || '').trim();

    if (!text || !voiceId || !ELEVEN_KEY) {
      return res.status(400).json({ error: 'Missing text, voiceId, or API key' });
    }

    const elevenUrl = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?optimize_streaming_latency=0&output_format=mp3_44100_128`;

    const resp = await fetch(elevenUrl, {
      method: 'POST',
      headers: {
        'accept': 'audio/mpeg',
        'content-type': 'application/json',
        'xi-api-key': ELEVEN_KEY,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.8 }
      }),
    });

    if (!resp.ok) {
      const msg = await resp.text().catch(() => '');
      return res.status(500).json({ error: 'ElevenLabs TTS failed', detail: msg });
    }

    const audio = Buffer.from(await resp.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store'); // always fresh
    return res.status(200).send(audio);
  } catch (err) {
    return res.status(500).json({ error: 'TTS proxy error', detail: String(err) });
  }
}
