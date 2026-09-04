import { useState, useEffect, useCallback, useMemo } from 'react'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const REFRESH_INTERVAL_MS = 60_000 // 60 seconds — honest cadence, not fake "every second"
const PAGE_SIZE = 1000 // matches Supabase's default per-request max-rows setting

const RED = '#E8341A'
const MUTED = '#8A8F9C'
const GREEN = '#22C55E'
const AMBER = '#F59E0B'
const CARD = '#151822'
const BORDER = '#262A36'
const CANVAS = '#0B0E14'

// Fetches ONE page (used for bounded queries like "recent history" where
// we deliberately don't want the whole, ever-growing table).
async function fetchOnePage(path, rangeEnd = PAGE_SIZE - 1) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Range: `0-${rangeEnd}`,
      Prefer: 'count=exact',
    },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Supabase request failed (${res.status}): ${path}`)
  const rows = await res.json()
  // Content-Range looks like "0-999/2413" — the number after the slash is
  // the TRUE total row count in the table, even though we only fetched a page.
  const contentRange = res.headers.get('content-range')
  const total = contentRange ? parseInt(contentRange.split('/')[1], 10) || rows.length : rows.length
  return { rows, total }
}

// Fetches ALL rows for a table by paging through with the Range header —
// Supabase/PostgREST caps every single request at 1,000 rows by default,
// so a plain fetch silently truncates. This loops until a page comes back
// smaller than a full page, meaning we've reached the end.
async function fetchAllRows(path) {
  let allRows = []
  let offset = 0
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Range: `${offset}-${offset + PAGE_SIZE - 1}`,
      },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`Supabase request failed (${res.status}): ${path}`)
    const page = await res.json()
    allRows = allRows.concat(page)
    if (page.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return allRows
}

function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Turns raw history rows into real detected events (price drop/rise, restock, sellout)
// by comparing each SKU's consecutive snapshots — skips a SKU's very first-ever
// record, since that's just "first seen," not an actual change.
function computeChangeEvents(historyRows) {
  const byVariant = {}
  historyRows.forEach((r) => {
    if (!byVariant[r.variant_id]) byVariant[r.variant_id] = []
    byVariant[r.variant_id].push(r)
  })

  const events = []
  Object.values(byVariant).forEach((rows) => {
    const sorted = [...rows].sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at))
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]
      const curr = sorted[i]
      if (Number(prev.price) !== Number(curr.price)) {
        events.push({
          key: `${curr.variant_id}-${curr.changed_at}-price`,
          type: Number(curr.price) < Number(prev.price) ? 'price_drop' : 'price_rise',
          product: curr.product_title,
          variant: curr.variant_title,
          detail: `£${Number(prev.price).toFixed(2)} → £${Number(curr.price).toFixed(2)}`,
          changed_at: curr.changed_at,
        })
      }
      if (prev.available !== curr.available) {
        events.push({
          key: `${curr.variant_id}-${curr.changed_at}-avail`,
          type: curr.available ? 'restocked' : 'sold_out',
          product: curr.product_title,
          variant: curr.variant_title,
          detail: curr.available ? 'Back in stock' : 'Sold out',
          changed_at: curr.changed_at,
        })
      }
    }
  })

  return events.sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at))
}

const EVENT_STYLE = {
  price_drop: { label: '▼ Price drop', color: GREEN },
  price_rise: { label: '▲ Price increase', color: AMBER },
  restocked: { label: '● Restocked', color: GREEN },
  sold_out: { label: '● Sold out', color: RED },
}

// Real price swings: compares each SKU's EARLIEST vs LATEST recorded price
// in our tracked window — not fabricated, just first-vs-last from real data.
function computeBiggestMovers(historyRows) {
  const byVariant = {}
  historyRows.forEach((r) => {
    if (!byVariant[r.variant_id]) byVariant[r.variant_id] = []
    byVariant[r.variant_id].push(r)
  })
  const movers = []
  Object.values(byVariant).forEach((rows) => {
    if (rows.length < 2) return
    const sorted = [...rows].sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const firstPrice = Number(first.price)
    const lastPrice = Number(last.price)
    if (firstPrice === lastPrice) return
    movers.push({
      variant_id: last.variant_id,
      product: last.product_title,
      variant: last.variant_title,
      firstPrice,
      lastPrice,
      pctChange: ((lastPrice - firstPrice) / firstPrice) * 100,
    })
  })
  return movers.sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange)).slice(0, 6)
}

// Real current-state breakdown by category — straight from product_current,
// no history involved, so this is always fully accurate.
function computeCategoryHealth(currentRows) {
  const byCategory = {}
  currentRows.forEach((r) => {
    const cat = r.product_type || 'Uncategorized'
    if (!byCategory[cat]) byCategory[cat] = { total: 0, available: 0 }
    byCategory[cat].total += 1
    if (r.available) byCategory[cat].available += 1
  })
  return Object.entries(byCategory)
    .map(([category, { total, available }]) => ({
      category,
      total,
      available,
      pct: total ? Math.round((available / total) * 100) : 0,
    }))
    .sort((a, b) => b.total - a.total)
}

// Real count of detected events per day — shows the pipeline is genuinely
// live, not just a count we made up.
function computeDailyActivity(historyRows) {
  const byDay = {}
  historyRows.forEach((r) => {
    const day = r.changed_at.slice(0, 10)
    byDay[day] = (byDay[day] || 0) + 1
  })
  const sortedDays = Object.keys(byDay).sort()
  const last14 = sortedDays.slice(-14)
  return last14.map((day) => ({ day: day.slice(5), count: byDay[day] }))
}

export default function App() {
  const [current, setCurrent] = useState([])
  const [history, setHistory] = useState([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [category, setCategory] = useState('All')
  const [search, setSearch] = useState('')

  const loadData = useCallback(async () => {
    try {
      setError(null)
      const [currentRows, historyResult] = await Promise.all([
        fetchAllRows('product_current?store=eq.allbirds&select=*&order=variant_id'),
        fetchOnePage('product_history?store=eq.allbirds&select=*&order=changed_at.desc', 999),
      ])
      setCurrent(currentRows)
      setHistory(historyResult.rows)
      setHistoryTotal(historyResult.total)
      setLastUpdated(new Date())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const id = setInterval(loadData, REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [loadData])

  const categories = useMemo(
    () => ['All', ...Array.from(new Set(current.map((c) => c.product_type).filter(Boolean)))],
    [current]
  )

  const products = useMemo(() => {
    const byProduct = {}
    current.forEach((v) => {
      if (!byProduct[v.product_id]) {
        byProduct[v.product_id] = {
          id: v.product_id,
          title: v.product_title,
          vendor: v.vendor,
          type: v.product_type,
          prices: [],
          total: 0,
          available: 0,
        }
      }
      const p = byProduct[v.product_id]
      p.prices.push(Number(v.price))
      p.total += 1
      if (v.available) p.available += 1
    })
    return Object.values(byProduct)
      .map((p) => ({
        ...p,
        minPrice: Math.min(...p.prices),
        maxPrice: Math.max(...p.prices),
      }))
      .filter((p) => category === 'All' || p.type === category)
      .filter((p) => p.title.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [current, category, search])

  const kpis = useMemo(() => {
    const totalSkus = current.length
    const inStock = current.filter((c) => c.available).length
    const events = computeChangeEvents(history)
    const last24h = events.filter(
      (e) => Date.now() - new Date(e.changed_at).getTime() < 24 * 60 * 60 * 1000
    ).length
    return { totalSkus, inStock, outOfStock: totalSkus - inStock, last24h, events }
  }, [current, history])

  const movers = useMemo(() => computeBiggestMovers(history), [history])
  const categoryHealth = useMemo(() => computeCategoryHealth(current), [current])
  const dailyActivity = useMemo(() => computeDailyActivity(history), [history])
  const maxActivity = Math.max(1, ...dailyActivity.map((d) => d.count))

  if (loading) {
    return (
      <Shell>
        <div style={{ color: MUTED, textAlign: 'center', padding: '80px 20px' }}>
          Loading live inventory data…
        </div>
      </Shell>
    )
  }

  if (error) {
    return (
      <Shell>
        <div style={{ color: RED, textAlign: 'center', padding: '80px 20px', maxWidth: 500, margin: '0 auto' }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Couldn't load live data</div>
          <div style={{ fontSize: 13, color: MUTED }}>{error}</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 16 }}>
            Check that VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are set correctly,
            and that Row Level Security allows public read access on these tables.
          </div>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14, marginBottom: 24 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 4 }}>
            <div style={{ width: 22, height: 22, borderRadius: 6, background: RED }} />
            <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em', color: '#fff' }}>
              Allbirds — Live Inventory
            </span>
          </div>
          <div style={{ fontSize: 12.5, color: MUTED }}>
            Built by EMIMO · real Shopify data, auto-refreshing every 60 seconds
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <button
            onClick={loadData}
            style={{
              padding: '7px 14px', borderRadius: 100, fontSize: 12.5, fontWeight: 600,
              border: `1px solid ${BORDER}`, background: CARD, color: '#fff', cursor: 'pointer',
            }}
          >
            Refresh now
          </button>
          {lastUpdated && (
            <div style={{ fontSize: 11, color: MUTED, marginTop: 6, fontFamily: 'JetBrains Mono, monospace' }}>
              Updated {timeAgo(lastUpdated)}
            </div>
          )}
        </div>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
        {[
          { label: 'SKUs Tracked', val: kpis.totalSkus.toLocaleString() },
          { label: 'In Stock', val: kpis.inStock.toLocaleString() },
          { label: 'Out of Stock', val: kpis.outOfStock.toLocaleString(), warn: kpis.outOfStock > 0 },
          { label: 'Changes (24h)', val: kpis.last24h.toLocaleString() },
        ].map((k, i) => (
          <div key={i} style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 16 }}>
            <div style={{ fontSize: 11, color: MUTED, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 8 }}>
              {k.label}
            </div>
            <div style={{ fontSize: 24, fontWeight: 800, color: k.warn ? RED : '#fff' }}>{k.val}</div>
          </div>
        ))}
      </div>

      {/* Biggest movers + category health */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12, marginBottom: 16 }}>
        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 18 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff', marginBottom: 10 }}>
            Biggest Movers
          </div>
          {movers.length === 0 && (
            <div style={{ fontSize: 12.5, color: MUTED }}>
              No repeated price changes tracked yet for any SKU.
            </div>
          )}
          {movers.map((m) => (
            <div
              key={m.variant_id}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 0', borderBottom: `1px solid ${BORDER}`, fontSize: 12.5,
              }}
            >
              <div style={{ maxWidth: '60%' }}>
                <div style={{ color: '#fff', fontWeight: 600 }}>{m.product}</div>
                <div style={{ color: MUTED, fontSize: 11 }}>{m.variant}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: MUTED }}>
                  £{m.firstPrice.toFixed(2)} → £{m.lastPrice.toFixed(2)}
                </div>
                <div style={{ fontWeight: 700, color: m.pctChange < 0 ? GREEN : AMBER }}>
                  {m.pctChange > 0 ? '+' : ''}{m.pctChange.toFixed(1)}%
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 18 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff', marginBottom: 12 }}>
            Category Stock Health
          </div>
          {categoryHealth.map((c) => (
            <div key={c.category} style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                <span style={{ color: '#fff' }}>{c.category}</span>
                <span style={{ color: MUTED }}>{c.available}/{c.total} ({c.pct}%)</span>
              </div>
              <div style={{ background: BORDER, borderRadius: 100, height: 6, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${c.pct}%`, height: '100%',
                    background: c.pct >= 70 ? GREEN : c.pct >= 30 ? AMBER : RED,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recently changed feed */}
      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: 18, marginBottom: 16 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff', marginBottom: 10 }}>
          Recently Changed
        </div>
        {kpis.events.length === 0 && (
          <div style={{ fontSize: 12.5, color: MUTED }}>
            No changes detected yet — check back after a few more refresh cycles. This feed only
            shows real price/stock changes, not first-time sightings.
          </div>
        )}
        {kpis.events.slice(0, 12).map((e) => {
          const style = EVENT_STYLE[e.type]
          return (
            <div
              key={e.key}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '9px 0', borderBottom: `1px solid ${BORDER}`, fontSize: 12.5,
              }}
            >
              <div>
                <span style={{ color: style.color, fontWeight: 700, marginRight: 8 }}>{style.label}</span>
                <span style={{ color: '#fff' }}>{e.product}</span>
                <span style={{ color: MUTED }}> — {e.variant}</span>
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span style={{ color: MUTED, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{e.detail}</span>
                <span style={{ color: MUTED, fontSize: 11 }}>{timeAgo(e.changed_at)}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Change activity over time */}
      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: '18px 18px 14px', marginBottom: 16 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: '#fff', marginBottom: 14 }}>
          Change Activity — Last {dailyActivity.length} Days
        </div>
        {dailyActivity.length === 0 ? (
          <div style={{ fontSize: 12.5, color: MUTED }}>Not enough history yet to chart activity.</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 90 }}>
            {dailyActivity.map((d) => (
              <div key={d.day} style={{ flex: 1, textAlign: 'center' }}>
                <div
                  title={`${d.count} changes on ${d.day}`}
                  style={{
                    height: `${Math.max(6, (d.count / maxActivity) * 70)}px`,
                    background: RED, opacity: 0.85, borderRadius: '3px 3px 0 0',
                  }}
                />
                <div style={{ fontSize: 9.5, color: MUTED, marginTop: 4, fontFamily: 'JetBrains Mono, monospace' }}>
                  {d.day}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <input
          placeholder="Search products…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: '1 1 200px', padding: '9px 14px', borderRadius: 10, border: `1px solid ${BORDER}`,
            background: CARD, color: '#fff', fontSize: 13, outline: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              style={{
                padding: '8px 13px', borderRadius: 100, fontSize: 12, fontWeight: 600,
                border: `1px solid ${category === c ? RED : BORDER}`,
                background: category === c ? '#2A1512' : CARD,
                color: category === c ? RED : MUTED, cursor: 'pointer',
              }}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Product table */}
      <div style={{ background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', padding: '12px 18px', fontSize: 11, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.03em', borderBottom: `1px solid ${BORDER}` }}>
          <div>Product</div>
          <div>Type</div>
          <div>Price Range</div>
          <div>Availability</div>
        </div>
        {products.length === 0 && (
          <div style={{ padding: 20, fontSize: 13, color: MUTED, textAlign: 'center' }}>
            No products match this filter.
          </div>
        )}
        {products.slice(0, 50).map((p) => (
          <div
            key={p.id}
            style={{
              display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', padding: '12px 18px',
              fontSize: 13, borderBottom: `1px solid ${BORDER}`, alignItems: 'center',
            }}
          >
            <div style={{ color: '#fff', fontWeight: 600 }}>{p.title}</div>
            <div style={{ color: MUTED }}>{p.type || '—'}</div>
            <div style={{ color: '#fff', fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>
              {p.minPrice === p.maxPrice ? `£${p.minPrice}` : `£${p.minPrice}–${p.maxPrice}`}
            </div>
            <div>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 100,
                background: p.available === p.total ? '#122A1A' : p.available === 0 ? '#2A1512' : '#2A2412',
                color: p.available === p.total ? GREEN : p.available === 0 ? RED : AMBER,
              }}>
                {p.available}/{p.total} in stock
              </span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 11, color: MUTED, textAlign: 'center', marginTop: 20 }}>
        Live data from Allbirds' public product feed, tracked by an automated pipeline running
        every 15 minutes. This dashboard refreshes itself — no manual reload needed.
      </div>
      <div style={{ fontSize: 10.5, color: MUTED, textAlign: 'center', marginTop: 6, fontFamily: 'JetBrains Mono, monospace' }}>
        product_current: {current.length.toLocaleString()} rows (full table) · product_history:{' '}
        {historyTotal.toLocaleString()} total events logged, showing most recent {history.length.toLocaleString()}
      </div>
    </Shell>
  )
}

function Shell({ children }) {
  return (
    <div style={{ background: CANVAS, minHeight: '100vh', padding: '28px 16px 60px' }}>
      <div style={{ maxWidth: 980, margin: '0 auto' }}>{children}</div>
    </div>
  )
}
