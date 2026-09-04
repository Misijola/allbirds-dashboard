# Allbirds Live Inventory Dashboard

A real, live-updating dashboard reading directly from your Supabase
database (the same one your `track_allbirds.py` pipeline feeds every
15 minutes via GitHub Actions). This is a real deployable web app —
not a chat artifact — meant to be run and hosted independently so you
can send a real URL to a client.

## What it shows
- Live KPIs: SKUs tracked, in stock / out of stock, changes in the last 24h
- A "Recently Changed" feed — real detected price drops, price rises,
  restocks, and sellouts (computed from your `product_history` table,
  not hardcoded)
- A searchable, filterable product table with live price ranges and
  stock ratios
- Auto-refreshes every 60 seconds, plus a manual "Refresh now" button

## Run it locally first

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env.local` — the values already match your
   Supabase project, so you likely don't need to change anything.
3. Start the dev server:
   ```
   npm run dev
   ```
4. Open the URL it prints (usually `http://localhost:5173`) — you
   should see real Allbirds data.

If you see a red error screen instead, it's almost always one of:
- Row Level Security isn't enabled with a public-read policy yet
  (run `enable_rls.sql` in Supabase's SQL Editor if you haven't)
- The `.env.local` values don't match your actual Supabase project

## Deploy it for real (so you have a shareable link)

1. Push this project to a **new GitHub repo** (e.g. `allbirds-dashboard`):
   ```
   git init
   git add .
   git commit -m "Live Allbirds dashboard"
   git remote add origin https://github.com/Misijola/allbirds-dashboard.git
   git branch -M main
   git push -u origin main
   ```
2. Go to **vercel.com** → sign up/log in with your GitHub account
3. Click **Add New → Project** → select your `allbirds-dashboard` repo
4. Before deploying, open **Environment Variables** and add the same
   two values from your `.env.local`:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
5. Click **Deploy**

Vercel will give you a real public URL like
`allbirds-dashboard.vercel.app` — that's the link you send to a client.
Every time you `git push` after this, Vercel automatically redeploys.

## Notes
- The Supabase publishable key is meant to be public/client-visible —
  that's what it's for. Row Level Security (not key secrecy) is what
  actually protects your data from being written/deleted by outsiders.
- Refresh interval is 60 seconds — honest and sufficient for real
  inventory data. Change `REFRESH_INTERVAL_MS` in `src/App.jsx` if you
  want a different cadence later.
