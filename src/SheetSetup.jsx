import { useState } from 'react'
import { supabase } from './logic/supabase'

export default function SheetSetup({ session, onSheetSaved }) {
  const [sheetUrl, setSheetUrl] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSave = async () => {
    if (!sheetUrl) return alert('Please paste your Sheet URL!')
    setLoading(true)

    const { error } = await supabase
      .from('user_settings')
      .upsert({ user_id: session.user.id, sheet_url: sheetUrl })

    if (error) {
      console.error(error)
      alert('Something went wrong. Try again!')
    } else {
      onSheetSaved(sheetUrl)
    }

    setLoading(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      <h1>Connect your Google Sheet</h1>
      <p>Paste your Google Sheet URL below</p>
      <input
        type="text"
        placeholder="https://docs.google.com/spreadsheets/d/..."
        value={sheetUrl}
        onChange={(e) => setSheetUrl(e.target.value)}
        style={{ width: '500px', padding: '12px', fontSize: '14px', marginTop: '20px' }}
      />
      <button
        onClick={handleSave}
        disabled={loading}
        style={{ padding: '12px 24px', fontSize: '16px', cursor: 'pointer', marginTop: '16px' }}
      >
        {loading ? 'Saving...' : 'Connect Sheet'}
      </button>
    </div>
  )
}