import { useState, useEffect } from 'react'

const FIXED_FIELDS = [
  { key: 'first_name',   label: 'First Name' },
  { key: 'middle_name',  label: 'Middle Name' },
  { key: 'last_name',    label: 'Last Name' },
  { key: 'organization', label: 'Organization' },
  { key: 'status',       label: 'Status' },
  { key: 'response',     label: 'Response' },
  { key: 'notes',        label: 'Notes' },
  { key: 'mobile_no',    label: 'Mobile No' },
  { key: 'location',     label: 'Location / City' },
]

export default function ColumnMapper({ headers, initialMapping, onConfirm, onBack, saving }) {
  const [fixedMapping, setFixedMapping] = useState({})
  /** per fixed field key: 'text' | 'date' (date → sortable in the table) */
  const [fieldTypes, setFieldTypes] = useState({})
  // extra: { label, colIndex, dataType?: 'text'|'date' }
  const [extraFields, setExtraFields] = useState([])

  useEffect(() => {
    // Populate fixed fields from initialMapping
    const fixed = {}
    FIXED_FIELDS.forEach(f => {
      fixed[f.key] = initialMapping[f.key] !== undefined ? initialMapping[f.key] : null
    })
    setFixedMapping(fixed)

    const ft = {}
    FIXED_FIELDS.forEach(field => {
      ft[field.key] = initialMapping.fieldTypes?.[field.key] === 'date' ? 'date' : 'text'
    })
    setFieldTypes(ft)

    // Find already-mapped column indices for fixed fields
    const usedIndices = new Set(Object.values(fixed).filter(v => v !== null))

    // Pre-populate extra fields from initialMapping.extra if present
    if (initialMapping.extra && Array.isArray(initialMapping.extra)) {
      setExtraFields(
        initialMapping.extra.map(e => ({
          ...e,
          dataType: e.dataType === 'date' ? 'date' : 'text',
        }))
      )
    } else {
      // Auto-suggest unmapped columns as extra fields
      const suggestions = headers
        .map((h, i) => ({ label: h, colIndex: i }))
        .filter(({ colIndex }) => !usedIndices.has(colIndex))
      setExtraFields(suggestions.map(s => ({ label: s.label, colIndex: s.colIndex, dataType: 'text' })))
    }
  }, [])

  const setFixed = (key, value) => {
    setFixedMapping(prev => ({ ...prev, [key]: value === '' ? null : Number(value) }))
  }

  const setExtra = (index, field, value) => {
    setExtraFields(prev => prev.map((e, i) => i === index ? { ...e, [field]: field === 'colIndex' ? (value === '' ? null : Number(value)) : value } : e))
  }

  const setFieldType = (key, value) => {
    setFieldTypes(prev => ({ ...prev, [key]: value }))
  }

  const addExtra = () => {
    setExtraFields(prev => [...prev, { label: '', colIndex: null, dataType: 'text' }])
  }

  const removeExtra = (index) => {
    setExtraFields(prev => prev.filter((_, i) => i !== index))
  }

  const handleConfirm = () => {
    const fieldTypesOut = {}
    FIXED_FIELDS.forEach(f => {
      fieldTypesOut[f.key] = fieldTypes[f.key] === 'date' ? 'date' : 'text'
    })
    const finalMapping = {
      ...fixedMapping,
      fieldTypes: fieldTypesOut,
      extra: extraFields
        .filter(e => e.colIndex !== null && e.label.trim() !== '')
        .map(e => ({
          label: e.label.trim(),
          colIndex: e.colIndex,
          dataType: e.dataType === 'date' ? 'date' : 'text',
        })),
    }
    onConfirm(finalMapping)
  }

  const selectStyle = (mapped) => ({
    flex: 1, padding: '8px 12px', fontSize: '13px',
    border: `1.5px solid ${mapped ? '#4f46e5' : '#ddd'}`,
    borderRadius: '8px', outline: 'none',
    background: mapped ? '#f5f3ff' : '#fff',
    color: '#333', cursor: 'pointer'
  })

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #ece9f7 0%, #e8f0fe 100%)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      padding: '40px 16px'
    }}>
      <div style={{
        background: '#fff', borderRadius: '16px',
        boxShadow: '0 4px 24px rgba(79,70,229,0.10)',
        padding: '36px 40px', width: '100%', maxWidth: '560px'
      }}>
        <span style={{ fontSize: '20px', fontWeight: '900', letterSpacing: '3px', color: '#4f46e5' }}>RYTHM</span>
        <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111', margin: '20px 0 4px' }}>Map your columns</h2>
        <p style={{ fontSize: '13px', color: '#888', margin: '0 0 24px' }}>
          We detected {headers.length} columns. Match them to Rythm fields. Columns marked "Not mapped" will be left blank.
        </p>

        {/* Fixed fields */}
        <p style={{ fontSize: '11px', fontWeight: '700', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '0 0 12px' }}>Standard Fields</p>
        {FIXED_FIELDS.map(({ key, label }) => (
          <div key={key} style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ width: '130px', flexShrink: 0 }}>
              <p style={{ fontSize: '12px', fontWeight: '700', color: '#555', margin: 0, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</p>
            </div>
            <select
              value={fixedMapping[key] !== null && fixedMapping[key] !== undefined ? fixedMapping[key] : ''}
              onChange={e => setFixed(key, e.target.value)}
              style={{ ...selectStyle(fixedMapping[key] !== null && fixedMapping[key] !== undefined), flex: '1 1 160px', minWidth: '120px' }}
            >
              <option value=''>Not mapped</option>
              {headers.map((h, i) => (
                <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
              ))}
            </select>
            <select
              value={fieldTypes[key] === 'date' ? 'date' : 'text'}
              onChange={e => setFieldType(key, e.target.value)}
              title="Date columns can be sorted in the table"
              style={{ width: '100px', flexShrink: 0, padding: '8px 10px', fontSize: '12px', border: '1.5px solid #ddd', borderRadius: '8px', outline: 'none', background: '#fff', color: '#333', cursor: 'pointer' }}
            >
              <option value="text">Text</option>
              <option value="date">Date</option>
            </select>
          </div>
        ))}

        {/* Extra / custom fields */}
        <div style={{ marginTop: '28px', paddingTop: '20px', borderTop: '1px solid #f0f0f0' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <p style={{ fontSize: '11px', fontWeight: '700', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.5px', margin: 0 }}>Additional Columns</p>
            <button
              onClick={addExtra}
              style={{ fontSize: '12px', fontWeight: '600', color: '#4f46e5', background: '#ede9fe', border: 'none', borderRadius: '6px', padding: '4px 10px', cursor: 'pointer' }}
            >
              + Add column
            </button>
          </div>

          {extraFields.length === 0 && (
            <p style={{ fontSize: '13px', color: '#bbb', margin: '0 0 8px' }}>No additional columns. Click "+ Add column" to map more fields from your sheet.</p>
          )}

          {extraFields.map((extra, i) => (
            <div key={i} style={{ marginBottom: '10px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="Column label"
                value={extra.label}
                onChange={e => setExtra(i, 'label', e.target.value)}
                style={{ width: '130px', flexShrink: 0, padding: '8px 10px', fontSize: '13px', border: '1.5px solid #ddd', borderRadius: '8px', outline: 'none', color: '#333' }}
              />
              <select
                value={extra.colIndex !== null && extra.colIndex !== undefined ? extra.colIndex : ''}
                onChange={e => setExtra(i, 'colIndex', e.target.value)}
                style={{ ...selectStyle(extra.colIndex !== null && extra.colIndex !== undefined), flex: '1 1 140px', minWidth: '120px' }}
              >
                <option value=''>Not mapped</option>
                {headers.map((h, idx) => (
                  <option key={idx} value={idx}>{h || `Column ${idx + 1}`}</option>
                ))}
              </select>
              <select
                value={extra.dataType === 'date' ? 'date' : 'text'}
                onChange={e => setExtra(i, 'dataType', e.target.value)}
                title="Date columns can be sorted in the table"
                style={{ width: '100px', flexShrink: 0, padding: '8px 10px', fontSize: '12px', border: '1.5px solid #ddd', borderRadius: '8px', outline: 'none', background: '#fff', color: '#333', cursor: 'pointer' }}
              >
                <option value="text">Text</option>
                <option value="date">Date</option>
              </select>
              <button
                onClick={() => removeExtra(i)}
                style={{ background: 'none', border: 'none', color: '#ccc', fontSize: '18px', cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}
              >
                x
              </button>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '10px', marginTop: '28px' }}>
          {onBack && (
            <button onClick={onBack} style={{ flex: 1, padding: '11px', fontSize: '14px', fontWeight: '600', background: '#f5f5f5', color: '#555', border: '1px solid #ddd', borderRadius: '10px', cursor: 'pointer' }}>
              Back
            </button>
          )}
          <button onClick={handleConfirm} disabled={saving} style={{ flex: 2, padding: '11px', fontSize: '14px', fontWeight: '600', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: '10px', cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving...' : 'Confirm Mapping'}
          </button>
        </div>
      </div>
    </div>
  )
}