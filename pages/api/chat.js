// pages/api/chat.js
export default async function handler(req, res) {
  // ▶️ debug logging of env‐vars — you should see these in your Render logs
  console.log("🔑 OPENAI_API_KEY:", process.env.OPENAI_API_KEY);
  console.log("🔑 TWILIO_ACCOUNT_SID:", process.env.TWILIO_ACCOUNT_SID);
  console.log("🔑 TWILIO_AUTH_TOKEN:", process.env.TWILIO_AUTH_TOKEN);
  console.log("🔑 ELEVEN_LABS_API_KEY:", process.env.ELEVEN_LABS_API_KEY);

  // Only allow POST
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const { speech } = req.body || {};
  if (!speech) {
    return res.status(400).json({ error: 'Missing "speech" in request body' });
  }

  // echo back, showing a truncated key for sanity
  const openaiKey = process.env.OPENAI_API_KEY;
  return res.status(200).json({
    reply: `You said: "${speech}". (OpenAI key is ${openaiKey?.slice(0,4)}… for demo.)`
  });
}
