export default function ColumnMapper({ headers, mapping, onChange, onConfirm, onBack, saving }) {
  const fields = [
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
        padding: '36px 40px', width: '100%', maxWidth: '520px'
      }}>
        <span style={{ fontSize: '20px', fontWeight: '900', letterSpacing: '3px', color: '#4f46e5' }}>RYTHM</span>

        <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#111', margin: '20px 0 4px' }}>Map your columns</h2>
        <p style={{ fontSize: '13px', color: '#888', margin: '0 0 28px' }}>
          We detected {headers.length} columns in your sheet. Match them to Rythm fields below. Columns marked "Not mapped" will be left blank.
        </p>

        {fields.map(({ key, label }) => (
          <div key={key} style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ width: '140px', flexShrink: 0 }}>
              <p style={{ fontSize: '12px', fontWeight: '700', color: '#555', margin: 0, textTransform: 'uppercase', letterSpacing: '0.4px' }}>{label}</p>
            </div>
            <select
              value={mapping[key] !== null && mapping[key] !== undefined ? mapping[key] : ''}
              onChange={e => onChange(key, e.target.value === '' ? null : Number(e.target.value))}
              style={{
                flex: 1, padding: '8px 12px', fontSize: '13px',
                border: `1.5px solid ${mapping[key] !== null && mapping[key] !== undefined ? '#4f46e5' : '#ddd'}`,
                borderRadius: '8px', outline: 'none',
                background: mapping[key] !== null && mapping[key] !== undefined ? '#f5f3ff' : '#fff',
                color: '#333', cursor: 'pointer'
              }}
            >
              <option value=''>Not mapped</option>
              {headers.map((h, i) => (
                <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
              ))}
            </select>
          </div>
        ))}

        <div style={{ display: 'flex', gap: '10px', marginTop: '28px' }}>
          {onBack && (
            <button
              onClick={onBack}
              style={{
                flex: 1, padding: '11px', fontSize: '14px', fontWeight: '600',
                background: '#f5f5f5', color: '#555',
                border: '1px solid #ddd', borderRadius: '10px', cursor: 'pointer'
              }}
            >
              Back
            </button>
          )}
          <button
            onClick={onConfirm}
            disabled={saving}
            style={{
              flex: 2, padding: '11px', fontSize: '14px', fontWeight: '600',
              background: '#4f46e5', color: '#fff',
              border: 'none', borderRadius: '10px',
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1
            }}
          >
            {saving ? 'Saving...' : 'Confirm Mapping'}
          </button>
        </div>
      </div>
    </div>
  )
}