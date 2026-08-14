export function extractSheetId(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return match ? match[1] : null
}

/** A1 range for a tab; quotes tab name when required (spaces, punctuation, leading digit, etc.). */
export function formatTabRange(tabName, rangePart) {
  if (!tabName || rangePart === undefined || rangePart === null) return ''
  const name = String(tabName)
  const needsQuote =
    /^[0-9]/.test(name) || /[^A-Za-z0-9_]/.test(name)
  const escaped = name.replace(/'/g, "''")
  return needsQuote ? `'${escaped}'!${rangePart}` : `${name}!${rangePart}`
}

function valuesUrl(sheetId, tabName, rangePart) {
  const range = encodeURIComponent(formatTabRange(tabName, rangePart))
  return `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`
}

export async function fetchHeaders(sheetUrl, tabName, accessToken) {
  const sheetId = extractSheetId(sheetUrl)
  if (!sheetId) return []
  const response = await fetch(valuesUrl(sheetId, tabName, '1:1'), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = await response.json()
  if (!response.ok) {
    console.warn('Sheets API (headers):', data.error?.message || response.status)
    return []
  }
  if (!data.values || !data.values[0]) return []
  return data.values[0]
}

export function guessMapping(headers) {
  const synonyms = {
    first_name:   ['first', 'first name', 'firstname', 'fname', 'given name', 'given', 'name'],
    middle_name:  ['middle', 'middle name', 'middlename', 'mname'],
    last_name:    ['last', 'last name', 'lastname', 'lname', 'surname', 'family name'],
    organization: ['org', 'organization', 'organisation', 'company', 'company name', 'business'],
    status:       ['status', 'stage', 'state'],
    response:     ['response', 'reply', 'interest', 'lead type', 'temp', 'temperature'],
    notes:        ['notes', 'note', 'comments', 'comment', 'remarks', 'remark'],
    mobile_no:    ['mobile', 'phone', 'mobile no', 'mobile number', 'phone number', 'contact', 'cell'],
    location:     ['location', 'city', 'place', 'area', 'region', 'address'],
  }

  const mapping = {}
  Object.keys(synonyms).forEach(field => { mapping[field] = null })

  headers.forEach((header, index) => {
    const h = (header || '').toLowerCase().trim()
    Object.keys(synonyms).forEach(field => {
      if (mapping[field] === null && synonyms[field].includes(h)) {
        mapping[field] = index
      }
    })
  })

  // Auto-suggest remaining unmapped headers as extra fields
  const usedIndices = new Set(Object.values(mapping).filter(v => v !== null))
  mapping.extra = headers
    .map((h, i) => ({ label: h, colIndex: i }))
    .filter(({ colIndex }) => !usedIndices.has(colIndex) && headers[colIndex])

  return mapping
}

export async function fetchContacts(sheetUrl, tabName, accessToken, columnMapping) {
  const sheetId = extractSheetId(sheetUrl)
  if (!sheetId) {
    throw new Error('Invalid Google Sheet URL — paste the full docs.google.com link.')
  }
  const response = await fetch(valuesUrl(sheetId, tabName, 'A:ZZ'), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = await response.json()
  if (!response.ok) {
    const msg = data.error?.message || `Sheets API error (${response.status})`
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `${msg} — Try signing out and signing in with Google again so Rythm can access your sheet.`
      )
    }
    throw new Error(msg)
  }
  if (!data.values) return []

  const rows = data.values.slice(1)
  const m = columnMapping || {}
  const get = (row, idx) => (idx !== null && idx !== undefined ? row[idx] || '' : '')

  return rows.map((row, index) => {
    const first  = get(row, m.first_name)
    const middle = get(row, m.middle_name)
    const last   = get(row, m.last_name)

    // Build extra fields object
    const extraData = {}
    if (m.extra && Array.isArray(m.extra)) {
      m.extra.forEach(({ label, colIndex }) => {
        if (label && colIndex !== null && colIndex !== undefined) {
          extraData[label] = row[colIndex] || ''
        }
      })
    }

    return {
      rowIndex: index + 2,
      full_name: [first, middle, last].filter(Boolean).join(' '),
      first_name:   first,
      middle_name:  middle,
      last_name:    last,
      organization: get(row, m.organization),
      status:       get(row, m.status),
      response:     get(row, m.response),
      notes:        get(row, m.notes),
      mobile_no:    get(row, m.mobile_no),
      location:     get(row, m.location),
      extra:        extraData,
    }
  })
}

export async function updateContact(sheetUrl, tabName, accessToken, contact, columnMapping) {
  const sheetId = extractSheetId(sheetUrl)
  if (!sheetId) throw new Error('Could not read the sheet ID from the saved URL.')
  const row = contact.rowIndex
  const m = columnMapping || {}

  // Collect all indices used
  const fixedIndices = ['first_name','middle_name','last_name','organization','status','response','notes','mobile_no','location']
    .map(k => m[k]).filter(v => v !== null && v !== undefined)
  const extraIndices = (m.extra || []).map(e => e.colIndex).filter(v => v !== null && v !== undefined)
  const allIndices = [...fixedIndices, ...extraIndices]
  if (allIndices.length === 0) throw new Error('No columns are mapped for this sheet, so there is nothing to write.')

  const maxCol = Math.max(...allIndices)
  const values = Array(maxCol + 1).fill('')

  const set = (idx, val) => { if (idx !== null && idx !== undefined) values[idx] = val }
  set(m.first_name,   contact.first_name)
  set(m.middle_name,  contact.middle_name)
  set(m.last_name,    contact.last_name)
  set(m.organization, contact.organization)
  set(m.status,       contact.status)
  set(m.response,     contact.response)
  set(m.notes,        contact.notes)
  set(m.mobile_no,    contact.mobile_no)
  set(m.location,     contact.location)

  // Set extra fields
  if (m.extra && Array.isArray(m.extra) && contact.extra) {
    m.extra.forEach(({ label, colIndex }) => {
      if (colIndex !== null && colIndex !== undefined && contact.extra[label] !== undefined) {
        values[colIndex] = contact.extra[label]
      }
    })
  }

  const colLetter = (n) => {
    let s = ''; n++
    while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) }
    return s
  }

  const rangeA1 = formatTabRange(tabName, `A${row}:${colLetter(maxCol)}${row}`)
  const response = await fetch(
    // The path segment must be percent-encoded; the body must carry the plain
    // A1 range. Sending the encoded form in the body makes Sheets reject every
    // write, because the ':' arrives as '%3A' and the range no longer parses.
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(rangeA1)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: rangeA1, majorDimension: 'ROWS', values: [values] })
    }
  )

  if (!response.ok) {
    // Surface what Sheets actually said; the caller previously got a bare false
    // and could only show "something went wrong".
    let detail = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (body?.error?.message) detail = body.error.message
    } catch {
      // Non-JSON error body (proxy/HTML error page); the status code stands in.
    }
    throw new Error(detail)
  }
  return true
}