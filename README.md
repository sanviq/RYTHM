# Rythm

**Live: [rythm-ca0.pages.dev](https://rythm-ca0.pages.dev)**

A fast, minimal CRM built on top of Google Sheets. No data migration, no complex setup — just connect your existing sheet and start managing contacts.

## What it does

Rythm turns any Google Sheet into a searchable, filterable contact management interface. You bring your own data. Rythm makes it easier to read, search, and update.

- Connect one or multiple Google Sheets
- Auto-detects your column headers and maps them to contact fields
- Search across name, organization, and location instantly
- Filter by status and response
- View and edit contact details in a slide-in panel
- Changes save directly back to your Google Sheet
- Works on desktop and mobile

## Tech Stack

- **Frontend:** React + Vite
- **Auth:** Supabase (Google OAuth)
- **Database:** Google Sheets (via Sheets API)
- **Config storage:** Supabase
- **Hosting:** Cloudflare Pages

## Getting Started

### Prerequisites

- Node.js 18+
- A Google account
- A Google Sheet with contact data

### Installation

```bash
git clone https://github.com/sanviq/RYTHM.git
cd RYTHM
npm install
```

### Environment Setup

Create a `.env` file in the root:

```
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Run locally

```bash
npm run dev
```

### Build

```bash
npm run build
```

## How It Works

1. Sign in with your Google account
2. Paste your Google Sheet URL and tab name
3. Rythm reads your column headers and auto-guesses the mapping
4. Correct any mismatched fields
5. Your contacts load instantly

Multiple sheets are supported. Switch between them from the nav dropdown. Each sheet has its own column mapping.

## Features

- **Dynamic column mapping** — works with any sheet structure, not just a fixed template
- **Extra columns** — columns beyond the standard fields appear in the contact panel and are fully editable
- **Local caching** — contacts are cached in the browser (IndexedDB) for 24 hours, so the app loads instantly on return visits. The cache is per-browser, so it does not follow you between devices. Hit Refresh to sync from the sheet
- **Auto token refresh** — Google access tokens refresh silently in the background
- **Responsive** — full table view on desktop, card layout on mobile

## Roadmap

- [ ] Publish OAuth app (currently in testing mode)
- [ ] Team access — share sheets across a team, senior/manager view
- [ ] Graphs and analytics per sheet
- [ ] Daily planner and tracker sheets
- [ ] Custom domain support

## License

Private. All rights reserved.
