// pages/api/transcripts/log.js
import { getSupabaseAdmin } from '../../../lib/supabase-admin';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { caller, text, role = 'caller', callSid = null, turnIndex = null, meta = {} } =
      req.body || {};

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Missing text' });
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('call_transcripts')
      .insert({
        caller_phone: caller || null,
        text,
        role,
        call_sid: callSid,
        turn_index: turnIndex,
        meta
      })
      .select('id')
      .single();

    if (error) return res.status(500).json({ error: 'Insert failed', detail: error.message });

    return res.status(200).json({ ok: true, id: data.id });
  } catch (err) {
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
