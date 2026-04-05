import { supabase } from './logic/supabase'

export default function Login() {
  const handleGoogleLogin = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        scopes: 'https://www.googleapis.com/auth/spreadsheets',
        // Must match Supabase Auth → URL Configuration → Redirect URLs (e.g. https://your-site.pages.dev).
        redirectTo: window.location.origin,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    })
    if (error) console.error('Login error:', error.message)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      <h1>Welcome to Rythm</h1>
      <p>Your Google Sheets CRM</p>
      <button onClick={handleGoogleLogin} style={{ padding: '12px 24px', fontSize: '16px', cursor: 'pointer', marginTop: '20px' }}>
        Sign in with Google
      </button>
    </div>
  )
}