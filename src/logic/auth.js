import { supabase } from './supabase'

// Lives here rather than in App.jsx so that file only exports its component —
// a module mixing components with other exports opts out of React Fast Refresh.
// Contacts.jsx is the caller; it previously reached into App.jsx for this.

// Call this anywhere you need a fresh Google access token.
export async function getFreshToken() {
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.provider_token) return session.provider_token

  // Try refreshing the session
  const { data: { session: refreshed } } = await supabase.auth.refreshSession()
  if (refreshed?.provider_token) return refreshed.provider_token

  return null
}
