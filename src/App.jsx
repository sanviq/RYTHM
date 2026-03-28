import { useEffect, useState } from 'react'
import { supabase } from './logic/supabase'
import Login from './Login'
import SheetSetup from './SheetSetup'
import Contacts from './Contacts'

export default function App() {
  const [session, setSession] = useState(null)
  const [sheetUrl, setSheetUrl] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) loadSheetUrl(session)
      else setLoading(false)
    })

    supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) loadSheetUrl(session)
      else setLoading(false)
    })
  }, [])

  const loadSheetUrl = async (session) => {
    const { data } = await supabase
      .from('user_settings')
      .select('sheet_url')
      .eq('user_id', session.user.id)
      .single()

    if (data?.sheet_url) setSheetUrl(data.sheet_url)
    setLoading(false)
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      Loading...
    </div>
  )

  if (!session) return <Login />

  if (!sheetUrl) return <SheetSetup session={session} onSheetSaved={setSheetUrl} />

  return <Contacts sheetUrl={sheetUrl} session={session} />
}