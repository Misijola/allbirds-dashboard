import { useState, useEffect, useCallback, useMemo, useRef } from 'react'

const BASE = import.meta.env.VITE_SUPABASE_URL
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
const REFRESH_MS = 60_000
const PAGE = 1000

async function get(path, range, extra = {}) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: range, ...extra },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Supabase request failed (${res.status})`)
  return res
}
async function fetchAll(path) {
  let all = [], off = 0
  for (;;) {
    const page = await (await get(path, `${off}-${off + PAGE - 1}`)).json()
    all = all.concat(page)
    if (page.length < PAGE) return all
    off += PAGE
  }
}
async function fetchRecent(path) {
  const res = await get(path, `0-${PAGE - 1}`, { Prefer: 'count=exact' })
  const rows = await res.json()
  const total = parseInt((res.headers.get('content-range') || '').split('/')[1], 10) || rows.length
  return { rows, total }
}

function timeAgo(d) {
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 1440) return `${Math.floor(m / 60)}h ago`
  return `${Math.floor(m / 1440)}d ago`
}

const groupByVariant = (rows) => {
  const m = {}
  rows.forEach((r) => (m[r.variant_id] ||= []).push(r))
  return Object.values(m).map((g) => g.sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at)))
}

function changeEvents(rows) {
  const ev = []
  groupByVariant(rows).forEach((g) => {
    for (let i = 1; i < g.length; i++) {
      const p = g[i - 1], c = g[i]
      const base = { pid: c.product_id, product: c.product_title, variant: c.variant_title, at: c.changed_at }
      if (Number(p.price) !== Number(c.price))
        ev.push({ ...base, key: `${c.variant_id}${c.changed_at}p`, type: Number(c.price) < Number(p.price) ? 'drop' : 'rise', detail: `£${Number(p.price).toFixed(2)} → £${Number(c.price).toFixed(2)}` })
      if (p.available !== c.available)
        ev.push({ ...base, key: `${c.variant_id}${c.changed_at}a`, type: c.available ? 'back' : 'out', detail: c.available ? 'Back in stock' : 'Sold out' })
    }
  })
  return ev.sort((a, b) => new Date(b.at) - new Date(a.at))
}

const biggestMovers = (rows) =>
  groupByVariant(rows)
    .filter((g) => g.length > 1)
    .map((g) => {
      const f = Number(g[0].price), x = g[g.length - 1], l = Number(x.price)
      return { id: x.variant_id, product: x.product_title, variant: x.variant_title, f, l, pct: ((l - f) / f) * 100 }
    })
    .filter((m) => m.f !== m.l)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, 6)

function categoryHealth(rows) {
  const m = {}
  rows.forEach((r) => {
    const c = r.product_type || 'Uncategorized'
    m[c] ||= { total: 0, avail: 0 }
    m[c].total++
    if (r.available) m[c].avail++
  })
  return Object.entries(m)
    .map(([name, v]) => ({ name, ...v, pct: Math.round((v.avail / v.total) * 100) }))
    .sort((a, b) => b.total - a.total)
}

function dailyActivity(rows) {
  const m = {}
  rows.forEach((r) => { const d = r.changed_at.slice(0, 10); m[d] = (m[d] || 0) + 1 })
  return Object.keys(m).sort().slice(-14).map((d) => ({ day: d.slice(5), n: m[d] }))
}

const EV = {
  drop: ['Price drop', 'g'],
  rise: ['Price increase', 'a'],
  back: ['Restocked', 'g'],
  out: ['Sold out', 'r'],
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap');
:root{--g:#96bd42;--g2:#729b2e;--pale:#edf4dc;--ink:#20241d;--muted:#777d72;--line:#e4e7df;--bg:#f8f8f5;--red:#bd6957;--amber:#a88635}
body{margin:0;background:var(--bg)}
.app{font-family:Roboto,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:var(--ink);min-height:100vh}
.shell{max-width:1200px;margin:auto;padding:24px 28px 48px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}
.brand{display:flex;align-items:center;gap:10px}
.mark{width:32px;height:32px;background:#111;border-radius:8px;color:#fff;display:grid;place-items:center;font-weight:700;font-size:16px}
.word{font-weight:700;font-size:17px;letter-spacing:3px}
.btn{font:inherit;font-size:13px;font-weight:500;padding:8px 14px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);cursor:pointer}
.btn:hover{border-color:var(--g)}
.hero{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px;margin-bottom:20px}
h1{font-size:26px;font-weight:500;margin:0 0 4px}
.sub{font-size:13px;color:var(--muted)}
.pill{font-size:11px;font-weight:500;letter-spacing:.5px;color:var(--g2);background:var(--pale);padding:7px 11px;border-radius:99px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px}
.kpi{cursor:pointer;text-align:left;font:inherit;color:inherit}
.kpi:hover,.kpi.on{border-color:var(--g)}
.lbl{font-size:12px;color:var(--muted)}
.val{font-size:26px;font-weight:500;margin-top:6px}
.two{display:grid;grid-template-columns:1.3fr 1fr;gap:14px;margin-bottom:14px}
.ttl{font-size:15px;font-weight:500;margin-bottom:12px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #eff1ec;font-size:13px}
.row:last-child{border-bottom:0}
.click{cursor:pointer}.click:hover{background:#fafbf7}
.muted{color:var(--muted)}
.tag{font-size:11px;font-weight:500;padding:3px 8px;border-radius:99px;margin-right:8px;white-space:nowrap}
.g{background:var(--pale);color:var(--g2)}.r{background:#f7e8e4;color:#a85445}.a{background:#f5eedb;color:var(--amber)}
.bar{height:6px;background:var(--line);border-radius:99px;overflow:hidden}.bar i{display:block;height:100%}
.act{display:flex;align-items:flex-end;gap:6px;height:100px}
.act div{flex:1;text-align:center;font-size:10px;color:var(--muted)}
.act i{display:block;background:var(--g);border-radius:3px 3px 0 0;margin-bottom:4px}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 12px}
.search{flex:1 1 220px;padding:9px 13px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:13px;outline:none;background:#fff}
.search:focus{border-color:var(--g)}
.chip{font:inherit;font-size:12px;font-weight:500;padding:7px 12px;border:1px solid var(--line);border-radius:99px;background:#fff;color:var(--muted);cursor:pointer}
.chip.on{background:var(--pale);border-color:var(--g);color:var(--g2)}
.tbl{padding:0;overflow:hidden}
.th,.tr{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;padding:12px 18px;font-size:13px;align-items:center}
.th{font-size:12px;color:var(--muted);border-bottom:1px solid var(--line);background:#fbfbf9}
.th span{cursor:pointer}.th span:hover{color:var(--ink)}
.tr{border-bottom:1px solid #eff1ec;cursor:pointer}.tr:hover{background:#fafbf7}
.vars{padding:4px 18px 16px;display:flex;flex-wrap:wrap;gap:6px;border-bottom:1px solid #eff1ec;background:#fafbf7}
.v{font-size:12px;padding:5px 10px;border-radius:6px;border:1px solid var(--line);background:#fff}
.v.no{color:#a5aaa0;text-decoration:line-through}
.v.yes{border-color:var(--g);color:var(--g2)}
.foot{font-size:11px;color:var(--muted);text-align:center;margin-top:20px;line-height:1.7}
@media(max-width:760px){.two{grid-template-columns:1fr}.shell{padding:16px 12px 40px}.th,.tr{grid-template-columns:1.6fr 1fr 1fr}.hide{display:none}}
`

function Shell({ children }) {
  return (
    <div className="app">
      <style>{CSS}</style>
      <div className="shell">{children}</div>
    </div>
  )
}

export default function App() {
  const [current, setCurrent] = useState([])
  const [history, setHistory] = useState([])
  const [histTotal, setHistTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [updated, setUpdated] = useState(null)
  const [cat, setCat] = useState('All')
  const [stock, setStock] = useState('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState({ k: 'title', d: 1 })
  const [open, setOpen] = useState(null)
  const [limit, setLimit] = useState(50)
  const tableRef = useRef(null)
  const feedRef = useRef(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const [c, h] = await Promise.all([
        fetchAll('product_current?store=eq.allbirds&select=*&order=variant_id'),
        fetchRecent('product_history?store=eq.allbirds&select=*&order=changed_at.desc'),
      ])
      setCurrent(c); setHistory(h.rows); setHistTotal(h.total); setUpdated(new Date())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  const events = useMemo(() => changeEvents(history), [history])
  const movers = useMemo(() => biggestMovers(history), [history])
  const health = useMemo(() => categoryHealth(current), [current])
  const activity = useMemo(() => dailyActivity(history), [history])
  const maxAct = Math.max(1, ...activity.map((a) => a.n))
  const cats = useMemo(() => ['All', ...new Set(current.map((c) => c.product_type).filter(Boolean))], [current])

  const inStock = current.filter((c) => c.available).length
  const last24 = events.filter((e) => Date.now() - new Date(e.at).getTime() < 864e5).length

  const products = useMemo(() => {
    const m = {}
    current.forEach((v) => {
      const p = (m[v.product_id] ||= { id: v.product_id, title: v.product_title, type: v.product_type, prices: [], vars: [], avail: 0 })
      p.prices.push(Number(v.price)); p.vars.push(v)
      if (v.available) p.avail++
    })
    const cmp = {
      title: (a, b) => a.title.localeCompare(b.title),
      price: (a, b) => Math.min(...a.prices) - Math.min(...b.prices),
      stock: (a, b) => a.avail / a.vars.length - b.avail / b.vars.length,
    }[sort.k]
    return Object.values(m)
      .filter((p) => cat === 'All' || p.type === cat)
      .filter((p) => stock === 'all' || (stock === 'in' ? p.avail > 0 : p.avail === 0))
      .filter((p) => p.title.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => cmp(a, b) * sort.d)
  }, [current, cat, stock, q, sort])

  const jump = (ref) => setTimeout(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  const sortBy = (k) => setSort((s) => ({ k, d: s.k === k ? -s.d : 1 }))
  const arrow = (k) => (sort.k === k ? (sort.d === 1 ? ' ↑' : ' ↓') : '')
  const reset = () => { setCat('All'); setStock('all'); setQ(''); setOpen(null); jump(tableRef) }
  const focusEvent = (e) => { setCat('All'); setStock('all'); setQ(e.product); setOpen(e.pid); jump(tableRef) }

  if (loading) return <Shell><p className="muted" style={{ textAlign: 'center', padding: 80 }}>Loading live inventory data…</p></Shell>
  if (error) return (
    <Shell>
      <div style={{ textAlign: 'center', padding: 80 }}>
        <b style={{ color: 'var(--red)' }}>Couldn't load live data</b>
        <p className="sub">{error}</p>
        <p className="sub">Check the two VITE_SUPABASE variables and that public read access is enabled on the tables.</p>
      </div>
    </Shell>
  )

  const kpis = [
    { l: 'SKUs tracked', v: current.length, f: reset, on: stock === 'all' && cat === 'All' && !q },
    { l: 'In stock', v: inStock, f: () => { setStock('in'); jump(tableRef) }, on: stock === 'in' },
    { l: 'Out of stock', v: current.length - inStock, f: () => { setStock('out'); jump(tableRef) }, on: stock === 'out', red: true },
    { l: 'Changes (24h)', v: last24, f: () => jump(feedRef) },
  ]

  return (
    <Shell>
      <div className="top">
        <div className="brand"><div className="mark">E</div><div className="word">EMIMO</div></div>
        <div style={{ textAlign: 'right' }}>
          <button className="btn" onClick={load}>Refresh now</button>
          {updated && <div className="sub" style={{ marginTop: 5, fontSize: 11 }}>Updated {timeAgo(updated)}</div>}
        </div>
      </div>

      <div className="hero">
        <div>
          <h1>Allbirds — Live inventory</h1>
          <div className="sub">Real Shopify data, tracked automatically and refreshed every 60 seconds.</div>
        </div>
        <div className="pill">LIVE DATA · SHOPIFY</div>
      </div>

      <div className="kpis">
        {kpis.map((k) => (
          <button key={k.l} className={`card kpi ${k.on ? 'on' : ''}`} onClick={k.f}>
            <div className="lbl">{k.l}</div>
            <div className="val" style={k.red ? { color: 'var(--red)' } : null}>{k.v.toLocaleString()}</div>
          </button>
        ))}
      </div>

      <div className="two">
        <div className="card">
          <div className="ttl">Biggest movers</div>
          {!movers.length && <div className="sub">No repeated price changes tracked yet.</div>}
          {movers.map((m) => (
            <div className="row" key={m.id}>
              <div><b style={{ fontWeight: 500 }}>{m.product}</b><div className="sub">{m.variant}</div></div>
              <div style={{ textAlign: 'right' }}>
                <div className="sub">£{m.f.toFixed(2)} → £{m.l.toFixed(2)}</div>
                <b style={{ color: m.pct < 0 ? 'var(--g2)' : 'var(--amber)' }}>{m.pct > 0 ? '+' : ''}{m.pct.toFixed(1)}%</b>
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          <div className="ttl">Category stock health</div>
          {health.map((c) => (
            <div key={c.name} style={{ marginBottom: 12, cursor: 'pointer' }} onClick={() => { setCat(c.name); jump(tableRef) }}>
              <div className="row" style={{ padding: '0 0 5px', border: 0 }}>
                <span>{c.name}</span><span className="muted">{c.avail}/{c.total} ({c.pct}%)</span>
              </div>
              <div className="bar"><i style={{ width: `${c.pct}%`, background: c.pct >= 70 ? 'var(--g)' : c.pct >= 30 ? 'var(--amber)' : 'var(--red)' }} /></div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" ref={feedRef} style={{ marginBottom: 14 }}>
        <div className="ttl">Recently changed</div>
        {!events.length && <div className="sub">No changes detected yet — this only shows real price and stock changes.</div>}
        {events.slice(0, 12).map((e) => (
          <div className="row click" key={e.key} onClick={() => focusEvent(e)}>
            <div><span className={`tag ${EV[e.type][1]}`}>{EV[e.type][0]}</span>{e.product}<span className="muted"> — {e.variant}</span></div>
            <div className="muted" style={{ whiteSpace: 'nowrap' }}>{e.detail} · {timeAgo(e.at)}</div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 6 }}>
        <div className="ttl">Change activity — last {activity.length} days</div>
        {activity.length ? (
          <div className="act">
            {activity.map((a) => (
              <div key={a.day} title={`${a.n} changes`}>
                <i style={{ height: Math.max(6, (a.n / maxAct) * 70) }} />{a.day}
              </div>
            ))}
          </div>
        ) : <div className="sub">Not enough history yet.</div>}
      </div>

      <div ref={tableRef} className="filters">
        <input className="search" placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} />
        {[['all', 'All'], ['in', 'Has stock'], ['out', 'Sold out']].map(([k, l]) => (
          <button key={k} className={`chip ${stock === k ? 'on' : ''}`} onClick={() => setStock(k)}>{l}</button>
        ))}
      </div>
      <div className="filters" style={{ marginTop: 0 }}>
        {cats.map((c) => <button key={c} className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>)}
      </div>

      <div className="card tbl">
        <div className="th">
          <span onClick={() => sortBy('title')}>Product{arrow('title')}</span>
          <span className="hide">Type</span>
          <span onClick={() => sortBy('price')}>Price{arrow('price')}</span>
          <span onClick={() => sortBy('stock')}>Availability{arrow('stock')}</span>
        </div>
        {!products.length && <div className="sub" style={{ padding: 20, textAlign: 'center' }}>No products match this filter.</div>}
        {products.slice(0, limit).map((p) => {
          const lo = Math.min(...p.prices), hi = Math.max(...p.prices)
          const cls = p.avail === p.vars.length ? 'g' : p.avail === 0 ? 'r' : 'a'
          return (
            <div key={p.id}>
              <div className="tr" onClick={() => setOpen(open === p.id ? null : p.id)}>
                <b style={{ fontWeight: 500 }}>{p.title}</b>
                <span className="muted hide">{p.type || '—'}</span>
                <span>{lo === hi ? `£${lo}` : `£${lo}–${hi}`}</span>
                <span><span className={`tag ${cls}`}>{p.avail}/{p.vars.length} in stock</span></span>
              </div>
              {open === p.id && (
                <div className="vars">
                  {[...p.vars]
                    .sort((a, b) => parseFloat(a.variant_title) - parseFloat(b.variant_title) || String(a.variant_title).localeCompare(b.variant_title))
                    .map((v) => <span key={v.variant_id} className={`v ${v.available ? 'yes' : 'no'}`}>{v.variant_title}</span>)}
                </div>
              )}
            </div>
          )
        })}
        {products.length > limit && (
          <div style={{ padding: 14, textAlign: 'center' }}>
            <button className="btn" onClick={() => setLimit(limit + 50)}>Show 50 more ({products.length - limit} left)</button>
          </div>
        )}
      </div>

      <div className="foot">
        Data from Allbirds' public product feed, collected by an automated pipeline every 15 minutes.<br />
        {current.length.toLocaleString()} SKUs in the current table · {histTotal.toLocaleString()} change events logged
      </div>
    </Shell>
  )
}
