// 台股小牛 v2 — API layer.
// One place for: timeouts, in-memory TTL cache, stale-while-revalidate (slow
// endpoints paint instantly from the last result), 502-aware semantics
// (portfolio_get: "store unreachable" ≠ "empty"), and offline fallback via the
// service worker's last-known cache.

const mem = new Map();          // path → { t, data }
const inflight = new Map();     // path → Promise (dedupe concurrent calls)

export class ApiError extends Error {
  constructor(status, body, path) { super(`${status} ${path}`); this.status = status; this.body = body; this.path = path; }
}

async function fetchJSON(path, { timeout = 25000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(path, { signal: ctl.signal, headers: { 'Accept': 'application/json' } });
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!r.ok) throw new ApiError(r.status, body, path);
    markOffline(!!r.headers.get('X-Offline'));   // service worker served a last-known copy → say so honestly
    return body;
  } finally { clearTimeout(t); }
}
let offlineShown = false;
function markOffline(on) {
  if (on === offlineShown) return; offlineShown = on;
  const el = typeof document !== 'undefined' ? document.getElementById('offline') : null; if (!el) return;
  if (on) { el.textContent = '📴 目前離線，顯示最後一次取得的資料（時間為當時抓取）'; el.hidden = false; }
  else if (typeof navigator !== 'undefined' && navigator.onLine) el.hidden = true;
}

/** GET with TTL cache + request dedupe. ttl in ms (0 = always fresh). */
export async function get(path, { ttl = 0, timeout = 25000 } = {}) {
  const hit = mem.get(path);
  if (hit && ttl && Date.now() - hit.t < ttl) return hit.data;
  if (inflight.has(path)) return inflight.get(path);
  const p = fetchJSON(path, { timeout }).then(data => { mem.set(path, { t: Date.now(), data }); return data; })
    .finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

/** Stale-while-revalidate: calls render(data, {stale}) immediately with the
 *  last known result (if any), then again with fresh data. Returns fresh data. */
export async function swr(path, { ttl = 60000, timeout = 60000 } = {}, render) {
  const hit = mem.get(path);
  if (hit) render(hit.data, { stale: Date.now() - hit.t > ttl });
  if (hit && Date.now() - hit.t < ttl) return hit.data;
  try {
    const data = await get(path, { ttl: 0, timeout });
    render(data, { stale: false });
    return data;
  } catch (e) {
    if (hit) { render(hit.data, { stale: true, error: e }); return hit.data; }
    throw e;
  }
}

export async function post(path, body, { timeout = 15000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(path, { method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, data, path);
    return data;
  } finally { clearTimeout(t); }
}

export function invalidate(prefix) {
  for (const k of [...mem.keys()]) if (k.startsWith(prefix)) mem.delete(k);
}

// ── typed helpers (field names = backend contract) ──
export const API = {
  marketSummary: () => get('/api/market_summary', { ttl: 15000, timeout: 20000 }),
  weather:       () => get('/api/market_weather', { ttl: 5 * 60000, timeout: 60000 }),
  breadth:       () => get('/api/market_breadth', { ttl: 20000, timeout: 30000 }),
  sectors:       () => get('/api/sectors', { ttl: 30000, timeout: 20000 }),
  topBuys:  (render) => swr('/api/top_buys', { ttl: 120000, timeout: 90000 }, render),
  newsPicks:     () => get('/api/news_picks', { ttl: 120000, timeout: 30000 }),
  valueAlerts:   () => get('/api/value_alerts', { ttl: 300000, timeout: 60000 }),
  techPicks:     () => get('/api/tech_picks', { ttl: 120000, timeout: 60000 }),
  predictionReport: () => get('/api/prediction_report', { ttl: 600000, timeout: 20000 }),
  predict:   (code) => get(`/api/predict?code=${encodeURIComponent(code)}`, { ttl: 60000, timeout: 60000 }),
  signal:    (code) => get(`/api/stock_signal?code=${encodeURIComponent(code)}`, { ttl: 60000, timeout: 60000 }),
  realtime:  (codes, markets) => get(`/api/realtime?codes=${codes.map(encodeURIComponent).join(',')}&markets=${markets.map(encodeURIComponent).join(',')}`, { ttl: 15000, timeout: 20000 }),
  history:   (code, market, months=6) => get(`/api/history?code=${encodeURIComponent(code)}&market=${market}&months=${months}`, { ttl: 300000, timeout: 30000 }),
  search:    (q) => get(`/api/search?q=${encodeURIComponent(q)}`, { ttl: 600000, timeout: 15000 }),
  alertsList:    () => get('/api/alerts_list', { ttl: 0, timeout: 15000 }),
  alertAdd:  (code, target) => post('/api/alert_add', { code, target }),
  alertDel:  (id) => post('/api/alert_del', { id }),
  portfolioSignals: (codes, markets) => get(`/api/portfolio_signals?codes=${codes.map(encodeURIComponent).join(',')}&markets=${markets.map(encodeURIComponent).join(',')}`, { ttl: 60000, timeout: 90000 }),
  portfolioGet:  () => get('/api/portfolio_get', { ttl: 0, timeout: 15000 }),   // throws ApiError(502) when the store is unreachable — NOT empty
  portfolioSync: (stocks, holdings, unit) => post('/api/portfolio_sync', { stocks, holdings, unit }),
  pnlStats:      () => get('/api/pnl_stats', { ttl: 120000, timeout: 30000 }),
  topbuysBacktest: (months=12) => get(`/api/topbuys_backtest?months=${months}`, { ttl: 6 * 3600000, timeout: 120000 }),
  intraday:      () => get('/api/intraday_alerts?pct=5', { ttl: 20000, timeout: 30000 }),
  lineStatus:    () => get('/api/line_status', { ttl: 600000, timeout: 15000 }),
  aiAnalysis: (code, name, summary) => post('/api/ai_analysis', { code, name, summary }, { timeout: 60000 }),
};
