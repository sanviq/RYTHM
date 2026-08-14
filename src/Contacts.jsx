import { useEffect, useState, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './logic/supabase'
import { fetchContacts, updateContact, fetchHeaders } from './logic/sheets'
import { getFreshToken } from './App'
import ColumnMapper from './ColumnMapper'

// ─── IndexedDB Cache ──────────────────────────────────────────────────────────
const CACHE_TTL = 1000 * 60 * 60 * 24 // 24 hours
const DB_NAME = 'rythm_cache'
const DB_VERSION = 1
const STORE = 'contacts'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(STORE, { keyPath: 'sheetId' })
    }
    req.onsuccess = e => resolve(e.target.result)
    req.onerror = e => reject(e.target.error)
  })
}

async function loadFromCache(sheetId) {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(sheetId)
      req.onsuccess = e => {
        const row = e.target.result
        if (!row) return resolve(null)
        if (Date.now() - row.timestamp > CACHE_TTL) {
          clearCache(sheetId)
          return resolve(null)
        }
        resolve(row.data)
      }
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

async function saveToCache(sheetId, data) {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put({ sheetId, data, timestamp: Date.now() })
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
    })
  } catch {}
}

async function clearCache(sheetId) {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(sheetId)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
    })
  } catch {}
}
// ─────────────────────────────────────────────────────────────────────────────

function normalizeColumnMapping(raw) {
  if (raw == null) return {}
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return raw
}

const BADGE_KEYS = new Set(['status', 'response'])

// ── CHANGE 1: buildColumns now reads ALL dataTypes from fieldTypes + extra ──
// Old code only read 'date'/'text' from e.dataType.
// Now it also picks up 'number', 'datetime', 'boolean', 'status', 'name'
// for both fixed fields (via columnMapping.fieldTypes) and extra fields.
function buildColumns(columnMapping) {
  const cols = []
  const fixedFields = [
    { key: 'organization', label: 'Organization' },
    { key: 'status',       label: 'Status' },
    { key: 'response',     label: 'Response' },
    { key: 'mobile_no',    label: 'Mobile' },
    { key: 'location',     label: 'Location' },
  ]
  const fieldTypes = columnMapping.fieldTypes || {}
  // typeSource distinguishes "the user picked text" from "nothing was ever saved".
  // Mappings created before column types shipped have no fieldTypes at all; those
  // get inferred from the data later (see inferDataType) instead of silently
  // defaulting to text, which would drop the sort controls with no error.
  fixedFields.forEach(({ key, label }) => {
    const idx = columnMapping[key]
    if (idx !== null && idx !== undefined) {
      const stored = fieldTypes[key]
      cols.push({
        key, label, colIndex: idx, type: 'fixed',
        dataType: stored || 'text',
        typeSource: stored ? 'stored' : 'default',
      })
    }
  })
  if (columnMapping.extra && Array.isArray(columnMapping.extra)) {
    columnMapping.extra.forEach((e) => {
      const { label, colIndex } = e
      if (colIndex !== null && colIndex !== undefined && label) {
        cols.push({
          key: `extra_${label}`, label, colIndex, type: 'extra',
          dataType: e.dataType || 'text',
          typeSource: e.dataType ? 'stored' : 'default',
        })
      }
    })
  }
  cols.sort((a, b) => a.colIndex - b.colIndex)
  return cols
}

function getCellValue(contact, col) {
  if (col.type === 'fixed') return contact[col.key] || ''
  return (contact.extra && contact.extra[col.label]) || ''
}

const EMPTY_SENTINEL = '__EMPTY__'
const NOTES_FILTER_KEY = '__notes__'
const NOTES_HAS = '__HAS_NOTES__'
const NOTES_NO = '__NO_NOTES__'

function parseSheetDate(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  const t = Date.parse(s)
  if (!Number.isNaN(t)) return t
  const m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/)
  if (m) {
    let a = +m[1], b = +m[2], y = +m[3]
    if (String(m[3]).length === 2) y += y >= 70 ? 1900 : 2000
    let day, month
    if (a > 12) { day = a; month = b }
    else if (b > 12) { month = a; day = b }
    else { month = a; day = b }
    const d = new Date(y, month - 1, day)
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  }
  const n = Number(s.replace(/,/g, ''))
  if (!Number.isNaN(n) && n > 20000 && n < 1000000) {
    const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000
    const d = new Date(ms)
    if (!Number.isNaN(d.getTime())) return d.getTime()
  }
  return null
}

// ── CHANGE 2: parseNumber helper for number-typed columns ──────────────────
function parseNumber(raw) {
  if (raw == null) return null
  const n = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''))
  return Number.isNaN(n) ? null : n
}

// Infers a column's type from its actual values, for mappings saved before
// column types existed. Numbers are tested first and separately: parseSheetDate
// reads a bare number as an Excel serial date, so an ID column would otherwise
// be classified as a date and sort nonsensically.
const NUMERIC_RE = /^-?\d[\d,]*(\.\d+)?$/
const INFER_SAMPLE_SIZE = 60
const INFER_CONFIDENCE = 0.8

function inferDataType(contacts, col) {
  let total = 0, numeric = 0, dated = 0
  for (const c of contacts) {
    if (total >= INFER_SAMPLE_SIZE) break
    const raw = String(getCellValue(c, col) ?? '').trim()
    if (!raw) continue
    total++
    if (NUMERIC_RE.test(raw)) { numeric++; continue }
    if (parseSheetDate(raw) !== null) dated++
  }
  if (total === 0) return 'text'
  if (numeric / total >= INFER_CONFIDENCE) return 'number'
  if (dated / total >= INFER_CONFIDENCE) return 'date'
  return 'text'
}

function uniqueValuesForColumn(contacts, col) {
  const seen = new Set()
  let hasBlank = false
  for (const c of contacts) {
    const v = String(getCellValue(c, col) ?? '').trim()
    if (v === '') hasBlank = true
    else seen.add(v)
  }
  const arr = [...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  if (hasBlank) arr.unshift(EMPTY_SENTINEL)
  return arr
}

function cellMatchesColumnFilter(c, col, selectedValues) {
  if (!selectedValues?.length) return true
  const raw = String(getCellValue(c, col) ?? '').trim()
  if (raw === '') return selectedValues.includes(EMPTY_SENTINEL)
  return selectedValues.includes(raw)
}

function FilterChevron({ open, active }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden
      style={{ flexShrink: 0, opacity: active ? 1 : 0.45, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
      <path d="M3 4.5L6 7.5L9 4.5" stroke={active ? '#4f46e5' : 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── CHANGE 3: SortButton now used for BOTH date and number columns ──────────
// Renamed from DateSortButton → SortButton, same visual, works for any sortable col.
function SortButton({ active, dir, onCycle, title }) {
  return (
    <button type="button"
      title={title || (active ? (dir === 'asc' ? 'Sorted low → high' : 'Sorted high → low') : 'Sort')}
      onClick={e => { e.stopPropagation(); onCycle() }}
      style={{ flexShrink: 0, padding: '2px 5px', margin: 0, border: 'none', background: active ? '#dbeafe' : 'transparent', cursor: 'pointer', borderRadius: '4px', fontSize: '12px', fontWeight: '700', color: active ? '#1d4ed8' : '#94a3b8', lineHeight: 1 }}>
      {active ? (dir === 'asc' ? '↑' : '↓') : '⇅'}
    </button>
  )
}

export default function Contacts({ activeSheet, sheets, session, onSwitchSheet, onAddSheet, onRemapDone, onSheetDeleted }) {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [cacheHit, setCacheHit] = useState(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)
  const [editing, setEditing] = useState(false)
  const [editData, setEditData] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState(false)
  const [panelWidth, setPanelWidth] = useState(480)
  const [dragging, setDragging] = useState(false)
  const [columnFilters, setColumnFilters] = useState({})
  const [openFilterCol, setOpenFilterCol] = useState(null)
  const [filterMenuPos, setFilterMenuPos] = useState(null)
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [colSort, setColSort] = useState(null) // { key, dir, dataType } — replaces dateSort
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768)
  const [sheetDropOpen, setSheetDropOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [remapping, setRemapping] = useState(false)
  const [remapHeaders, setRemapHeaders] = useState([])
  const [remapMapping, setRemapMapping] = useState({})
  const [remapSaving, setRemapSaving] = useState(false)
  const [tokenError, setTokenError] = useState(false)
  const [sheetError, setSheetError] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const sheetDropRef = useRef(null)
  const settingsRef = useRef(null)

  const userName = session.user.user_metadata?.full_name || session.user.email
  // These must be memoized: dynCols is a dependency of the uniqueOptionsByCol and
  // filtered memos below. Rebuilding the array on every render gave it a new
  // identity each time, so those memos never hit and every render recomputed
  // unique values across all rows for all columns — O(rows x columns) per
  // keystroke, which is what made filtering feel broken rather than merely slow.
  const columnMapping = useMemo(
    () => normalizeColumnMapping(activeSheet.column_mapping),
    [activeSheet.column_mapping]
  )
  const baseCols = useMemo(() => buildColumns(columnMapping), [columnMapping])

  // Fill in types for columns whose mapping predates the column-type feature.
  // Costs one pass over a sample of rows, and only when something is untyped.
  const dynCols = useMemo(() => {
    if (!contacts.length) return baseCols
    if (baseCols.every(c => c.typeSource === 'stored')) return baseCols
    return baseCols.map(c =>
      c.typeSource === 'stored' ? c : { ...c, dataType: inferDataType(contacts, c) }
    )
  }, [baseCols, contacts])

  // ── Load contacts (cache → fetch) ──────────────────────────────────────────
  useEffect(() => {
    setSelected(null)
    setEditing(false)
    setEditData(null)
    setTokenError(false)
    setSheetError(null)
    setSearch('')
    setColumnFilters({})
    setOpenFilterCol(null)
    setFilterMenuPos(null)
    setMobileFiltersOpen(false)
    setColSort(null)
    setCacheHit(null)
    setLoading(true)

    let cancelled = false

    loadFromCache(activeSheet.id).then(cached => {
      if (cancelled) return
      if (cached !== null) {
        setContacts(cached)
        setLoading(false)
        setCacheHit('cache')
      } else {
        loadContacts()
      }
    })

    const handleResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handleResize)
    return () => {
      cancelled = true
      window.removeEventListener('resize', handleResize)
    }
  }, [activeSheet.id])

  const loadContacts = async (sheet = activeSheet) => {
    const mapping = normalizeColumnMapping(sheet.column_mapping)
    setLoading(true)
    setSheetError(null)
    const accessToken = await getFreshToken()
    if (!accessToken) { setTokenError(true); setLoading(false); setCacheHit(null); return }

    try {
      const data = await fetchContacts(sheet.sheet_url, sheet.tab_name, accessToken, mapping)
      setContacts(data)
      await saveToCache(sheet.id, data)
      setCacheHit('live')
    } catch (e) {
      setSheetError(e?.message || 'Could not load your Google Sheet.')
      setContacts([])
      setCacheHit(null)
    }
    setLoading(false)
  }

  const handleRefresh = async () => {
    setCacheHit(null)
    setLoading(true)
    await clearCache(activeSheet.id)
    loadContacts(activeSheet)
  }

  // ── Close dropdowns on outside click ──────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (sheetDropRef.current && !sheetDropRef.current.contains(e.target)) setSheetDropOpen(false)
      if (settingsRef.current && !settingsRef.current.contains(e.target)) setSettingsOpen(false)
      if (!e.target.closest?.('[data-col-filter]') && !e.target.closest?.('[data-col-filter-portal]')) {
        setOpenFilterCol(null); setFilterMenuPos(null)
      }
    }
    const closeFilter = () => { setOpenFilterCol(null); setFilterMenuPos(null) }
    document.addEventListener('mousedown', handler)
    window.addEventListener('scroll', closeFilter, true)
    window.addEventListener('resize', closeFilter)
    return () => {
      document.removeEventListener('mousedown', handler)
      window.removeEventListener('scroll', closeFilter, true)
      window.removeEventListener('resize', closeFilter)
    }
  }, [])

  // ── Filters & sorting ─────────────────────────────────────────────────────
  const uniqueOptionsByCol = useMemo(() => {
    const out = {}
    for (const col of dynCols) out[col.key] = uniqueValuesForColumn(contacts, col)
    return out
  }, [contacts, dynCols])

  const toggleColumnFilterValue = (colKey, value) => {
    setColumnFilters(prev => {
      const cur = prev[colKey] || []
      const next = cur.includes(value) ? cur.filter(x => x !== value) : [...cur, value]
      const copy = { ...prev }
      if (next.length === 0) delete copy[colKey]
      else copy[colKey] = next
      return copy
    })
  }

  const clearColumnFilter = (colKey) => setColumnFilters(prev => { const c = { ...prev }; delete c[colKey]; return c })
  const clearAllColumnFilters = () => setColumnFilters({})

  const activeFilterCount = useMemo(
    () => Object.values(columnFilters).reduce((n, arr) => n + (arr?.length || 0), 0),
    [columnFilters]
  )
  const hasActiveColumnFilters = activeFilterCount > 0

  // ── CHANGE 4: sortable columns = date OR number ────────────────────────────
  const sortableColumns = useMemo(
    () => dynCols.filter(c => c.dataType === 'date' || c.dataType === 'datetime' || c.dataType === 'number'),
    [dynCols]
  )
  // Keep dateColumns alias so the mobile date-sort <select> still works
  const dateColumns = useMemo(() => dynCols.filter(c => c.dataType === 'date' || c.dataType === 'datetime'), [dynCols])

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    return contacts.filter(c => {
      const matchSearch = !q ||
        (c.full_name || '').toLowerCase().includes(q) ||
        (c.first_name || '').toLowerCase().includes(q) ||
        (c.organization || '').toLowerCase().includes(q) ||
        (c.location || '').toLowerCase().includes(q)
      if (!matchSearch) return false
      const nf = columnFilters[NOTES_FILTER_KEY]
      if (nf?.length) {
        const rowHas = !!(c.notes && String(c.notes).trim())
        if (!(nf.includes(NOTES_HAS) && rowHas) && !(nf.includes(NOTES_NO) && !rowHas)) return false
      }
      for (const col of dynCols) {
        const sel = columnFilters[col.key]
        if (sel?.length && !cellMatchesColumnFilter(c, col, sel)) return false
      }
      return true
    })
  }, [contacts, search, columnFilters, dynCols])

  // ── CHANGE 5: displayRows sorts by date OR number depending on dataType ────
  const displayRows = useMemo(() => {
    if (!colSort?.key || !colSort?.dir) return filtered
    const col = dynCols.find(c => c.key === colSort.key)
    if (!col) return filtered
    const mul = colSort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      let va, vb
      if (col.dataType === 'number') {
        va = parseNumber(getCellValue(a, col))
        vb = parseNumber(getCellValue(b, col))
      } else {
        // date or datetime
        va = parseSheetDate(getCellValue(a, col))
        vb = parseSheetDate(getCellValue(b, col))
      }
      if (va == null && vb == null) return 0
      if (va == null) return 1 * mul   // nulls to end
      if (vb == null) return -1 * mul
      return (va - vb) * mul
    })
  }, [filtered, colSort, dynCols])

  // ── CHANGE 6: cycleSort works for any col key (not just date) ─────────────
  const cycleSort = (colKey, dataType) => {
    setSelected(null)
    setColSort(prev => {
      if (prev?.key !== colKey) return { key: colKey, dir: 'asc', dataType }
      if (prev.dir === 'asc') return { key: colKey, dir: 'desc', dataType }
      return null
    })
  }

  // ── Filter popover ─────────────────────────────────────────────────────────
  const filterPopoverStyle = {
    position: 'fixed',
    top: filterMenuPos ? `${filterMenuPos.top}px` : 0,
    left: filterMenuPos ? `${filterMenuPos.left}px` : 0,
    minWidth: '200px',
    maxWidth: 'min(280px, calc(100vw - 24px))',
    maxHeight: 'min(280px, 50vh)',
    overflowY: 'auto',
    background: '#fff',
    borderRadius: '10px',
    boxShadow: '0 8px 28px rgba(0,0,0,0.12)',
    border: '1px solid #e8e8e8',
    padding: '8px 0',
    zIndex: 5000,
    textAlign: 'left',
    fontWeight: '400',
    textTransform: 'none',
    letterSpacing: 'normal',
  }

  const renderFilterOptions = (col) => {
    const options = uniqueOptionsByCol[col.key] || []
    const sel = columnFilters[col.key] || []
    if (options.length === 0) return <p style={{ padding: '8px 14px', margin: 0, fontSize: '12px', color: '#888' }}>No values yet.</p>
    return (
      <>
        {options.map(opt => (
          <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px', fontSize: '12px', color: '#333', cursor: 'pointer', userSelect: 'none' }} onMouseDown={e => e.preventDefault()}>
            <input type="checkbox" checked={sel.includes(opt)} onChange={() => toggleColumnFilterValue(col.key, opt)} style={{ accentColor: '#4f46e5', cursor: 'pointer' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt === EMPTY_SENTINEL ? '(Blanks)' : opt}</span>
          </label>
        ))}
        {sel.length > 0 && (
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => clearColumnFilter(col.key)}
            style={{ margin: '6px 14px 4px', padding: '6px 10px', fontSize: '11px', fontWeight: '600', color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', cursor: 'pointer', width: 'calc(100% - 28px)' }}>
            Clear this column
          </button>
        )}
      </>
    )
  }

  const renderNotesFilterOptions = () => {
    const sel = columnFilters[NOTES_FILTER_KEY] || []
    return (
      <>
        {[{ v: NOTES_HAS, label: 'Has notes' }, { v: NOTES_NO, label: 'No notes' }].map(({ v, label }) => (
          <label key={v} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px', fontSize: '12px', color: '#333', cursor: 'pointer', userSelect: 'none' }} onMouseDown={e => e.preventDefault()}>
            <input type="checkbox" checked={sel.includes(v)} onChange={() => toggleColumnFilterValue(NOTES_FILTER_KEY, v)} style={{ accentColor: '#4f46e5', cursor: 'pointer' }} />
            <span>{label}</span>
          </label>
        ))}
        {sel.length > 0 && (
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => clearColumnFilter(NOTES_FILTER_KEY)}
            style={{ margin: '6px 14px 4px', padding: '6px 10px', fontSize: '11px', fontWeight: '600', color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', cursor: 'pointer', width: 'calc(100% - 28px)' }}>
            Clear notes filter
          </button>
        )}
      </>
    )
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
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

  // ── Drag panel ─────────────────────────────────────────────────────────────
  const startDrag = (e) => {
    e.preventDefault()
    setDragging(true)
    const startX = e.clientX, startWidth = panelWidth
    const onMove = e => setPanelWidth(Math.min(Math.max(startWidth + (startX - e.clientX), 260), 700))
    const onUp = () => { setDragging(false); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ── Edit handlers ──────────────────────────────────────────────────────────
  const handleEdit = () => { setEditData({ ...displayRows[selected] }); setEditing(true) }
  const handleCancel = () => { setEditing(false); setEditData(null) }

  const handleSave = async () => {
    setSaving(true)
    const accessToken = await getFreshToken()
    if (!accessToken) { alert('Session expired. Please sign out and sign back in.'); setSaving(false); return }
    const success = await updateContact(activeSheet.sheet_url, activeSheet.tab_name, accessToken, editData, columnMapping)
    if (success) {
      const updated = contacts.map(c =>
        c.rowIndex === editData.rowIndex ? { ...editData, full_name: [editData.first_name, editData.middle_name, editData.last_name].filter(Boolean).join(' ') } : c
      )
      setContacts(updated)
      await saveToCache(activeSheet.id, updated)
      setEditing(false); setEditData(null); setSelected(null)
      setSaveMsg(true); setTimeout(() => setSaveMsg(false), 3000)
    } else {
      alert('Something went wrong. Try again.')
    }
    setSaving(false)
  }

  const handleStartRemap = async () => {
    setSettingsOpen(false)
    const accessToken = await getFreshToken()
    if (!accessToken) { alert('Session expired. Please sign out and sign back in.'); return }
    const fetched = await fetchHeaders(activeSheet.sheet_url, activeSheet.tab_name, accessToken)
    setRemapHeaders(fetched)
    setRemapMapping({ ...normalizeColumnMapping(activeSheet.column_mapping) })
    setRemapping(true)
  }

  const handleRemapConfirm = async (finalMapping) => {
    setRemapSaving(true)
    const { data, error } = await supabase.from('user_sheets').update({ column_mapping: finalMapping }).eq('id', activeSheet.id).select().single()
    if (!error && data) {
      await clearCache(activeSheet.id)
      onRemapDone(data)
      setRemapping(false)
      loadContacts(data)
    } else {
      alert('Could not save mapping. Try again.')
    }
    setRemapSaving(false)
  }

  const handleDeleteSheet = async () => {
    if (!window.confirm(`Delete "${activeSheet.sheet_name}"? This removes it from Rythm only — your Google Sheet is untouched.`)) return
    setDeleting(true)
    const { error } = await supabase.from('user_sheets').delete().eq('id', activeSheet.id)
    if (!error) { await clearCache(activeSheet.id); onSheetDeleted(activeSheet.id) }
    else { alert('Could not delete sheet. Try again.'); setDeleting(false) }
  }

  // ── Field renderers ────────────────────────────────────────────────────────
  const field = (label, key, multiline = false) => (
    <div style={{ marginBottom: '16px' }}>
      <p style={{ fontSize: '11px', fontWeight: '700', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 6px' }}>{label}</p>
      {multiline
        ? <textarea value={editData[key] || ''} onChange={e => setEditData({ ...editData, [key]: e.target.value })} rows={4}
            style={{ width: '100%', padding: '10px 12px', fontSize: '13px', border: '1px solid #ddd', borderRadius: '8px', outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: '1.5', color: '#333', boxSizing: 'border-box' }} />
        : <input type="text" value={editData[key] || ''} onChange={e => setEditData({ ...editData, [key]: e.target.value })}
            style={{ width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid #ddd', borderRadius: '8px', outline: 'none', color: '#333', boxSizing: 'border-box' }} />}
    </div>
  )

  const extraField = (label) => (
    <div key={label} style={{ marginBottom: '16px' }}>
      <p style={{ fontSize: '11px', fontWeight: '700', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 6px' }}>{label}</p>
      <input type="text" value={(editData.extra && editData.extra[label]) || ''}
        onChange={e => setEditData({ ...editData, extra: { ...editData.extra, [label]: e.target.value } })}
        style={{ width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid #ddd', borderRadius: '8px', outline: 'none', color: '#333', boxSizing: 'border-box' }} />
    </div>
  )

  // ── Panel ──────────────────────────────────────────────────────────────────
  const panelHeader = (contact) => (
    <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <div>
        <div style={{ width: '44px', height: '44px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', fontWeight: '800', marginBottom: '10px', ...avatarColor(contact.status) }}>
          {(contact.full_name || '?').charAt(0).toUpperCase()}
        </div>
        <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111', margin: 0 }}>{contact.full_name || '—'}</h2>
        <p style={{ fontSize: '13px', color: '#888', margin: '2px 0 0' }}>{contact.organization || '—'}</p>
      </div>
      <button onClick={() => { setSelected(null); setEditing(false); setEditData(null) }}
        style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#aaa' }}>x</button>
    </div>
  )

  const panelContent = (contact) => (
    <div style={{ padding: '16px 20px' }}>
      {!editing ? (
        <>
          {dynCols.map(({ key, label, type }) => {
            const value = type === 'fixed' ? contact[key] : (contact.extra && contact.extra[label])
            const isBadge = BADGE_KEYS.has(key)
            return (
              <div key={key} style={{ marginBottom: '14px' }}>
                <p style={{ fontSize: '11px', fontWeight: '700', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 4px' }}>{label}</p>
                {isBadge
                  ? <span style={{ padding: '4px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: '700', display: 'inline-block', ...statusStyle(value) }}>{value || '—'}</span>
                  : <p style={{ fontSize: '14px', color: '#333', margin: 0 }}>{value || '—'}</p>}
              </div>
            )
          })}
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
          {dynCols.map(({ key, label, type }) => type === 'fixed' ? field(label, key) : extraField(label))}
          {field('Notes', 'notes', true)}
          <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
            <button onClick={handleCancel} style={{ flex: 1, padding: '11px', fontSize: '14px', fontWeight: '600', background: '#f5f5f5', color: '#555', border: '1px solid #ddd', borderRadius: '10px', cursor: 'pointer' }}>Cancel</button>
            <button onClick={handleSave} disabled={saving} style={{ flex: 1, padding: '11px', fontSize: '14px', fontWeight: '600', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '10px', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  )

  // ── Helper: open filter button ─────────────────────────────────────────────
  const openFilter = (e, key) => {
    e.stopPropagation()
    if (openFilterCol === key) { setOpenFilterCol(null); setFilterMenuPos(null); return }
    const r = e.currentTarget.getBoundingClientRect()
    setFilterMenuPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 288)) })
    setOpenFilterCol(key)
  }

  // ── Early returns ──────────────────────────────────────────────────────────
  if (remapping) return <ColumnMapper headers={remapHeaders} initialMapping={remapMapping} onConfirm={handleRemapConfirm} onBack={() => setRemapping(false)} saving={remapSaving} />

  // Skeleton mirrors the real layout so the page keeps its shape while the
  // Sheets fetch is in flight, instead of flashing an empty screen.
  if (loading) return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <div className="app-header">
        <div className="skeleton" style={{ width: '132px', height: '20px' }} />
        <div style={{ flex: 1 }} />
        <div className="skeleton" style={{ width: '96px', height: '32px', borderRadius: 'var(--r-md)' }} />
      </div>
      <div style={{ padding: 'var(--s-5)', display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        <div className="skeleton" style={{ width: 'min(340px, 100%)', height: '38px', borderRadius: 'var(--r-md)' }} />
        <div className="card" style={{ padding: 'var(--s-2)', display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton skeleton-row" style={{ opacity: 1 - i * 0.09 }} />
          ))}
        </div>
      </div>
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }} role="status">
        Loading contacts
      </span>
    </div>
  )

  if (tokenError) return (
    <div className="empty-state" style={{ height: '100vh' }}>
      <h3>Your session expired</h3>
      <p>Google sign-ins expire periodically. Sign in again to reconnect your sheets.</p>
      <button className="btn btn-primary" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </div>
  )

  // ── Nav ────────────────────────────────────────────────────────────────────
  const nav = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', height: '56px', background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(10px)', borderBottom: '1px solid #e0e0e0', position: 'sticky', top: 0, zIndex: 100, width: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '18px', fontWeight: '900', letterSpacing: '3px', color: '#4f46e5' }}>RYTHM</span>

        <div ref={sheetDropRef} style={{ position: 'relative' }}>
          <button onClick={() => { setSheetDropOpen(p => !p); setSettingsOpen(false) }}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 10px', fontSize: '13px', fontWeight: '600', border: '1px solid #ddd', borderRadius: '8px', background: sheetDropOpen ? '#ede9fe' : '#fff', color: sheetDropOpen ? '#4f46e5' : '#333', cursor: 'pointer', outline: 'none' }}>
            {activeSheet.sheet_name}
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {sheetDropOpen && (
            <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, background: '#fff', borderRadius: '10px', boxShadow: '0 4px 20px rgba(0,0,0,0.12)', border: '1px solid #e8e8e8', minWidth: '200px', overflow: 'hidden', zIndex: 200 }}>
              {sheets.map(s => (
                <button key={s.id} onClick={() => { onSwitchSheet(s); setSheetDropOpen(false) }}
                  style={{ width: '100%', textAlign: 'left', padding: '10px 14px', fontSize: '13px', fontWeight: s.id === activeSheet.id ? '700' : '500', background: s.id === activeSheet.id ? '#f5f3ff' : '#fff', color: s.id === activeSheet.id ? '#4f46e5' : '#333', border: 'none', cursor: 'pointer', display: 'block', borderBottom: '1px solid #f5f5f5' }}>
                  {s.sheet_name}{s.id === activeSheet.id && <span style={{ fontSize: '11px', color: '#a5b4fc', marginLeft: '8px' }}>Active</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <span style={{ fontSize: '11px', background: '#ede9fe', padding: '3px 10px', borderRadius: '20px', color: '#4f46e5', fontWeight: '600' }}>
          {contacts.length.toLocaleString()}
        </span>

        <button onClick={handleRefresh} title="Refresh from Google Sheet"
          style={{ fontSize: '12px', fontWeight: '600', color: cacheHit === 'cache' ? '#4f46e5' : cacheHit === 'live' ? '#16a34a' : '#aaa', background: 'none', border: '1px solid #e0e0e0', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer' }}>
          {cacheHit === 'cache' ? 'Cached' : cacheHit === 'live' ? 'Live · Refresh' : 'Refresh'}
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: '#4f46e5', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '700', flexShrink: 0 }}>
          {userName.charAt(0).toUpperCase()}
        </div>
        <span style={{ fontSize: '13px', color: '#333', fontWeight: '500', maxWidth: isMobile ? '70px' : '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isMobile ? userName.split(' ')[0] : userName}
        </span>
        <div ref={settingsRef} style={{ position: 'relative' }}>
          <button onClick={() => { setSettingsOpen(p => !p); setSheetDropOpen(false) }}
            style={{ padding: '5px 10px', fontSize: '12px', fontWeight: '600', border: '1px solid #ddd', borderRadius: '6px', background: settingsOpen ? '#ede9fe' : '#fff', color: settingsOpen ? '#4f46e5' : '#666', cursor: 'pointer', outline: 'none' }}>
            Settings
          </button>
          {settingsOpen && (
            <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, background: '#fff', borderRadius: '10px', boxShadow: '0 4px 20px rgba(0,0,0,0.12)', border: '1px solid #e8e8e8', minWidth: '180px', overflow: 'hidden', zIndex: 200 }}>
              {[
                { label: 'Add New Sheet', action: () => { setSettingsOpen(false); onAddSheet() } },
                { label: 'Re-map Columns', action: handleStartRemap },
                { label: deleting ? 'Deleting...' : 'Delete This Sheet', action: handleDeleteSheet, danger: true },
                { label: 'Sign Out', action: () => supabase.auth.signOut(), danger: true },
              ].map(({ label, action, danger }) => (
                <button key={label} onClick={action}
                  style={{ width: '100%', textAlign: 'left', padding: '11px 16px', fontSize: '13px', fontWeight: '500', background: '#fff', color: danger ? '#dc2626' : '#333', border: 'none', borderBottom: '1px solid #f5f5f5', cursor: 'pointer', display: 'block' }}
                  onMouseEnter={e => e.currentTarget.style.background = danger ? '#fef2f2' : '#f9f8ff'}
                  onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )

  // ── Table header cell with filter ──────────────────────────────────────────
  const thFilterBtn = (key, hasFilter) => (
    <button type="button" data-col-filter title="Filter" onClick={e => openFilter(e, key)}
      style={{ flexShrink: 0, padding: '2px 4px', margin: 0, border: 'none', background: hasFilter ? '#ede9fe' : 'transparent', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', color: '#666' }}>
      <FilterChevron open={openFilterCol === key} active={hasFilter} />
    </button>
  )

  // ── Mobile search/filters bar ──────────────────────────────────────────────
  const searchAndFilters = (
    <div style={{ padding: '16px 16px 8px' }}>
      <input type="text" placeholder="Search name, organization, location…" value={search} onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', padding: '11px 18px', fontSize: '14px', border: '1px solid #ddd', borderRadius: '10px', outline: 'none', background: '#fff', marginBottom: '10px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', boxSizing: 'border-box' }} />
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" onClick={() => setMobileFiltersOpen(true)}
          style={{ padding: '10px 14px', fontSize: '13px', fontWeight: '600', border: `1.5px solid ${hasActiveColumnFilters ? '#4f46e5' : '#ddd'}`, borderRadius: '10px', background: hasActiveColumnFilters ? '#ede9fe' : '#fff', color: hasActiveColumnFilters ? '#4f46e5' : '#555', cursor: 'pointer' }}>
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </button>
        {(search || hasActiveColumnFilters || colSort) && (
          <button type="button" onClick={() => { setSearch(''); clearAllColumnFilters(); setColSort(null); setSelected(null) }}
            style={{ padding: '10px 12px', fontSize: '13px', fontWeight: '600', border: '1.5px solid #fca5a5', borderRadius: '10px', background: '#fef2f2', color: '#dc2626', cursor: 'pointer' }}>
            Clear all
          </button>
        )}
      </div>
      {(search || hasActiveColumnFilters || colSort) && (
        <p style={{ fontSize: '12px', color: '#888', margin: '8px 0 0' }}>{displayRows.length.toLocaleString()} shown</p>
      )}
    </div>
  )

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        .contact-row:hover { background: #f9f8ff !important; }
        .contact-row.active { background: #ede9fe !important; }
        .contact-card:hover { border-color: #a5b4fc !important; }
        * { box-sizing: border-box; }
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes slideUp { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      `}</style>

      <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif', minHeight: '100vh', background: 'linear-gradient(135deg, #ece9f7 0%, #e8f0fe 100%)', width: '100%', overflowX: 'hidden' }}>
        {nav}

        {sheetError && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', justifyContent: 'space-between', flexWrap: 'wrap', padding: '12px 16px', background: '#fef2f2', borderBottom: '1px solid #fecaca', color: '#991b1b', fontSize: '13px' }}>
            <span>{sheetError}</span>
            <button type="button" onClick={() => { clearCache(activeSheet.id); loadContacts(activeSheet) }}
              style={{ padding: '6px 14px', fontSize: '12px', fontWeight: '600', background: '#fff', color: '#991b1b', border: '1px solid #fca5a5', borderRadius: '8px', cursor: 'pointer' }}>
              Retry
            </button>
          </div>
        )}

        {/* Filter portal for desktop */}
        {!isMobile && openFilterCol && filterMenuPos && createPortal(
          <div data-col-filter-portal style={filterPopoverStyle} onClick={e => e.stopPropagation()}>
            <p style={{ margin: '0 0 6px', padding: '0 14px', fontSize: '10px', fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
              {openFilterCol === NOTES_FILTER_KEY ? 'Notes' : dynCols.find(c => c.key === openFilterCol)?.label}
            </p>
            {openFilterCol === NOTES_FILTER_KEY
              ? renderNotesFilterOptions()
              : (() => { const col = dynCols.find(c => c.key === openFilterCol); return col ? renderFilterOptions(col) : null })()}
          </div>,
          document.body
        )}

        {isMobile ? (
          <div>
            {searchAndFilters}

            {mobileFiltersOpen && (
              <div style={{ position: 'fixed', inset: 0, zIndex: 450, background: 'rgba(0,0,0,0.4)' }} onClick={() => setMobileFiltersOpen(false)}>
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: '78vh', background: '#fff', borderRadius: '16px 16px 0 0', overflow: 'hidden', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                  <div style={{ width: '40px', height: '4px', background: '#ddd', borderRadius: '2px', margin: '10px auto 0' }} />
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px', borderBottom: '1px solid #eee' }}>
                    <span style={{ fontSize: '16px', fontWeight: '700', color: '#111' }}>Filters</span>
                    <button type="button" onClick={() => setMobileFiltersOpen(false)} style={{ fontSize: '14px', fontWeight: '600', color: '#4f46e5', border: 'none', background: 'none', cursor: 'pointer' }}>Done</button>
                  </div>
                  <div style={{ overflowY: 'auto', padding: '8px 0 24px', flex: 1 }}>
                    <div style={{ marginBottom: '16px', padding: '0 16px' }}>
                      <p style={{ fontSize: '11px', fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 8px' }}>Notes</p>
                      <div style={{ border: '1px solid #e8e8e8', borderRadius: '10px', padding: '6px 0', background: '#fafafa' }}>{renderNotesFilterOptions()}</div>
                    </div>
                    {dynCols.map(col => (
                      <div key={col.key} style={{ marginBottom: '16px', padding: '0 16px' }}>
                        <p style={{ fontSize: '11px', fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 8px' }}>{col.label}</p>
                        <div style={{ border: '1px solid #e8e8e8', borderRadius: '10px', padding: '6px 0', background: '#fafafa' }}>{renderFilterOptions(col)}</div>
                      </div>
                    ))}
                  </div>
                  {hasActiveColumnFilters && (
                    <div style={{ padding: '12px 16px', borderTop: '1px solid #eee' }}>
                      <button type="button" onClick={clearAllColumnFilters}
                        style={{ width: '100%', padding: '12px', fontSize: '14px', fontWeight: '600', color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '10px', cursor: 'pointer' }}>
                        Clear all filters
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div style={{ padding: '0 12px 100px' }}>
              {displayRows.map((c, i) => (
                <div key={i} className="contact-card" onClick={() => { setSelected(i); setEditing(false); setEditData(null) }}
                  style={{ background: '#fff', borderRadius: '14px', border: '1px solid #e8e8e8', padding: '14px 16px', marginBottom: '10px', cursor: 'pointer', transition: 'border-color 0.15s' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
                    <div style={{ width: '40px', height: '40px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: '700', flexShrink: 0, ...avatarColor(c.status) }}>
                      {(c.full_name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: '15px', fontWeight: '600', color: '#111', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.first_name || c.full_name || '—'}</p>
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

            {selected !== null && displayRows[selected] && (
              <div style={{ position: 'fixed', inset: 0, zIndex: 200 }}>
                <div onClick={() => { setSelected(null); setEditing(false); setEditData(null) }} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: '#fff', borderRadius: '20px 20px 0 0', maxHeight: '85vh', overflowY: 'auto', animation: 'slideUp 0.25s ease' }}>
                  <div style={{ width: '40px', height: '4px', background: '#ddd', borderRadius: '2px', margin: '12px auto 0' }} />
                  {panelHeader(displayRows[selected])}
                  {panelContent(displayRows[selected])}
                </div>
              </div>
            )}
          </div>

        ) : (
          <div style={{ display: 'flex', height: 'calc(100vh - 56px)', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', padding: '20px 24px' }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' }}>
                <input type="text" placeholder="Search name, organization, location…" value={search} onChange={e => setSearch(e.target.value)}
                  style={{ flex: 1, minWidth: '200px', padding: '11px 18px', fontSize: '14px', border: '1px solid #ddd', borderRadius: '10px', outline: 'none', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }} />

                {/* ── CHANGE 7: sort dropdown now covers number cols too ── */}
                {sortableColumns.length > 0 && (
                  <select value={colSort ? `${colSort.key}:${colSort.dir}` : ''}
                    onChange={e => {
                      setSelected(null)
                      const v = e.target.value
                      if (!v) { setColSort(null); return }
                      const [k, d] = v.split(':')
                      const col = dynCols.find(c => c.key === k)
                      setColSort({ key: k, dir: d, dataType: col?.dataType })
                    }}
                    style={{ padding: '10px 12px', fontSize: '13px', borderRadius: '10px', border: '1px solid #ddd', background: '#fff', color: '#333', cursor: 'pointer' }}>
                    <option value="">Sort: none</option>
                    {sortableColumns.flatMap(c => {
                      const isNum = c.dataType === 'number'
                      return [
                        <option key={`${c.key}:asc`} value={`${c.key}:asc`}>{c.label} · {isNum ? 'low → high' : 'oldest first'}</option>,
                        <option key={`${c.key}:desc`} value={`${c.key}:desc`}>{c.label} · {isNum ? 'high → low' : 'newest first'}</option>,
                      ]
                    })}
                  </select>
                )}

                {(search || hasActiveColumnFilters || colSort) && (
                  <button type="button" onClick={() => { setSearch(''); clearAllColumnFilters(); setColSort(null); setSelected(null) }}
                    style={{ padding: '11px 14px', fontSize: '13px', fontWeight: '600', border: '1.5px solid #fca5a5', borderRadius: '10px', background: '#fef2f2', color: '#dc2626', cursor: 'pointer', flexShrink: 0 }}>
                    Clear all
                  </button>
                )}
              </div>

              {(search || hasActiveColumnFilters || colSort) && (
                <p style={{ fontSize: '13px', color: '#666', marginBottom: '10px' }}>
                  {displayRows.length.toLocaleString()} shown
                  {search && ` · "${search}"`}
                  {hasActiveColumnFilters && ` · ${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'}`}
                  {colSort && ` · ${dynCols.find(c => c.key === colSort.key)?.label} ${colSort.dir === 'asc' ? (colSort.dataType === 'number' ? 'low → high' : 'oldest first') : (colSort.dataType === 'number' ? 'high → low' : 'newest first')}`}
                </p>
              )}

              <div style={{ background: '#fff', borderRadius: '14px', boxShadow: '0 2px 12px rgba(79,70,229,0.08)', overflow: 'visible' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
                    <thead>
                      <tr style={{ background: '#faf9ff', borderBottom: '2px solid #ede9fe' }}>
                        <th style={th}>Name</th>
                        {dynCols.map(col => {
                          const hasFilter = (columnFilters[col.key] || []).length > 0
                          const isSortable = col.dataType === 'date' || col.dataType === 'datetime' || col.dataType === 'number'
                          const sortTitle = col.dataType === 'number'
                            ? (colSort?.key === col.key ? (colSort.dir === 'asc' ? 'Sorted low → high' : 'Sorted high → low') : 'Sort by number')
                            : (colSort?.key === col.key ? (colSort.dir === 'asc' ? 'Sorted oldest → newest' : 'Sorted newest → oldest') : 'Sort by date')
                          return (
                            <th key={col.key} style={{ ...th, position: 'relative' }}>
                              <div data-col-filter style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', maxWidth: '100%' }}>
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{col.label}</span>
                                {/* ── CHANGE 8: SortButton shown for date OR number ── */}
                                {isSortable && (
                                  <SortButton
                                    active={colSort?.key === col.key}
                                    dir={colSort?.dir}
                                    onCycle={() => cycleSort(col.key, col.dataType)}
                                    title={sortTitle}
                                  />
                                )}
                                {thFilterBtn(col.key, hasFilter)}
                              </div>
                            </th>
                          )
                        })}
                        <th style={{ ...th, textAlign: 'center' }}>
                          <div data-col-filter style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', justifyContent: 'center' }}>
                            <span>Notes</span>
                            {thFilterBtn(NOTES_FILTER_KEY, (columnFilters[NOTES_FILTER_KEY] || []).length > 0)}
                          </div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayRows.map((c, i) => (
                        <tr key={i} className={`contact-row${selected === i ? ' active' : ''}`}
                          style={{ borderBottom: '1px solid #f5f5f5', cursor: 'pointer', background: 'transparent' }}
                          onClick={() => { setSelected(selected === i ? null : i); setEditing(false); setEditData(null) }}>
                          <td style={{ ...td, fontWeight: '600', color: '#4f46e5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'underline', textDecorationColor: '#c7d2fe', maxWidth: '140px' }}>{c.full_name || '—'}</td>
                          {dynCols.map(col => {
                            const val = getCellValue(c, col)
                            return (
                              <td key={col.key} style={{ ...td, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '110px' }}>
                                {BADGE_KEYS.has(col.key) && val
                                  ? <span style={{ padding: '2px 7px', borderRadius: '20px', fontSize: '10px', fontWeight: '700', display: 'inline-block', ...statusStyle(val) }}>{val}</span>
                                  : <span style={{ color: '#555', fontSize: '12px' }}>{val || '—'}</span>}
                              </td>
                            )
                          })}
                          <td style={{ ...td, textAlign: 'center', fontSize: '14px' }}>{c.notes ? <span style={{ color: '#4f46e5' }}>●</span> : <span style={{ color: '#ddd' }}>○</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {selected !== null && displayRows[selected] && (
              <>
                <div onMouseDown={startDrag}
                  style={{ width: '5px', cursor: 'col-resize', background: dragging ? '#4f46e5' : 'transparent', transition: 'background 0.2s', flexShrink: 0, zIndex: 10 }}
                  onMouseEnter={e => e.currentTarget.style.background = '#c7d2fe'}
                  onMouseLeave={e => { if (!dragging) e.currentTarget.style.background = 'transparent' }} />
                <div style={{ width: `${panelWidth}px`, minWidth: '260px', background: '#fff', borderLeft: '1px solid #e0e0e0', overflowY: 'auto', boxShadow: '-4px 0 20px rgba(79,70,229,0.08)', animation: 'slideIn 0.2s ease', flexShrink: 0 }}>
                  {panelHeader(displayRows[selected])}
                  {panelContent(displayRows[selected])}
                </div>
              </>
            )}
          </div>
        )}

        {saveMsg && (
          <div style={{ position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)', background: '#166534', color: '#fff', padding: '12px 24px', borderRadius: '10px', fontSize: '14px', fontWeight: '600', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 999, animation: 'slideUp 0.2s ease' }}>
            Saved to Google Sheet
          </div>
        )}
      </div>
    </>
  )
}

const th = { padding: '9px 10px', textAlign: 'left', fontSize: '10px', fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: '0.4px', overflow: 'visible', whiteSpace: 'nowrap' }
const td = { padding: '9px 10px', fontSize: '12px' }