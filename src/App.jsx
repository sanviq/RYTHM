import { useEffect, useState, useRef } from 'react'
import { supabase } from './logic/supabase'
import Login from './Login'
import SheetSetup from './SheetSetup'
import Contacts from './Contacts'

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

    supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) loadSheets(session)
      else { setLoading(false); setSheets([]); setActiveSheet(null) }
    })
  }, [])

  const loadSheets = async (session) => {
    const { data } = await supabase
      .from('user_sheets')
      .select('*')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: true })

    if (data && data.length > 0) {
      setSheets(data)
      setActiveSheet(data[0])
    }
    setLoading(false)
  }

  const handleSheetSaved = (newSheet) => {
    setSheets(prev => [...prev, newSheet])
    setActiveSheet(newSheet)
    setAddingSheet(false)
  }

  const handleRemapDone = (updatedSheet) => {
    setSheets(prev => prev.map(s => s.id === updatedSheet.id ? updatedSheet : s))
    setActiveSheet(updatedSheet)
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
      onCancel={sheets.length > 0 ? () => setAddingSheet(false) : null}
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
    />
  )
}