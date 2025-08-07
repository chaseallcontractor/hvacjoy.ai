// pages/api/chat.js
export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { speech } = req.body || {};
  if (!speech) {
    return res.status(400).json({ error: 'Missing "speech" in request body' });
  }

  // Read your service keys
  const openaiKey = process.env.OPENAI_API_KEY;
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
  const elevenKey = process.env.ELEVEN_LABS_API_KEY;

  // For now, just echo back
  return res.status(200).json({
    reply: `You said: "${speech}". (OpenAI key is ${openaiKey?.slice(0, 4)}… for demo.)`
  });
}
