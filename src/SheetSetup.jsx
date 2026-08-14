import { useState } from 'react'
import { supabase } from './logic/supabase'
import { fetchHeaders, guessMapping } from './logic/sheets'
import ColumnMapper from './ColumnMapper'

export default function SheetSetup({ session, onSheetSaved, onCancel }) {
  const [step, setStep] = useState('form')
  const [sheetUrl, setSheetUrl] = useState('')
  const [tabName, setTabName] = useState('')
  const [sheetName, setSheetName] = useState('')
  const [headers, setHeaders] = useState([])
  const [mapping, setMapping] = useState({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleNext = async () => {
    if (!sheetUrl.trim()) return setError('Please paste your Google Sheet URL.')
    if (!tabName.trim()) return setError('Please enter the tab name.')
    if (!sheetName.trim()) return setError('Please enter a name for this sheet.')
    setError('')
    setLoading(true)

    const accessToken = session.provider_token
    const fetched = await fetchHeaders(sheetUrl.trim(), tabName.trim(), accessToken)

    if (!fetched || fetched.length === 0) {
      setError('Could not read headers. Check the URL and tab name and make sure the sheet is shared with your Google account.')
      setLoading(false)
      return
    }

    setHeaders(fetched)
    setMapping(guessMapping(fetched))
    setStep('mapping')
    setLoading(false)
  }

  const handleConfirm = async (finalMapping) => {
    setLoading(true)
    const { data, error: insertError } = await supabase
      .from('user_sheets')
      .insert({
        user_id: session.user.id,
        sheet_url: sheetUrl.trim(),
        tab_name: tabName.trim(),
        sheet_name: sheetName.trim(),
        column_mapping: finalMapping,
      })
      .select()
      .single()

    if (insertError) {
      setError('Something went wrong saving your sheet. Try again.')
      setLoading(false)
      return
    }
    onSheetSaved(data)
    setLoading(false)
  }

  const inputStyle = {
    width: '100%', padding: '10px 14px', fontSize: '14px',
    border: '1px solid var(--border-strong)', borderRadius: '10px', outline: 'none',
    color: 'var(--text)', boxSizing: 'border-box', marginTop: '6px'
  }
  const labelStyle = {
    fontSize: '12px', fontWeight: '700', color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.4px'
  }

  if (step === 'mapping') {
    return (
      <ColumnMapper
        headers={headers}
        initialMapping={mapping}
        onConfirm={handleConfirm}
        onBack={() => setStep('form')}
        saving={loading}
      />
    )
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      padding: '40px 16px'
    }}>
      <div style={{
        background: 'var(--surface)', borderRadius: '16px',
        boxShadow: '0 4px 24px rgba(79,70,229,0.10)',
        padding: '36px 40px', width: '100%', maxWidth: '480px'
      }}>
        <span style={{ fontSize: '20px', fontWeight: '900', letterSpacing: '3px', color: 'var(--accent)' }}>RYTHM</span>
        <h2 style={{ fontSize: '18px', fontWeight: '700', color: 'var(--text)', margin: '20px 0 4px' }}>Connect a Google Sheet</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-subtle)', margin: '0 0 28px' }}>
          Paste your sheet URL, enter the tab name, and give this sheet a label.
        </p>

        <div style={{ marginBottom: '16px' }}>
          <label style={labelStyle}>Sheet Name (your label)</label>
          <input type="text" placeholder='e.g. Main Contacts' value={sheetName} onChange={e => setSheetName(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ marginBottom: '16px' }}>
          <label style={labelStyle}>Google Sheet URL</label>
          <input type="text" placeholder="https://docs.google.com/spreadsheets/d/..." value={sheetUrl} onChange={e => setSheetUrl(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ marginBottom: '24px' }}>
          <label style={labelStyle}>Tab Name</label>
          <input type="text" placeholder='e.g. contacts' value={tabName} onChange={e => setTabName(e.target.value)} style={inputStyle} />
          <p style={{ fontSize: '11px', color: 'var(--text-subtle)', margin: '6px 0 0' }}>
            The exact name of the sheet tab at the bottom of your spreadsheet.
          </p>
        </div>

        {error && (
          <p style={{ fontSize: '13px', color: 'var(--danger)', marginBottom: '16px', background: 'var(--danger-soft)', padding: '10px 14px', borderRadius: '8px', border: '1px solid var(--danger)' }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: '10px' }}>
          {onCancel && (
            <button onClick={onCancel} style={{ flex: 1, padding: '12px', fontSize: '14px', fontWeight: '600', background: 'var(--surface-hover)', color: 'var(--text-muted)', border: '1px solid var(--border-strong)', borderRadius: '10px', cursor: 'pointer' }}>
              Back
            </button>
          )}
          <button onClick={handleNext} disabled={loading} style={{ flex: 2, padding: '12px', fontSize: '14px', fontWeight: '600', background: 'var(--accent)', color: 'var(--text-inverse)', border: 'none', borderRadius: '10px', cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.7 : 1 }}>
            {loading ? 'Reading sheet...' : 'Next: Map Columns'}
          </button>
        </div>
      </div>
    </div>
  )
}