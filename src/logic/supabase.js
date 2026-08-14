import { createClient } from '@supabase/supabase-js'

// Configured per-environment so a new Supabase project is a config change, not a code edit.
// Local dev: .env (see .env.example). Cloudflare Pages: Settings → Environment variables.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY ' +
    '(in .env for local dev, or in Cloudflare Pages environment variables), then rebuild.'
  )
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
