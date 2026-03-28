export function extractSheetId(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  return match ? match[1] : null
}

export async function fetchContacts(sheetUrl, accessToken) {
  const sheetId = extractSheetId(sheetUrl)
  const range = 'contacts!A:I'

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )

  const data = await response.json()
  if (!data.values) return []

  const rows = data.values.slice(1)

  return rows.map((row, index) => ({
    rowIndex: index + 2, // +2 because row 1 is header, sheets are 1-indexed
    full_name: [row[0], row[1], row[2]].filter(Boolean).join(' '),
    first_name: row[0] || '',
    middle_name: row[1] || '',
    last_name: row[2] || '',
    organization: row[3] || '',
    status: row[4] || '',
    response: row[5] || '',
    notes: row[6] || '',
    mobile_no: row[7] || '',
    location: row[8] || '',
  }))
}

export async function updateContact(sheetUrl, accessToken, contact) {
  const sheetId = extractSheetId(sheetUrl)
  const row = contact.rowIndex
  const range = `contacts!A${row}:I${row}`

  const values = [[
    contact.first_name,
    contact.middle_name,
    contact.last_name,
    contact.organization,
    contact.status,
    contact.response,
    contact.notes,
    contact.mobile_no,
    contact.location,
  ]]

  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ range, majorDimension: 'ROWS', values })
    }
  )

  return response.ok
}