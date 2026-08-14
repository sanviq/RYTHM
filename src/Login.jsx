import { useState } from 'react'
import { supabase } from './logic/supabase'

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"/>
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"/>
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/>
    </svg>
  )
}

export default function Login({ authError = null }) {
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState(null)
  // A failure returned on the callback URL matters more than anything raised
  // locally, because it explains why sign-in bounced straight back to here.
  const error = authError || localError

  const handleGoogleLogin = async () => {
    setBusy(true)
    setLocalError(null)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        scopes: 'https://www.googleapis.com/auth/spreadsheets',
        // Must match Supabase Auth → URL Configuration → Redirect URLs.
        redirectTo: window.location.origin,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    })
    if (error) {
      console.error('Login error:', error.message)
      setLocalError(error.message)
      setBusy(false)
    }
    // On success the browser navigates to Google, so `busy` intentionally stays set.
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      padding: 'var(--s-5)',
      background: 'radial-gradient(120% 120% at 50% 0%, var(--accent-soft) 0%, var(--bg) 55%)',
    }}>
      <main className="card" style={{ width: '100%', maxWidth: '400px', padding: 'var(--s-8)', textAlign: 'center' }}>
        <div style={{
          width: '52px', height: '52px', margin: '0 auto var(--s-5)',
          display: 'grid', placeItems: 'center',
          borderRadius: 'var(--r-xl)',
          background: 'var(--accent)', color: 'var(--text-inverse)',
          fontSize: 'var(--t-2xl)', fontWeight: 700,
        }}>R</div>

        <h1 style={{ fontSize: 'var(--t-2xl)', fontWeight: 700, letterSpacing: '-.02em' }}>Rhythm</h1>
        <p style={{ marginTop: 'var(--s-2)', fontSize: 'var(--t-md)', color: 'var(--text-muted)' }}>
          Your Google Sheets, as a CRM.
        </p>

        <button
          className="btn btn-primary"
          onClick={handleGoogleLogin}
          disabled={busy}
          style={{ width: '100%', marginTop: 'var(--s-6)', padding: '11px' }}
        >
          {busy ? 'Redirecting…' : <><GoogleMark /> Continue with Google</>}
        </button>

        {error && (
          <p role="alert" style={{
            marginTop: 'var(--s-4)', padding: 'var(--s-3)',
            fontSize: 'var(--t-sm)', textAlign: 'left',
            color: 'var(--danger)', background: 'var(--danger-soft)',
            borderRadius: 'var(--r-md)',
          }}>{error}</p>
        )}

        <p style={{ marginTop: 'var(--s-5)', fontSize: 'var(--t-sm)', color: 'var(--text-subtle)', lineHeight: 1.5 }}>
          Rythm reads and edits only the sheets you connect. Your data stays in your Google account.
        </p>
      </main>
    </div>
  )
}
