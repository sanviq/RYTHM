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
  } catch {
    // Cache writes are best-effort: a failure here must not break loading.
  }
}

async function clearCache(sheetId) {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(sheetId)
      req.onsuccess = () => resolve()
      req.onerror = () => resolve()
    })
  } catch {
    // Same: eviction failing is not worth surfacing to the user.
  }
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
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
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
  const n = parseFloat(String(raw).replace(/[^0-9.-]/g, ''))
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

// ── Row virtualization ───────────────────────────────────────────────────────
// With 15k rows the table put ~200k-400k elements in the DOM, which is well past
// where browsers keep scrolling smooth. This renders only the rows near the
// viewport and reserves the rest of the height with two spacer rows, so the
// scrollbar and page geometry are unchanged.
//
// It virtualizes against the *window* rather than an inner scroll container, so
// the existing page scroll and the sticky header keep working as before.
// Read from CSS so --row-h is the single source of truth; restyling row padding
// no longer silently desyncs the virtualizer's offset-to-index arithmetic.
const ROW_HEIGHT_FALLBACK = 44
function readRowHeight() {
  if (typeof window === 'undefined') return ROW_HEIGHT_FALLBACK
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--row-h')
  const n = parseFloat(raw)
  return Number.isFinite(n) && n > 0 ? n : ROW_HEIGHT_FALLBACK
}
const OVERSCAN = 8         // rows kept beyond each edge, to hide fast scrolling
const VIRTUALIZE_ABOVE = 100
const OPTION_RENDER_CAP = 200   // filter-popover options rendered at once

function useWindowVirtual(totalRows, enabled) {
  const anchorRef = useRef(null)
  // Measured once on mount rather than hardcoded, so --row-h stays authoritative.
  const [rowH] = useState(readRowHeight)
  // Start narrow when virtualizing, or the very first paint would mount every
  // row before the effect below has a chance to shrink the window.
  const [range, setRange] = useState(() => ({
    start: 0,
    end: enabled ? Math.min(totalRows, 60) : totalRows,
  }))

  useEffect(() => {
    if (!enabled) return
    let frame = 0
    const compute = () => {
      frame = 0
      const el = anchorRef.current
      if (!el) return
      // Spacers keep the tbody's document position fixed, so its distance above
      // the viewport is exactly how far we've scrolled into the rows.
      const scrolledPast = Math.max(0, -el.getBoundingClientRect().top)
      const start = Math.max(0, Math.floor(scrolledPast / rowH) - OVERSCAN)
      const visible = Math.ceil(window.innerHeight / rowH) + OVERSCAN * 2
      const end = Math.min(totalRows, start + visible)
      setRange(prev => (prev.start === start && prev.end === end) ? prev : { start, end })
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(compute) }
    // Deferred rather than called inline: measuring synchronously here would set
    // state during the effect and cascade an extra render. The initial 60-row
    // window covers the first frame until this lands.
    frame = requestAnimationFrame(compute)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [totalRows, enabled, rowH])

  // Derived rather than stored when disabled, so the effect never has to write
  // state just to represent "render everything".
  if (!enabled) return { anchorRef, rowH, start: 0, end: totalRows }
  return { anchorRef, rowH, start: range.start, end: Math.min(range.end, totalRows) }
}

// The mobile cards have variable heights, so the fixed-height windowing used by
// the table doesn't apply. Render a page at a time and extend as the user nears
// the bottom — same effect on the initial paint, no height arithmetic.
const MOBILE_PAGE = 40

function useIncremental(totalRows, enabled) {
  // Keeps the row count it was built for, so a change in the filtered list is
  // detectable during render — resetting via an effect would set state
  // synchronously and cascade an extra render.
  const [state, setState] = useState(() => ({ total: totalRows, count: enabled ? Math.min(totalRows, MOBILE_PAGE) : totalRows }))
  const count = state.total === totalRows ? state.count : Math.min(totalRows, MOBILE_PAGE)

  useEffect(() => {
    if (!enabled) return
    let frame = 0
    const check = () => {
      frame = 0
      const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 600
      if (!nearBottom) return
      // Updated inline rather than through a helper closed over totalRows:
      // as a dependency the helper was correct only because totalRows happened
      // to be in this array too, which is a stale-closure bug waiting to happen.
      setState(prev => {
        const base = prev.total === totalRows ? prev.count : Math.min(totalRows, MOBILE_PAGE)
        return { total: totalRows, count: base >= totalRows ? base : Math.min(totalRows, base + MOBILE_PAGE) }
      })
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(check) }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [totalRows, enabled])


  return enabled ? Math.min(count, totalRows) : totalRows
}

function FilterChevron({ open, active }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden
      style={{ flexShrink: 0, opacity: active ? 1 : 0.45, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
      <path d="M3 4.5L6 7.5L9 4.5" stroke={active ? 'var(--accent)' : 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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
      style={{ flexShrink: 0, padding: '2px 5px', margin: 0, border: 'none', background: active ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', borderRadius: '4px', fontSize: '12px', fontWeight: '700', color: active ? 'var(--info)' : 'var(--text-subtle)', lineHeight: 1 }}>
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
  const [saveError, setSaveError] = useState(null)
  const [panelWidth, setPanelWidth] = useState(480)
  const [dragging, setDragging] = useState(false)
  const [columnFilters, setColumnFilters] = useState({})
  const [openFilterCol, setOpenFilterCol] = useState(null)
  const [optionQuery, setOptionQuery] = useState('')
  const [filterMenuPos, setFilterMenuPos] = useState(null)
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  const [filterMode, setFilterMode] = useState('all') // 'all' = AND across columns, 'any' = OR
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
    setSaveError(null)
    setTokenError(false)
    setSheetError(null)
    setSearch('')
    setColumnFilters({})
    setFilterMode('all')
    setOpenFilterCol(null)
    setOptionQuery('')
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
        setOpenFilterCol(null); setFilterMenuPos(null); setOptionQuery('')
      }
    }
    // Registered in capture phase so page and table scrolls dismiss the popover
    // — it is fixed-positioned and would otherwise detach from its header cell.
    // That also catches scrolls *inside* the popover, which must not close it:
    // on a column with many values, scrolling the list is the whole point.
    const closeFilter = (e) => {
      const t = e?.target
      if (t && typeof t.closest === 'function' && t.closest('[data-col-filter-portal]')) return
      setOpenFilterCol(null); setFilterMenuPos(null); setOptionQuery('')
    }
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

  const filtered = useMemo(() => {
    const q = search.toLowerCase()
    // Values within one column always OR together (picking HOT and WARM means
    // either). filterMode decides how separate columns combine: 'all' requires
    // every filtered column to match, 'any' accepts a row matching just one.
    // Search is deliberately outside that choice — it narrows whatever the
    // filters produced, rather than widening it.
    const matchAny = filterMode === 'any'

    // Built once per filter change, not once per row. Previously every row
    // walked all 12 columns even when a single filter was set, and membership
    // was a linear `includes` scan; both are now proportional to the number of
    // *active* filters, with Set lookups.
    const active = []
    for (const col of dynCols) {
      const sel = columnFilters[col.key]
      if (sel?.length) active.push({ col, set: new Set(sel) })
    }
    const nf = columnFilters[NOTES_FILTER_KEY]
    const notesWants = nf?.length ? { has: nf.includes(NOTES_HAS), no: nf.includes(NOTES_NO) } : null
    const hasFilters = active.length > 0 || notesWants !== null

    return contacts.filter(c => {
      if (q) {
        const hit =
          (c.full_name || '').toLowerCase().includes(q) ||
          (c.first_name || '').toLowerCase().includes(q) ||
          (c.organization || '').toLowerCase().includes(q) ||
          (c.location || '').toLowerCase().includes(q)
        if (!hit) return false
      }
      if (!hasFilters) return true

      // 'all' bails on the first failure, 'any' on the first success.
      if (notesWants) {
        const rowHas = !!(c.notes && String(c.notes).trim())
        const ok = (notesWants.has && rowHas) || (notesWants.no && !rowHas)
        if (matchAny) { if (ok) return true } else if (!ok) return false
      }
      for (const { col, set } of active) {
        const raw = String(getCellValue(c, col) ?? '').trim()
        const ok = raw === '' ? set.has(EMPTY_SENTINEL) : set.has(raw)
        if (matchAny) { if (ok) return true } else if (!ok) return false
      }
      // 'all' reaching here means nothing failed; 'any' means nothing matched.
      return !matchAny
    })
  }, [contacts, search, columnFilters, dynCols, filterMode])

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

  // Desktop table only; the mobile card list has variable heights.
  const virtualOn = !isMobile && displayRows.length > VIRTUALIZE_ABOVE
  const { anchorRef: tbodyRef, rowH: vRowH, start: vStart, end: vEnd } = useWindowVirtual(displayRows.length, virtualOn)
  const mobileOn = isMobile && displayRows.length > MOBILE_PAGE
  const mobileCount = useIncremental(displayRows.length, mobileOn)

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
    maxHeight: 'min(380px, 60vh)',
    overflowY: 'auto',
    background: 'var(--surface)',
    borderRadius: '10px',
    boxShadow: '0 8px 28px rgba(0,0,0,0.12)',
    border: '1px solid var(--border)',
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
    if (options.length === 0) return <p style={{ padding: '8px 14px', margin: 0, fontSize: '12px', color: 'var(--text-subtle)' }}>No values yet.</p>

    // High-cardinality columns (mobile numbers, names) have as many distinct
    // values as rows. Rendering them all mounted ~45k elements in a dropdown —
    // slow, and unusable anyway since you cannot scan 15k checkboxes. Selected
    // values are always shown so a filter can never be hidden by the cap.
    const selSet = new Set(sel)
    const q = optionQuery.trim().toLowerCase()
    const matching = q
      ? options.filter(o => (o === EMPTY_SENTINEL ? '(blanks)' : String(o)).toLowerCase().includes(q))
      : options
    const shown = matching.slice(0, OPTION_RENDER_CAP)
    const hidden = matching.length - shown.length
    const pinned = sel.filter(v => !shown.includes(v))
    const visible = [...pinned, ...shown]

    return (
      <>
        {options.length > OPTION_RENDER_CAP && (
          <div style={{
            position: 'sticky', top: 0, zIndex: 1,
            padding: '4px 14px 8px',
            background: 'var(--surface)',
            borderBottom: '1px solid var(--border)',
          }}>
            <input
              className="input" type="search" value={optionQuery} autoFocus
              placeholder={`Search ${options.length.toLocaleString()} values…`}
              onChange={e => setOptionQuery(e.target.value)}
              onMouseDown={e => e.stopPropagation()}
              style={{ fontSize: '12px', padding: '6px 10px' }}
            />
          </div>
        )}
        {visible.map(opt => (
          <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px', fontSize: '12px', color: 'var(--text)', cursor: 'pointer', userSelect: 'none' }} onMouseDown={e => e.preventDefault()}>
            <input type="checkbox" checked={selSet.has(opt)} onChange={() => toggleColumnFilterValue(col.key, opt)} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt === EMPTY_SENTINEL ? '(Blanks)' : opt}</span>
          </label>
        ))}
        {hidden > 0 && (
          <p style={{ padding: '6px 14px', margin: 0, fontSize: '11px', color: 'var(--text-subtle)' }}>
            {hidden.toLocaleString()} more — type to narrow
          </p>
        )}
        {q && matching.length === 0 && (
          <p style={{ padding: '8px 14px', margin: 0, fontSize: '12px', color: 'var(--text-subtle)' }}>No match.</p>
        )}
        {sel.length > 0 && (
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => clearColumnFilter(col.key)}
            className="btn btn-sm" style={{ margin: 'var(--s-2) var(--s-4) var(--s-1)', color: 'var(--danger)', background: 'var(--danger-soft)', width: 'calc(100% - 28px)' }}>
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
          <label key={v} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 14px', fontSize: '12px', color: 'var(--text)', cursor: 'pointer', userSelect: 'none' }} onMouseDown={e => e.preventDefault()}>
            <input type="checkbox" checked={sel.includes(v)} onChange={() => toggleColumnFilterValue(NOTES_FILTER_KEY, v)} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
            <span>{label}</span>
          </label>
        ))}
        {sel.length > 0 && (
          <button type="button" onMouseDown={e => e.preventDefault()} onClick={() => clearColumnFilter(NOTES_FILTER_KEY)}
            className="btn btn-sm" style={{ margin: 'var(--s-2) var(--s-4) var(--s-1)', color: 'var(--danger)', background: 'var(--danger-soft)', width: 'calc(100% - 28px)' }}>
            Clear notes filter
          </button>
        )}
      </>
    )
  }

  // ── Styles ─────────────────────────────────────────────────────────────────
  const statusStyle = (val) => {
    const s = (val || '').toUpperCase()
    if (s === 'HOT') return { background: 'var(--danger-soft)', color: 'var(--danger)' }
    if (s === 'WARM') return { background: 'var(--warning-soft)', color: 'var(--warning)' }
    if (s === 'COLD') return { background: 'var(--info-soft)', color: 'var(--info)' }
    return { background: 'var(--surface-sunk)', color: 'var(--text-subtle)' }
  }

  const avatarColor = (val) => {
    const s = (val || '').toUpperCase()
    if (s === 'HOT') return { background: 'var(--danger-soft)', color: 'var(--danger)' }
    if (s === 'WARM') return { background: 'var(--warning-soft)', color: 'var(--warning)' }
    return { background: 'var(--accent-soft)', color: 'var(--accent)' }
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
    setSaveError(null)
    const accessToken = await getFreshToken()
    if (!accessToken) { alert('Session expired. Please sign out and sign back in.'); setSaving(false); return }
    try {
      await updateContact(activeSheet.sheet_url, activeSheet.tab_name, accessToken, editData, columnMapping)
      const updated = contacts.map(c =>
        c.rowIndex === editData.rowIndex ? { ...editData, full_name: [editData.first_name, editData.middle_name, editData.last_name].filter(Boolean).join(' ') } : c
      )
      setContacts(updated)
      await saveToCache(activeSheet.id, updated)
      setEditing(false); setEditData(null); setSelected(null)
      setSaveMsg(true); setTimeout(() => setSaveMsg(false), 3000)
    } catch (e) {
      // Show what Google actually rejected — a generic message here hid a
      // malformed-range bug that broke saving on every sheet.
      setSaveError(e?.message || 'Could not save to your Google Sheet.')
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
      <p style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 6px' }}>{label}</p>
      {multiline
        ? <textarea value={editData[key] || ''} onChange={e => setEditData({ ...editData, [key]: e.target.value })} rows={4}
            style={{ width: '100%', padding: '10px 12px', fontSize: '13px', border: '1px solid var(--border-strong)', borderRadius: '8px', outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: '1.5', color: 'var(--text)', boxSizing: 'border-box' }} />
        : <input type="text" value={editData[key] || ''} onChange={e => setEditData({ ...editData, [key]: e.target.value })}
            style={{ width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid var(--border-strong)', borderRadius: '8px', outline: 'none', color: 'var(--text)', boxSizing: 'border-box' }} />}
    </div>
  )

  const extraField = (label) => (
    <div key={label} style={{ marginBottom: '16px' }}>
      <p style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 6px' }}>{label}</p>
      <input type="text" value={(editData.extra && editData.extra[label]) || ''}
        onChange={e => setEditData({ ...editData, extra: { ...editData.extra, [label]: e.target.value } })}
        style={{ width: '100%', padding: '8px 12px', fontSize: '13px', border: '1px solid var(--border-strong)', borderRadius: '8px', outline: 'none', color: 'var(--text)', boxSizing: 'border-box' }} />
    </div>
  )

  // ── Panel ──────────────────────────────────────────────────────────────────
  const panelHeader = (contact) => (
    <div style={{ padding: '20px 20px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <div>
        <div style={{ width: '44px', height: '44px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', fontWeight: '800', marginBottom: '10px', ...avatarColor(contact.status) }}>
          {(contact.full_name || '?').charAt(0).toUpperCase()}
        </div>
        <h2 style={{ fontSize: '18px', fontWeight: '700', color: 'var(--text)', margin: 0 }}>{contact.full_name || '—'}</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-subtle)', margin: '2px 0 0' }}>{contact.organization || '—'}</p>
      </div>
      <button onClick={() => { setSelected(null); setEditing(false); setEditData(null) }}
        style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-subtle)' }}>x</button>
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
                <p style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 4px' }}>{label}</p>
                {isBadge
                  ? <span className="badge" style={statusStyle(value)}>{value || '—'}</span>
                  : <p style={{ fontSize: 'var(--t-md)', color: value ? 'var(--text)' : 'var(--text-subtle)', margin: 0 }}>{value || '—'}</p>}
              </div>
            )
          })}
          <div style={{ marginBottom: 'var(--s-5)' }}>
            <p className="label">Notes</p>
            <div style={{
              background: 'var(--surface-2)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-md)', padding: 'var(--s-4)',
              fontSize: 'var(--t-base)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
              color: contact.notes ? 'var(--text-muted)' : 'var(--text-subtle)',
            }}>
              {contact.notes || 'No notes for this contact.'}
            </div>
          </div>
          <button className="btn btn-primary" onClick={handleEdit} style={{ width: '100%' }}>
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
          {saveError && (
            <p role="alert" style={{
              marginTop: 'var(--s-3)', padding: 'var(--s-3)',
              fontSize: 'var(--t-sm)', lineHeight: 1.5,
              color: 'var(--danger)', background: 'var(--danger-soft)',
              borderRadius: 'var(--r-md)',
            }}>{saveError}</p>
          )}
          <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-2)' }}>
            <button className="btn btn-secondary" onClick={handleCancel} style={{ flex: 1 }}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ flex: 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      )}
    </div>
  )

  // ── Helper: open filter button ─────────────────────────────────────────────
  const openFilter = (e, key) => {
    e.stopPropagation()
    setOptionQuery('')
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
    <div className="app-header">
      <span style={{ fontSize: 'var(--t-lg)', fontWeight: 800, letterSpacing: '2px', color: 'var(--accent)' }}>RHYTHM</span>

      <div ref={sheetDropRef} style={{ position: 'relative' }}>
        <button
          className="btn btn-secondary btn-sm"
          aria-haspopup="menu" aria-expanded={sheetDropOpen}
          onClick={() => { setSheetDropOpen(p => !p); setSettingsOpen(false) }}
          style={sheetDropOpen ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'var(--accent-border)' } : undefined}>
          {activeSheet.sheet_name}
          <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        {sheetDropOpen && (
          <div className="menu" role="menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: '220px', zIndex: 200 }}>
            {sheets.map(s => (
              <button key={s.id} role="menuitem" className="menu-item"
                onClick={() => { onSwitchSheet(s); setSheetDropOpen(false) }}
                style={s.id === activeSheet.id ? { background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 700 } : undefined}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.sheet_name}</span>
                {s.id === activeSheet.id && <span className="badge badge-accent">Active</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="badge badge-accent">{contacts.length.toLocaleString()}</span>

      <button className="btn btn-ghost btn-sm" onClick={handleRefresh} title="Refresh from Google Sheet"
        style={{ color: cacheHit === 'live' ? 'var(--success)' : cacheHit === 'cache' ? 'var(--accent)' : 'var(--text-subtle)' }}>
        {cacheHit === 'cache' ? 'Cached' : cacheHit === 'live' ? 'Live · Refresh' : 'Refresh'}
      </button>

      <div style={{ flex: 1 }} />

      <div style={{
        width: '28px', height: '28px', flexShrink: 0,
        display: 'grid', placeItems: 'center',
        borderRadius: 'var(--r-full)',
        background: 'var(--accent)', color: 'var(--text-inverse)',
        fontSize: 'var(--t-sm)', fontWeight: 700,
      }}>
        {userName.charAt(0).toUpperCase()}
      </div>
      <span style={{ fontSize: 'var(--t-base)', color: 'var(--text-muted)', maxWidth: isMobile ? '70px' : '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {isMobile ? userName.split(' ')[0] : userName}
      </span>

      <div ref={settingsRef} style={{ position: 'relative' }}>
        <button className="btn btn-secondary btn-sm"
          aria-haspopup="menu" aria-expanded={settingsOpen}
          onClick={() => { setSettingsOpen(p => !p); setSheetDropOpen(false) }}
          style={settingsOpen ? { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'var(--accent-border)' } : undefined}>
          Settings
        </button>
        {settingsOpen && (
          <div className="menu" role="menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, minWidth: '200px', zIndex: 200 }}>
            {[
              // Opens the underlying sheet so the source of truth is always one
              // click away — everything the app shows is written straight back there.
              { label: 'View on Google Sheet', action: () => { setSettingsOpen(false); window.open(activeSheet.sheet_url, '_blank', 'noopener,noreferrer') } },
              { label: 'Add New Sheet', action: () => { setSettingsOpen(false); onAddSheet() } },
              { label: 'Re-map Columns', action: handleStartRemap },
              { label: deleting ? 'Deleting…' : 'Delete This Sheet', action: handleDeleteSheet, danger: true },
              { label: 'Sign Out', action: () => supabase.auth.signOut(), danger: true },
            ].map(({ label, action, danger }) => (
              <button key={label} role="menuitem" className="menu-item" data-danger={danger || undefined} onClick={action}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )

  // ── Table header cell with filter ──────────────────────────────────────────
  const thFilterBtn = (key, hasFilter) => (
    <button type="button" data-col-filter title="Filter" onClick={e => openFilter(e, key)}
      style={{ flexShrink: 0, padding: '2px 4px', margin: 0, border: 'none', background: hasFilter ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', borderRadius: '4px', display: 'flex', alignItems: 'center', color: 'var(--text-muted)' }}>
      <FilterChevron open={openFilterCol === key} active={hasFilter} />
    </button>
  )

  // ── Mobile search/filters bar ──────────────────────────────────────────────
  const searchAndFilters = (
    <div style={{ padding: '16px 16px 8px' }}>
      <input type="text" placeholder="Search name, organization, location…" value={search} onChange={e => setSearch(e.target.value)}
        style={{ width: '100%', padding: '11px 18px', fontSize: '14px', border: '1px solid var(--border-strong)', borderRadius: '10px', outline: 'none', background: 'var(--surface)', marginBottom: '10px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', boxSizing: 'border-box' }} />
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" onClick={() => setMobileFiltersOpen(true)}
          style={{ padding: '10px 14px', fontSize: '13px', fontWeight: '600', border: `1.5px solid ${hasActiveColumnFilters ? 'var(--accent)' : 'var(--border-strong)'}`, borderRadius: '10px', background: hasActiveColumnFilters ? 'var(--accent-soft)' : 'var(--surface)', color: hasActiveColumnFilters ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer' }}>
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </button>
        {(search || hasActiveColumnFilters || colSort) && (
          <button type="button" onClick={() => { setSearch(''); clearAllColumnFilters(); setColSort(null); setSelected(null) }}
            style={{ padding: '10px 12px', fontSize: '13px', fontWeight: '600', border: '1.5px solid var(--danger)', borderRadius: '10px', background: 'var(--danger-soft)', color: 'var(--danger)', cursor: 'pointer' }}>
            Clear all
          </button>
        )}
      </div>
      {(search || hasActiveColumnFilters || colSort) && (
        <p style={{ fontSize: '12px', color: 'var(--text-subtle)', margin: '8px 0 0' }}>{displayRows.length.toLocaleString()} shown</p>
      )}
    </div>
  )

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Row hover/selection and card hover now come from theme.css. The old
          rules here hardcoded light-mode hex with !important, which outranked
          the tokens and left dark mode with white-on-white rows. */}
      <style>{`
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes slideUp { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      `}</style>

      <div style={{ minHeight: '100vh', background: 'var(--bg)', width: '100%', overflowX: 'hidden' }}>
        {nav}

        {sheetError && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', justifyContent: 'space-between', flexWrap: 'wrap', padding: '12px 16px', background: 'var(--danger-soft)', borderBottom: '1px solid var(--danger)', color: 'var(--danger)', fontSize: '13px' }}>
            <span>{sheetError}</span>
            <button type="button" onClick={() => { clearCache(activeSheet.id); loadContacts(activeSheet) }}
              style={{ padding: '6px 14px', fontSize: '12px', fontWeight: '600', background: 'var(--surface)', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: '8px', cursor: 'pointer' }}>
              Retry
            </button>
          </div>
        )}

        {/* Filter portal for desktop */}
        {!isMobile && openFilterCol && filterMenuPos && createPortal(
          <div data-col-filter-portal style={filterPopoverStyle} onClick={e => e.stopPropagation()}>
            <p style={{ margin: '0 0 6px', padding: '0 14px', fontSize: '10px', fontWeight: '700', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.4px' }}>
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
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: '78vh', background: 'var(--surface)', borderRadius: '16px 16px 0 0', overflow: 'hidden', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
                  <div style={{ width: '40px', height: '4px', background: 'var(--border-strong)', borderRadius: '2px', margin: '10px auto 0' }} />
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px 10px', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: '16px', fontWeight: '700', color: 'var(--text)' }}>Filters</span>
                    <button type="button" onClick={() => setMobileFiltersOpen(false)} style={{ fontSize: '14px', fontWeight: '600', color: 'var(--accent)', border: 'none', background: 'none', cursor: 'pointer' }}>Done</button>
                  </div>
                  <div style={{ overflowY: 'auto', padding: '8px 0 24px', flex: 1 }}>
                    <div style={{ marginBottom: '16px', padding: '0 16px' }}>
                      <p style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 8px' }}>Notes</p>
                      <div style={{ border: '1px solid var(--border)', borderRadius: '10px', padding: '6px 0', background: 'var(--surface-2)' }}>{renderNotesFilterOptions()}</div>
                    </div>
                    {dynCols.map(col => (
                      <div key={col.key} style={{ marginBottom: '16px', padding: '0 16px' }}>
                        <p style={{ fontSize: '11px', fontWeight: '700', color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 8px' }}>{col.label}</p>
                        <div style={{ border: '1px solid var(--border)', borderRadius: '10px', padding: '6px 0', background: 'var(--surface-2)' }}>{renderFilterOptions(col)}</div>
                      </div>
                    ))}
                  </div>
                  {hasActiveColumnFilters && (
                    <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
                      <button type="button" onClick={clearAllColumnFilters}
                        style={{ width: '100%', padding: '12px', fontSize: '14px', fontWeight: '600', color: 'var(--danger)', background: 'var(--danger-soft)', border: '1px solid var(--danger)', borderRadius: '10px', cursor: 'pointer' }}>
                        Clear all filters
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div style={{ padding: '0 12px 100px' }}>
              {(mobileOn ? displayRows.slice(0, mobileCount) : displayRows).map((c, i) => (
                <div key={i} className="contact-card" onClick={() => { setSelected(i); setEditing(false); setEditData(null) }}
                  style={{ background: 'var(--surface)', borderRadius: '14px', border: '1px solid var(--border)', padding: '14px 16px', marginBottom: '10px', cursor: 'pointer', transition: 'border-color 0.15s' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
                    <div style={{ width: '40px', height: '40px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', fontWeight: '700', flexShrink: 0, ...avatarColor(c.status) }}>
                      {(c.full_name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontSize: '15px', fontWeight: '600', color: 'var(--text)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.first_name || c.full_name || '—'}</p>
                      <p style={{ fontSize: '13px', color: 'var(--text-subtle)', margin: '2px 0 0' }}>{c.organization || '—'}</p>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '11px', fontWeight: '700', padding: '3px 10px', borderRadius: '20px', ...statusStyle(c.status) }}>{c.status || '—'}</span>
                    <span style={{ fontSize: '11px', fontWeight: '700', padding: '3px 10px', borderRadius: '20px', ...statusStyle(c.response) }}>{c.response || '—'}</span>
                    <span style={{ fontSize: '12px', color: 'var(--text-subtle)', marginLeft: 'auto' }}>{c.mobile_no || ''}</span>
                    <span style={{ fontSize: '15px' }}>{c.notes ? <span style={{ color: 'var(--accent)' }}>●</span> : <span style={{ color: 'var(--border-strong)' }}>○</span>}</span>
                  </div>
                </div>
              ))}
            </div>

            {selected !== null && displayRows[selected] && (
              <div style={{ position: 'fixed', inset: 0, zIndex: 200 }}>
                <div onClick={() => { setSelected(null); setEditing(false); setEditData(null) }} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)' }} />
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'var(--surface)', borderRadius: '20px 20px 0 0', maxHeight: '85vh', overflowY: 'auto', animation: 'slideUp 0.25s ease' }}>
                  <div style={{ width: '40px', height: '4px', background: 'var(--border-strong)', borderRadius: '2px', margin: '12px auto 0' }} />
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
                  style={{ flex: 1, minWidth: '200px', padding: '11px 18px', fontSize: '14px', border: '1px solid var(--border-strong)', borderRadius: '10px', outline: 'none', background: 'var(--surface)', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }} />

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
                    style={{ padding: '10px 12px', fontSize: '13px', borderRadius: '10px', border: '1px solid var(--border-strong)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer' }}>
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
                    style={{ padding: '11px 14px', fontSize: '13px', fontWeight: '600', border: '1.5px solid var(--danger)', borderRadius: '10px', background: 'var(--danger-soft)', color: 'var(--danger)', cursor: 'pointer', flexShrink: 0 }}>
                    Clear all
                  </button>
                )}
              </div>

              {(search || hasActiveColumnFilters || colSort) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', flexWrap: 'wrap', marginBottom: '10px' }}>
                  <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                    {displayRows.length.toLocaleString()} shown
                    {search && ` · "${search}"`}
                    {hasActiveColumnFilters && ` · ${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'}`}
                    {colSort && ` · ${dynCols.find(c => c.key === colSort.key)?.label} ${colSort.dir === 'asc' ? (colSort.dataType === 'number' ? 'low → high' : 'oldest first') : (colSort.dataType === 'number' ? 'high → low' : 'newest first')}`}
                  </p>

                  {/* Only meaningful once two or more columns are filtered — with
                      one filtered column, all and any give identical results. */}
                  {Object.keys(columnFilters).length > 1 && (
                    <div role="group" aria-label="Combine filters" style={{ display: 'flex', gap: '2px', padding: '2px', background: 'var(--surface-sunk)', borderRadius: 'var(--r-full)' }}>
                      {[
                        { id: 'all', label: 'Match all', title: 'Rows must match every filtered column' },
                        { id: 'any', label: 'Match any', title: 'Rows matching any one filtered column' },
                      ].map(({ id, label, title }) => (
                        <button key={id} type="button" title={title}
                          aria-pressed={filterMode === id}
                          onClick={() => setFilterMode(id)}
                          style={{
                            padding: '3px 10px', fontSize: 'var(--t-sm)', fontWeight: 600,
                            border: 'none', borderRadius: 'var(--r-full)', cursor: 'pointer',
                            background: filterMode === id ? 'var(--surface)' : 'transparent',
                            color: filterMode === id ? 'var(--accent)' : 'var(--text-muted)',
                            boxShadow: filterMode === id ? 'var(--shadow-sm)' : 'none',
                          }}>
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div style={{ background: 'var(--surface)', borderRadius: '14px', boxShadow: '0 2px 12px rgba(79,70,229,0.08)', overflow: 'visible' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table" style={{ tableLayout: 'auto' }}>
                    <thead>
                      <tr>
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
                    <tbody ref={tbodyRef}>
                      {virtualOn && vStart > 0 && (
                        <tr aria-hidden style={{ height: vStart * vRowH }} />
                      )}
                      {(virtualOn ? displayRows.slice(vStart, vEnd) : displayRows).map((c, idx) => {
                        const i = virtualOn ? vStart + idx : idx
                        return (
                        <tr key={i} className="contact-row" data-selected={selected === i || undefined}
                          onClick={() => { setSelected(selected === i ? null : i); setEditing(false); setEditData(null) }}>
                          <td style={{ ...td, fontWeight: 600, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '180px' }}>{c.full_name || '—'}</td>
                          {dynCols.map(col => {
                            const val = getCellValue(c, col)
                            return (
                              <td key={col.key} style={{ ...td, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '140px' }}>
                                {BADGE_KEYS.has(col.key) && val
                                  ? <span className="badge" style={statusStyle(val)}>{val}</span>
                                  : <span style={{ color: val ? 'var(--text-muted)' : 'var(--text-subtle)' }}>{val || '—'}</span>}
                              </td>
                            )
                          })}
                          <td style={{ ...td, textAlign: 'center' }}>
                            {c.notes
                              ? <span title="Has notes" style={{ color: 'var(--accent)' }}>●</span>
                              : <span title="No notes" style={{ color: 'var(--border-strong)' }}>○</span>}
                          </td>
                        </tr>
                        )
                      })}
                      {virtualOn && vEnd < displayRows.length && (
                        <tr aria-hidden style={{ height: (displayRows.length - vEnd) * vRowH }} />
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {selected !== null && displayRows[selected] && (
              <>
                <div onMouseDown={startDrag}
                  style={{ width: '5px', cursor: 'col-resize', background: dragging ? 'var(--accent)' : 'transparent', transition: 'background 0.2s', flexShrink: 0, zIndex: 10 }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--accent-border)'}
                  onMouseLeave={e => { if (!dragging) e.currentTarget.style.background = 'transparent' }} />
                <div style={{ width: `${panelWidth}px`, minWidth: '260px', background: 'var(--surface)', borderLeft: '1px solid var(--border)', overflowY: 'auto', boxShadow: '-4px 0 20px rgba(79,70,229,0.08)', animation: 'slideIn 0.2s ease', flexShrink: 0 }}>
                  {panelHeader(displayRows[selected])}
                  {panelContent(displayRows[selected])}
                </div>
              </>
            )}
          </div>
        )}

        {saveMsg && (
          <div style={{ position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)', background: 'var(--success)', color: 'var(--text-inverse)', padding: '12px 24px', borderRadius: '10px', fontSize: '14px', fontWeight: '600', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 999, animation: 'slideUp 0.2s ease' }}>
            Saved to Google Sheet
          </div>
        )}
      </div>
    </>
  )
}

// Padding, type and colour now come from .data-table in theme.css. These keep
// only what the class deliberately doesn't set: th must not clip, so the
// filter popover can escape the cell.
const th = { overflow: 'visible' }
const td = {}