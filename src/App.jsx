import { useEffect, useState } from 'react'
import { supabase } from './logic/supabase'
import Login from './Login'
import SheetSetup from './SheetSetup'
import Contacts from './Contacts'

// OAuth failures come back on the callback URL, in the query string or the hash
// depending on the flow. Without reading them a failed sign-in just renders the
// login screen again, which looks like an unexplained redirect loop.
function readAuthError() {
  if (typeof window === 'undefined') return null
  const sources = [
    new URLSearchParams(window.location.search),
    new URLSearchParams(window.location.hash.replace(/^#/, '')),
  ]
  for (const params of sources) {
    const code = params.get('error') || params.get('error_code')
    if (!code) continue
    const detail = params.get('error_description')
    return detail ? `${code}: ${detail.replace(/\+/g, ' ')}` : code
  }
  return null
}

export default function App() {
  const [session, setSession] = useState(null)
  const [sheets, setSheets] = useState([])
  const [activeSheet, setActiveSheet] = useState(null)
  const [loading, setLoading] = useState(true)
  const [addingSheet, setAddingSheet] = useState(false)
  // Read once at mount; nothing sets it afterwards, so there is no setter.
  const [authError] = useState(() => readAuthError())

  // Strip the error off the URL so a refresh doesn't resurrect a stale message.
  useEffect(() => {
    if (authError) window.history.replaceState({}, '', window.location.pathname)
  }, [authError])

  // Declared above the effect that calls it: the effect body only runs after
  // render, so a later `const` happened to work, but reading a binding before
  // its declaration is fragile and the compiler lint rejects it.
  const loadSheets = async (session) => {
    const { data } = await supabase
      .from('user_sheets')
      .select('*')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: true })

    if (data && data.length > 0) {
      setSheets(data)
      setActiveSheet(prev => {
        // Keep active sheet if still valid, else use first
        if (prev && data.find(s => s.id === prev.id)) return prev
        return data[0]
      })
    }
    setLoading(false)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) loadSheets(session)
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) loadSheets(session)
      else { setLoading(false); setSheets([]); setActiveSheet(null) }
    })

    return () => subscription.unsubscribe()
  }, [])

  const handleSheetSaved = (newSheet) => {
    setSheets(prev => [...prev, newSheet])
    setActiveSheet(newSheet)
    setAddingSheet(false)
  }

  const handleSheetDeleted = (deletedId) => {
  const remaining = sheets.filter(s => s.id !== deletedId)
  setSheets(remaining)
  setActiveSheet(remaining.length > 0 ? remaining[0] : null)
}

  const handleRemapDone = (updatedSheet) => {
    setSheets(prev => prev.map(s => s.id === updatedSheet.id ? updatedSheet : s))
    setActiveSheet(updatedSheet)
  }

  const handleSheetCacheUpdate = (sheetId, patch) => {
    setSheets(prev => prev.map(s => (s.id === sheetId ? { ...s, ...patch } : s)))
    setActiveSheet(prev => (prev && prev.id === sheetId ? { ...prev, ...patch } : prev))
  }

  // Cancel adding sheet — go back to existing active sheet
  const handleCancelAddSheet = () => {
    setAddingSheet(false)
    // activeSheet is preserved in state, nothing to reset
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', fontSize: '15px', color: 'var(--text-muted)' }}>
      Loading...
    </div>
  )

  if (!session) return <Login authError={authError} />

  if (sheets.length === 0 || addingSheet) return (
    <SheetSetup
      session={session}
      onSheetSaved={handleSheetSaved}
      onCancel={sheets.length > 0 ? handleCancelAddSheet : null}
    />
  )

  return (
    <Contacts
      key={activeSheet.id}
      activeSheet={activeSheet}
      sheets={sheets}
      session={session}
      onSwitchSheet={setActiveSheet}
      onAddSheet={() => setAddingSheet(true)}
      onRemapDone={handleRemapDone}
      onSheetDeleted={handleSheetDeleted}
      onSheetCacheUpdate={handleSheetCacheUpdate}
    />
  )
}