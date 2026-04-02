import { useEffect, useState } from 'react'
import { supabase } from './logic/supabase'
import Login from './Login'
import SheetSetup from './SheetSetup'
import Contacts from './Contacts'

// Call this anywhere you need a fresh Google access token
export async function getFreshToken() {
  const { data: { session } } = await supabase.auth.getSession()
  if (session?.provider_token) return session.provider_token

  // Try refreshing the session
  const { data: { session: refreshed } } = await supabase.auth.refreshSession()
  if (refreshed?.provider_token) return refreshed.provider_token

  return null
}

export default function App() {
  const [session, setSession] = useState(null)
  const [sheets, setSheets] = useState([])
  const [activeSheet, setActiveSheet] = useState(null)
  const [loading, setLoading] = useState(true)
  const [addingSheet, setAddingSheet] = useState(false)

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

  // Cancel adding sheet — go back to existing active sheet
  const handleCancelAddSheet = () => {
    setAddingSheet(false)
    // activeSheet is preserved in state, nothing to reset
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', fontSize: '15px', color: '#666' }}>
      Loading...
    </div>
  )

  if (!session) return <Login />

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
      onSheetDeleted={handleSheetDeleted}    />
  )
}