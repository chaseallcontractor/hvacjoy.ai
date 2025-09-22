// lib/supabase-admin.js
import { createClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase client.
 * Uses service role key for secure inserts.
 */
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!url) throw new Error('SUPABASE_URL is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) is not set');

  return createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { 'X-Client-Info': 'hvacjoy-ai-admin' } },
  });
}
