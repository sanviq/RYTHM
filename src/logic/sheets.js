export function extractSheetId(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return match ? match[1] : null
}

export async function fetchHeaders(sheetUrl, tabName, accessToken) {
  const sheetId = extractSheetId(sheetUrl)
  const range = `${tabName}!1:1`
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const data = await response.json()
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
  const range = `${tabName}!A:ZZ`
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const data = await response.json()
  if (!data.values) return []

  const rows = data.values.slice(1)
  const m = columnMapping
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
  const row = contact.rowIndex
  const m = columnMapping

  // Collect all indices used
  const fixedIndices = ['first_name','middle_name','last_name','organization','status','response','notes','mobile_no','location']
    .map(k => m[k]).filter(v => v !== null && v !== undefined)
  const extraIndices = (m.extra || []).map(e => e.colIndex).filter(v => v !== null && v !== undefined)
  const allIndices = [...fixedIndices, ...extraIndices]
  if (allIndices.length === 0) return false

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

  const range = `${tabName}!A${row}:${colLetter(maxCol)}${row}`
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values: [values] })
    }
  )
  return response.ok
}