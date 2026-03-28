import { useEffect, useState, useRef } from 'react'
import { supabase } from './logic/supabase'
import { fetchContacts, updateContact, fetchHeaders, guessMapping } from './logic/sheets'
import ColumnMapper from './ColumnMapper'

export default function Contacts({ activeSheet, sheets, session, onSwitchSheet, onAddSheet, onRemapDone }) {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [editing, setEditing] = useState(false)
  const [editData, setEditData] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState(false)
  const [panelWidth, setPanelWidth] = useState(480)
  const [dragging, setDragging] = useState(false)
  const [responseFilter, setResponseFilter] = useState(null)
  const [statusFilter, setStatusFilter] = useState(null)
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const [sheetDropOpen, setSheetDropOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [remapping, setRemapping] = useState(false)
  const [remapHeaders, setRemapHeaders] = useState([])
  const [remapMapping, setRemapMapping] = useState({})
  const [remapSaving, setRemapSaving] = useState(false)

  const sheetDropRef = useRef(null)
  const settingsRef = useRef(null)

  const userName = session.user.user_metadata?.full_name || session.user.email
  const columnMapping = activeSheet.column_mapping

  useEffect(() => {
    setLoading(true)
    setContacts([])
    setSelected(null)
    setEditing(false)
    setEditData(null)

    const load = async () => {
      const accessToken = session.provider_token
      const data = await fetchContacts(activeSheet.sheet_url, activeSheet.tab_name, accessToken, columnMapping)
      setContacts(data)
      setLoading(false)
    }
    load()

    const handleResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [activeSheet.id])

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e) => {
      if (sheetDropRef.current && !sheetDropRef.current.contains(e.target)) setSheetDropOpen(false)
      if (settingsRef.current && !settingsRef.current.contains(e.target)) setSettingsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const filtered = contacts.filter(c => {
    const matchSearch =
      (c.full_name || '').toLowerCase().includes(search.toLowerCase()) ||
      (c.organization || '').toLowerCase().includes(search.toLowerCase()) ||
      (c.location || '').toLowerCase().includes(search.toLowerCase())
    const matchResponse = responseFilter ? (c.response || '').toUpperCase() === responseFilter : true
    const matchStatus = statusFilter ? (c.status || '').toUpperCase() === statusFilter : true
    return matchSearch && matchResponse && matchStatus
  })

  const statusStyle = (val) => {
    const s = (val || '').toUpperCase()
    if (s === 'HOT') return { background: '#fdecea', color: '#c62828' }
    if (s === 'WARM') return { background: '#fff3e0', color: '#e65100' }
    if (s === 'COLD') return { background: '#e8f4fd', color: '#1565c0' }
    return { background: '#f0f0f0', color: '#888' }
  }

  const avatarColor = (val) => {
    const s = (val || '').toUpperCase()
    if (s === 'HOT') return { background: '#fdecea', color: '#c62828' }
    if (s === 'WARM') return { background: '#fff3e0', color: '#e65100' }
    return { background: '#ede9fe', color: '#4f46e5' }
  }

  const startDrag = (e) => {
    e.preventDefault()
    setDragging(true)
    const startX = e.clientX
    const startWidth = panelWidth
    const onMove = (e) => {
      const delta = startX - e.clientX
      const newWidth = Math.min(Math.max(startWidth + delta, 260), 700)
      setPanelWidth(newWidth)
    }
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleEdit = () => {
    setEditData({ ...filtered[selected] })
    setEditing(true)
  }

  const handleCancel = () => {
    setEditing(false)
    setEditData(null)
  }

  const handleSave = async () => {
    setSaving(true)
    const accessToken = session.provider_token
    const success = await updateContact(activeSheet.sheet_url, activeSheet.tab_name, accessToken, editData, columnMapping)
    if (success) {
      const updatedContacts = contacts.map(c =>
        c.rowIndex === editData.rowIndex ? {
          ...editData,
          full_name: [editData.first_name, editData.middle_name, editData.last_name].filter(Boolean).join(' ')
        } : c
      )
      setContacts(updatedContacts)
      setEditing(false)
      setEditData(null)
      setSelected(null)
      setSaveMsg(true)
      setTimeout(() => setSaveMsg(false), 3000)
    } else {
      alert('Something went wrong. Try again.')
    }
    setSaving(false)
  }

  // Remap flow
  const handleStartRemap = async () => {
    setSettingsOpen(false)
    const accessToken = session.provider_token
    const fetched = await fetchHeaders(activeSheet.sheet_url, activeSheet.tab_name, accessToken)
    const guessed = guessMapping(fetched)
    // Merge guessed with existing mapping — prefer existing
    const merged = { ...guessed, ...activeSheet.column_mapping }
    setRemapHeaders(fetched)
    setRemapMapping(merged)
    setRemapping(true)
  }

  const handleRemapConfirm = async () => {
    setRemapSaving(true)
    const { data, error } = await supabase
      .from('user_sheets')
      .update({ column_mapping: remapMapping })
      .eq('id', activeSheet.id)
      .select()
      .single()

    if (!error && data) {
      onRemapDone(data)
      setRemapping(false)
    } else {
      alert('Could not save mapping. Try again.')
    }
    setRemapSaving(false)
  }

  const field = (label, key, multiline = false) => (
    <div style={{ marginBottom: '16px' }}>
      <p style={{ fontSize: '11px', fontWeight: '700', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 6px' }}>{label}</p>
      {multiline ? (
        <textarea
          value={editData[key] || ''}
          onChange={e => setEditData({ ...editData, [key]: e.target.value })}
          rows={5}
          style={{ width: '100%', padding: '10px 12px', fontSize: '13px', border: '1px solid #ddd', borderRadius: '8px', outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: '1.5', color: '#333', boxSizing: 'border-box' }}
        />
      ) : (
        <input
          type="text"
          value={editData[key] || ''}
          onChange={e => setEditData({ ...editData, [key]: e.target.value })}
          style={{ width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid #ddd', borderRadius: '8px', outline: 'none', color: '#333', boxSizing: 'border-box' }}
        />
      )}
    </div>
  )

  const dropdownStyle = (active) => ({
    padding: '10px 14px', fontSize: '13px', fontWeight: '600',
    border: `1.5px solid ${active ? '#4f46e5' : '#ddd'}`,
    borderRadius: '10px', outline: 'none',
    background: active ? '#ede9fe' : '#fff',
    cursor: 'pointer',
    color: active ? '#4f46e5' : '#888',
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    flex: 1
  })

  const panelContent = (contact) => (
    <div style={{ padding: '16px 20px' }}>
      {!editing ? (
        <>
          {[
            { label: 'Status', value: contact.status, badge: true },
            { label: 'Response', value: contact.response, badge: true },
            { label: 'Mobile', value: contact.mobile_no },
            { label: 'Location', value: contact.location },
          ].map(({ label, value, badge }) => (
            <div key={label} style={{ marginBottom: '16px' }}>
              <p style={{ fontSize: '11px', fontWeight: '700', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 4px' }}>{label}</p>
              {badge ? (
                <span style={{ padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '700', display: 'inline-block', ...statusStyle(value) }}>
                  {value || '—'}
                </span>
              ) : (
                <p style={{ fontSize: '14px', color: '#333', margin: 0 }}>{value || '—'}</p>
              )}
            </div>
          ))}
          <div style={{ marginBottom: '20px' }}>
            <p style={{ fontSize: '11px', fontWeight: '700', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 8px' }}>Notes</p>
            <div style={{ background: '#f9f8ff', borderRadius: '10px', padding: '14px', fontSize: '13px', color: '#444', lineHeight: '1.6', whiteSpace: 'pre-wrap', border: '1px solid #ede9fe' }}>
              {contact.notes || 'No notes for this contact.'}
            </div>
          </div>
          <button onClick={handleEdit} style={{ width: '100%', padding: '11px', fontSize: '14px', fontWeight: '600', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '10px', cursor: 'pointer' }}>
            Edit Contact
          </button>
        </>
      ) : (
        <>
          {field('First Name', 'first_name')}
          {field('Middle Name', 'middle_name')}
          {field('Last Name', 'last_name')}
          {field('Organization', 'organization')}
          {field('Status', 'status')}
          {field('Response', 'response')}
          {field('Mobile', 'mobile_no')}
          {field('Location', 'location')}
          {field('Notes', 'notes', true)}
          <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
            <button onClick={handleCancel} style={{ flex: 1, padding: '11px', fontSize: '14px', fontWeight: '600', background: '#f5f5f5', color: '#555', border: '1px solid #ddd', borderRadius: '10px', cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={handleSave} disabled={saving} style={{ flex: 1, padding: '11px', fontSize: '14px', fontWeight: '600', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '10px', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  )

  const panelHeader = (contact) => (
    <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <div>
        <div style={{ width: '44px', height: '44px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', fontWeight: '800', marginBottom: '10px', ...avatarColor(contact.status) }}>
          {(contact.full_name || '?').charAt(0).toUpperCase()}
        </div>
        <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111', margin: 0 }}>{contact.full_name || '—'}</h2>
        <p style={{ fontSize: '13px', color: '#888', margin: '2px 0 0' }}>{contact.organization || '—'}</p>
      </div>
      <button onClick={() => { setSelected(null); setEditing(false); setEditData(null) }} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#aaa' }}>x</button>
    </div>
  )

  // Remap screen
  if (remapping) {
    return (
      <ColumnMapper
        headers={remapHeaders}
        mapping={remapMapping}
        onChange={(field, value) => setRemapMapping(prev => ({ ...prev, [field]: value }))}
        onConfirm={handleRemapConfirm}
        onBack={() => setRemapping(false)}
        saving={remapSaving}
      />
    )
  }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontSize: '16px', color: '#666', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}>
      Loading contacts...
    </div>
  )

  const nav = (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 16px', height: '56px',
      background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(10px)',
      borderBottom: '1px solid #e0e0e0', position: 'sticky', top: 0, zIndex: 100, width: '100%',
      boxSizing: 'border-box'
    }}>
      {/* Left: Logo + Sheet Switcher */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '18px', fontWeight: '900', letterSpacing: '3px', color: '#4f46e5' }}>RYTHM</span>

        {/* Sheet dropdown */}
        <div ref={sheetDropRef} style={{ position: 'relative' }}>
          <button
            onClick={() => { setSheetDropOpen(p => !p); setSettingsOpen(false) }}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              padding: '5px 10px', fontSize: '13px', fontWeight: '600',
              border: '1px solid #ddd', borderRadius: '8px',
              background: sheetDropOpen ? '#ede9fe' : '#fff',
              color: sheetDropOpen ? '#4f46e5' : '#333',
              cursor: 'pointer', outline: 'none'
            }}
          >
            {activeSheet.sheet_name}
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
              <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>

          {sheetDropOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0,
              background: '#fff', borderRadius: '10px', boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
              border: '1px solid #e8e8e8', minWidth: '200px', overflow: 'hidden', zIndex: 200
            }}>
              {sheets.map(s => (
                <button
                  key={s.id}
                  onClick={() => { onSwitchSheet(s); setSheetDropOpen(false) }}
                  style={{
                    width: '100%', textAlign: 'left', padding: '10px 14px',
                    fontSize: '13px', fontWeight: s.id === activeSheet.id ? '700' : '500',
                    background: s.id === activeSheet.id ? '#f5f3ff' : '#fff',
                    color: s.id === activeSheet.id ? '#4f46e5' : '#333',
                    border: 'none', cursor: 'pointer', display: 'block',
                    borderBottom: '1px solid #f5f5f5'
                  }}
                >
                  {s.sheet_name}
                  {s.id === activeSheet.id && (
                    <span style={{ fontSize: '11px', color: '#a5b4fc', marginLeft: '8px', fontWeight: '600' }}>Active</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <span style={{ fontSize: '11px', background: '#ede9fe', padding: '3px 10px', borderRadius: '20px', color: '#4f46e5', fontWeight: '600' }}>
          {contacts.length.toLocaleString()}
        </span>
      </div>

      {/* Right: Username + Settings */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: '#4f46e5', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '700', flexShrink: 0 }}>
          {userName.charAt(0).toUpperCase()}
        </div>
        <span style={{ fontSize: '13px', color: '#333', fontWeight: '500', maxWidth: isMobile ? '70px' : '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isMobile ? userName.split(' ')[0] : userName}
        </span>

        {/* Settings dropdown */}
        <div ref={settingsRef} style={{ position: 'relative' }}>
          <button
            onClick={() => { setSettingsOpen(p => !p); setSheetDropOpen(false) }}
            style={{
              padding: '5px 10px', fontSize: '12px', fontWeight: '600',
              border: '1px solid #ddd', borderRadius: '6px',
              background: settingsOpen ? '#ede9fe' : '#fff',
              color: settingsOpen ? '#4f46e5' : '#666',
              cursor: 'pointer', outline: 'none'
            }}
          >
            Settings
          </button>

          {settingsOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', right: 0,
              background: '#fff', borderRadius: '10px', boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
              border: '1px solid #e8e8e8', minWidth: '180px', overflow: 'hidden', zIndex: 200
            }}>
              {[
                { label: 'Add New Sheet', action: () => { setSettingsOpen(false); onAddSheet() } },
                { label: 'Re-map Columns', action: handleStartRemap },
                { label: 'Sign Out', action: () => supabase.auth.signOut(), danger: true },
              ].map(({ label, action, danger }) => (
                <button
                  key={label}
                  onClick={action}
                  style={{
                    width: '100%', textAlign: 'left', padding: '11px 16px',
                    fontSize: '13px', fontWeight: '500',
                    background: '#fff', color: danger ? '#dc2626' : '#333',
                    border: 'none', borderBottom: '1px solid #f5f5f5',
                    cursor: 'pointer', display: 'block'
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = danger ? '#fef2f2' : '#f9f8ff'}
                  onMouseLeave={e => e.currentTarget.style.background = '#fff'}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )

  const searchAndFilters = (
    <div style={{ padding: '16px 16px 8px' }}>
      <input
        type="text"
        placeholder="Search by name, organization or location..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: '100%', padding: '11px 18px', fontSize: '14px', border: '1px solid #ddd', borderRadius: '10px', outline: 'none', background: '#fff', marginBottom: '10px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', gap: '8px' }}>
        <select value={responseFilter || ''} onChange={e => setResponseFilter(e.target.value || null)} style={dropdownStyle(responseFilter)}>
          <option value=''>Response</option>
          <option value='HOT'>Hot</option>
          <option value='WARM'>Warm</option>
          <option value='COLD'>Cold</option>
        </select>
        <select value={statusFilter || ''} onChange={e => setStatusFilter(e.target.value || null)} style={dropdownStyle(statusFilter)}>
          <option value=''>Status</option>
          <option value='NEW'>New</option>
          <option value='INFO DONE'>Info Done</option>
          <option value='INVITE SENT'>Invite Sent</option>
          <option value='PLAN LINED UP'>Plan Lined Up</option>
          <option value='PLAN DONE'>Plan Done</option>
          <option value='TO BE INVITED'>To Be Invited</option>
        </select>
        {(responseFilter || statusFilter || search) && (
          <button onClick={() => { setResponseFilter(null); setStatusFilter(null); setSearch('') }} style={{ padding: '10px 12px', fontSize: '13px', fontWeight: '600', border: '1.5px solid #fca5a5', borderRadius: '10px', background: '#fef2f2', color: '#dc2626', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            Clear
          </button>
        )}
      </div>
      {(search || responseFilter || statusFilter) && (
        <p style={{ fontSize: '12px', color: '#888', margin: '8px 0 0' }}>
          {filtered.length.toLocaleString()} results
          {responseFilter && ` · ${responseFilter}`}
          {statusFilter && ` · ${statusFilter}`}
          {search && ` · "${search}"`}
        </p>
      )}
    </div>
  )

  return (
    <>
      <style>{`
        .contact-row:hover { background: #f9f8ff !important; }
        .contact-row.active { background: #ede9fe !important; }
        .contact-card:hover { border-color: #a5b4fc !important; }
        * { box-sizing: border-box; }
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideUp {
          from { transform: translateY(100%); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>

      <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', minHeight: '100vh', background: 'linear-gradient(135deg, #ece9f7 0%, #e8f0fe 100%)', width: '100%', overflowX: 'hidden' }}>
        {nav}

        {isMobile ? (
          <div>
            {searchAndFilters}
            <div style={{ padding: '0 12px 100px' }}>
              {filtered.map((c, i) => (
                <div
                  key={i}
                  className="contact-card"
                  onClick={() => { setSelected(i); setEditing(false); setEditData(null) }}
                  style={{ background: '#fff', borderRadius: '14px', border: '1px solid #e8e8e8', padding: '14px 16px', marginBottom: '10px', cursor: 'pointer', transition: 'border-color 0.15s' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
                    <div style={{ width: '40px', height: '40px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: '700', flexShrink: 0, ...avatarColor(c.status) }}>
                      {(c.full_name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: '15px', fontWeight: '600', color: '#111', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c.first_name || c.full_name || '—'}
                      </p>
                      <p style={{ fontSize: '13px', color: '#888', margin: '2px 0 0' }}>{c.organization || '—'}</p>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '11px', fontWeight: '700', padding: '3px 10px', borderRadius: '20px', ...statusStyle(c.status) }}>{c.status || '—'}</span>
                    <span style={{ fontSize: '11px', fontWeight: '700', padding: '3px 10px', borderRadius: '20px', ...statusStyle(c.response) }}>{c.response || '—'}</span>
                    <span style={{ fontSize: '12px', color: '#888', marginLeft: 'auto' }}>{c.mobile_no || ''}</span>
                    <span style={{ fontSize: '15px' }}>{c.notes ? <span style={{ color: '#4f46e5' }}>●</span> : <span style={{ color: '#ddd' }}>○</span>}</span>
                  </div>
                </div>
              ))}
            </div>

            {selected !== null && filtered[selected] && (
              <div style={{ position: 'fixed', inset: 0, zIndex: 200 }}>
                <div onClick={() => { setSelected(null); setEditing(false); setEditData(null) }} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: '#fff', borderRadius: '20px 20px 0 0', maxHeight: '85vh', overflowY: 'auto', animation: 'slideUp 0.25s ease' }}>
                  <div style={{ width: '40px', height: '4px', background: '#ddd', borderRadius: '2px', margin: '12px auto 0' }} />
                  {panelHeader(filtered[selected])}
                  {panelContent(filtered[selected])}
                </div>
              </div>
            )}
          </div>

        ) : (
          <div style={{ display: 'flex', height: 'calc(100vh - 56px)', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', padding: '20px 24px' }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  placeholder="Search by name, organization or location..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ flex: 1, minWidth: '200px', padding: '11px 18px', fontSize: '14px', border: '1px solid #ddd', borderRadius: '10px', outline: 'none', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}
                />
                <select value={responseFilter || ''} onChange={e => setResponseFilter(e.target.value || null)} style={{ ...dropdownStyle(responseFilter), flex: 'none' }}>
                  <option value=''>Response</option>
                  <option value='HOT'>Hot</option>
                  <option value='WARM'>Warm</option>
                  <option value='COLD'>Cold</option>
                </select>
                <select value={statusFilter || ''} onChange={e => setStatusFilter(e.target.value || null)} style={{ ...dropdownStyle(statusFilter), flex: 'none' }}>
                  <option value=''>Status</option>
                  <option value='NEW'>New</option>
                  <option value='INFO DONE'>Info Done</option>
                  <option value='INVITE SENT'>Invite Sent</option>
                  <option value='PLAN LINED UP'>Plan Lined Up</option>
                  <option value='PLAN DONE'>Plan Done</option>
                  <option value='TO BE INVITED'>To Be Invited</option>
                </select>
                {(responseFilter || statusFilter || search) && (
                  <button onClick={() => { setResponseFilter(null); setStatusFilter(null); setSearch('') }} style={{ padding: '11px 14px', fontSize: '13px', fontWeight: '600', border: '1.5px solid #fca5a5', borderRadius: '10px', background: '#fef2f2', color: '#dc2626', cursor: 'pointer' }}>
                    Clear
                  </button>
                )}
              </div>

              {(search || responseFilter || statusFilter) && (
                <p style={{ fontSize: '13px', color: '#666', marginBottom: '10px' }}>
                  {filtered.length.toLocaleString()} results
                  {responseFilter && ` · Response: ${responseFilter}`}
                  {statusFilter && ` · Status: ${statusFilter}`}
                  {search && ` · "${search}"`}
                </p>
              )}

              <div style={{ background: '#fff', borderRadius: '14px', boxShadow: '0 2px 12px rgba(79,70,229,0.08)', overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: '500px' }}>
                  <colgroup>
                    <col style={{ width: '22%' }} />
                    <col style={{ width: '16%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '16%' }} />
                    <col style={{ width: '14%' }} />
                    <col style={{ width: '8%' }} />
                  </colgroup>
                  <thead>
                    <tr style={{ background: '#faf9ff', borderBottom: '2px solid #ede9fe' }}>
                      <th style={th}>Name</th>
                      <th style={th}>Organization</th>
                      <th style={th}>Status</th>
                      <th style={th}>Response</th>
                      <th style={th}>Mobile</th>
                      <th style={th}>Location</th>
                      <th style={{ ...th, textAlign: 'center' }}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c, i) => (
                      <tr
                        key={i}
                        className={`contact-row${selected === i ? ' active' : ''}`}
                        style={{ borderBottom: '1px solid #f5f5f5', cursor: 'pointer', background: 'transparent' }}
                        onClick={() => { setSelected(selected === i ? null : i); setEditing(false); setEditData(null) }}
                      >
                        <td style={{ ...td, fontWeight: '600', color: '#4f46e5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'underline', textDecorationColor: '#c7d2fe' }}>{c.full_name || '—'}</td>
                        <td style={{ ...td, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.organization || '—'}</td>
                        <td style={td}><span style={{ padding: '3px 8px', borderRadius: '20px', fontSize: '11px', fontWeight: '700', display: 'inline-block', ...statusStyle(c.status) }}>{c.status || '—'}</span></td>
                        <td style={td}><span style={{ padding: '3px 8px', borderRadius: '20px', fontSize: '11px', fontWeight: '700', display: 'inline-block', ...statusStyle(c.response) }}>{c.response || '—'}</span></td>
                        <td style={{ ...td, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px' }}>{c.mobile_no || '—'}</td>
                        <td style={{ ...td, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.location || '—'}</td>
                        <td style={{ ...td, textAlign: 'center', fontSize: '16px' }}>{c.notes ? <span style={{ color: '#4f46e5' }}>●</span> : <span style={{ color: '#ddd' }}>○</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {selected !== null && filtered[selected] && (
              <>
                <div
                  onMouseDown={startDrag}
                  style={{ width: '5px', cursor: 'col-resize', background: dragging ? '#4f46e5' : 'transparent', transition: 'background 0.2s', flexShrink: 0, zIndex: 10 }}
                  onMouseEnter={e => e.currentTarget.style.background = '#c7d2fe'}
                  onMouseLeave={e => { if (!dragging) e.currentTarget.style.background = 'transparent' }}
                />
                <div style={{ width: `${panelWidth}px`, minWidth: '260px', background: '#fff', borderLeft: '1px solid #e0e0e0', overflowY: 'auto', boxShadow: '-4px 0 20px rgba(79,70,229,0.08)', animation: 'slideIn 0.2s ease', flexShrink: 0 }}>
                  {panelHeader(filtered[selected])}
                  {panelContent(filtered[selected])}
                </div>
              </>
            )}
          </div>
        )}

        {saveMsg && (
          <div style={{
            position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
            background: '#166534', color: '#fff', padding: '12px 24px',
            borderRadius: '10px', fontSize: '14px', fontWeight: '600',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 999,
            animation: 'slideUp 0.2s ease'
          }}>
            Saved to Google Sheet
          </div>
        )}
      </div>
    </>
  )
}

const th = { padding: '12px 14px', textAlign: 'left', fontSize: '11px', fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const td = { padding: '12px 14px', fontSize: '13px' }