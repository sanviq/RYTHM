export function extractSheetId(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return match ? match[1] : null
}

// Fetch just the header row from the sheet
export async function fetchHeaders(sheetUrl, tabName, accessToken) {
  const sheetId = extractSheetId(sheetUrl)
  const range = `${tabName}!1:1`

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )

  const data = await response.json()
  if (!data.values || !data.values[0]) return []
  return data.values[0] // array of header strings
}

// Auto-guess column mapping from header names
export function guessMapping(headers) {
  const fields = ['first_name', 'middle_name', 'last_name', 'organization', 'status', 'response', 'notes', 'mobile_no', 'location']

  const synonyms = {
    first_name:   ['first', 'first name', 'firstname', 'fname', 'given name', 'given'],
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
  fields.forEach(field => { mapping[field] = null })

  headers.forEach((header, index) => {
    const h = header.toLowerCase().trim()
    fields.forEach(field => {
      if (mapping[field] === null && synonyms[field].includes(h)) {
        mapping[field] = index
      }
    })
  })

  return mapping
}

// Fetch contacts using saved column mapping
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
    }
  })
}

// Update a contact row using saved column mapping
export async function updateContact(sheetUrl, tabName, accessToken, contact, columnMapping) {
  const sheetId = extractSheetId(sheetUrl)
  const row = contact.rowIndex
  const m = columnMapping

  // Find the max column index used
  const indices = Object.values(m).filter(v => v !== null && v !== undefined)
  if (indices.length === 0) return false
  const maxCol = Math.max(...indices)

  // Build a sparse array covering all columns
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

  // Convert column index to letter(s)
  const colLetter = (n) => {
    let s = ''
    n++
    while (n > 0) {
      n--
      s = String.fromCharCode(65 + (n % 26)) + s
      n = Math.floor(n / 26)
    }
    return s
  }

  const startCol = colLetter(0)
  const endCol   = colLetter(maxCol)
  const range    = `${tabName}!${startCol}${row}:${endCol}${row}`

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values: [values] })
    }
  )

  return response.ok
}