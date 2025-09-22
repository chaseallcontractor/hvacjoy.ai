// pages/api/transcripts.js
import { getSupabaseAdmin } from '../../lib/supabase-admin';

export const config = { api: { bodyParser: true } };

/**
 * POST /api/transcripts
 * Body:
 * {
 *   source?: 'twilio' | 'callrail',
 *   call_sid?: string,
 *   from_number?: string,
 *   to_number?: string,
 *   direction?: 'inbound' | 'outbound',
 *   status?: string,
 *   transcript?: string,
 *   ai_summary?: string,
 *   meta?: object
 * }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const {
      source = 'callrail',
      call_sid = null,
      from_number = null,
      to_number = null,
      direction = null,
      status = null,
      transcript = null,
      ai_summary = null,
      meta = null,
    } = req.body || {};

    // Basic validation (adjust as you like)
    if (!from_number && !transcript && !ai_summary && !call_sid) {
      return res.status(400).json({
        error: 'Bad Request',
        detail: 'Provide at least one of: from_number, transcript, ai_summary, call_sid.',
      });
    }

    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from('calls')
      .insert([
        {
          source,
          call_sid,
          from_number,
          to_number,
          direction,
          status,
          transcript,
          ai_summary,
          meta,
        },
      ])
      .select('id, created_at')
      .single();

    if (error) {
      console.error('Supabase insert failed:', error.message);
      return res.status(500).json({ error: 'Insert failed', detail: error.message });
    }

    return res.status(200).json({ ok: true, id: data.id, created_at: data.created_at });
  } catch (err) {
    console.error('transcripts API error:', err);
    return res.status(500).json({ error: 'Server error', detail: String(err) });
  }
}
