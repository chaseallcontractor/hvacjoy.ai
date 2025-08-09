/* eslint-disable */
// pages/api/chat.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { speech = '', caller = '' } = req.body || {};
    if (!speech) return res.status(400).json({ error: 'Missing "speech" in body' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY is not set' });

    const systemPrompt = `
You are HVAC Joy AI, a friendly phone receptionist for a residential HVAC company.
Keep replies short (1–2 sentences) and conversational.
Answer FAQs, book appointments, or forward to a live agent if needed.
    `.trim();

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Caller: ${caller || 'Unknown'}\nSays: ${speech}` },
        ],
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(502).json({ error: 'OpenAI error', detail: text });
    }

    const data = await resp.json();
    const reply =
      data?.choices?.[0]?.message?.content?.trim() ||
      "I'm here to help with HVAC questions and scheduling.";

    return res.status(200).json({ reply, model: 'gpt-4o-mini', usage: data?.usage ?? null });
  } catch (err) {
    console.error('chat handler error', err);
    return res.status(500).json({ error: 'Server error', detail: err?.message ?? String(err) });
  }
}
