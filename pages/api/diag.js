// pages/api/diag.js
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    const supabaseUrl  = process.env.SUPABASE_URL || '';
    const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    // Basic presence checks (we do NOT return secrets)
    const hasUrl  = Boolean(supabaseUrl);
    const hasKey  = Boolean(serviceKey);

    // Ping Supabase Auth health (simple, public health endpoint)
    let authHealth = 'unknown';
    if (hasUrl) {
      try {
        const r = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/health`);
        authHealth = `${r.status} ${r.statusText}`;
      } catch (e) {
        authHealth = `error: ${String(e)}`;
      }
    }

    return res.status(200).json({
      status: 'ok',
      env: { SUPABASE_URL_present: hasUrl, SUPABASE_SERVICE_ROLE_KEY_present: hasKey },
      supabase_auth_health: authHealth,
      note: 'This endpoint is temporary—safe to remove after verification.',
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', detail: String(err) });
  }
}
