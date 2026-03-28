import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://oqcbxcfdytpqmbywsoap.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9xY2J4Y2ZkeXRwcW1ieXdzb2FwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2MjMxMzUsImV4cCI6MjA5MDE5OTEzNX0.X0VWRHMbP0BXabYs_PNHMDuacXdwLruTat2jAtdU6RA'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)