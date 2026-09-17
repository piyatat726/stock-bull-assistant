// 台股小牛 v2 — shared components. ONE card anatomy reused everywhere:
// identity · price (紅漲綠跌) · WHY (≤2 reasons) · probability (+n, horizon,
// honesty source) · plan bar (停損—現價—目標). Judgement uses icon+text badges,
// never price colours.
import { esc, num, cls, signPct, fmtPrice, fmtInt, openSheet, closeSheet, toast, store } from './ui.js';
import { API } from './api.js';

export const go = (hash) => { location.hash = hash; };
export const stockHref = (code) => `#/stock/${encodeURIComponent(code)}`;
export const mkTag = (m) => m === 'otc' ? '櫃' : '市';

export function sectionHead(title, { sub = '', link = '', href = '' } = {}) {
  return `<div class="stitle"><h2>${esc(title)}${sub ? ` <span class="sub">${esc(sub)}</span>` : ''}</h2>${link ? `<a href="${href}">${esc(link)} ›</a>` : ''}</div>`;
}
export function chip(text, k = '') { return `<span class="chip ${k}">${text}</span>`; }
export function judge(text, kind = 'neutral', icon = '') { return `<span class="jb ${kind}">${icon ? esc(String(icon)) + ' ' : ''}${esc(text)}</span>`; }
export function emptyState(icon, text, cta = '') { return `<div class="empty"><div class="big">${icon}</div>${text}${cta ? `<div class="mt3">${cta}</div>` : ''}</div>`; }

export function ident(s) {
  return `<div class="ident"><span class="nm">${esc(s.name || s.code)}</span><span class="cd">${esc(s.code)}</span>${s.market ? `<span class="mk">${mkTag(s.market)}</span>` : ''}</div>`;
}
export function priceBox(s) {
  const c = cls(s.change_pct);
  return `<div class="pricebox num"><div class="px ${c}">${fmtPrice(s.price)}</div><div class="ch ${c}">${signPct(s.change_pct)}</div></div>`;
}

/** Compact clickable row → stock detail. `right` overrides the right slot. */
export function stockRow(s, { right = null, sub = '', rank = null } = {}) {
  return `<a class="li" href="${stockHref(s.code)}">
    ${rank !== null ? `<span class="rank">${rank}</span>` : ''}
    <div class="grow"><div class="ident"><span class="name">${esc(s.name || s.code)}</span><span class="code">${esc(s.code)}${s.market ? ' · ' + mkTag(s.market) : ''}</span></div>${sub ? `<div class="xs dim ellipsis mt1">${sub}</div>` : ''}</div>
    <div class="right">${right !== null ? right : priceBox(s)}</div></a>`;
}

const SRC_KIND = { '技術進場': 'info', '利多新聞': 'gold', '科技動能': 'purple', '估值便宜': 'down' };
export function srcBadges(sources = [], n = 0) {
  const k = Math.min(n || sources.length, 4); const dots = '●'.repeat(k) + '○'.repeat(4 - k);   // 四個來源：技術／新聞／科技動能／估值
  return `<div class="srcs">${sources.map(s => chip(esc(s), SRC_KIND[s] || '')).join('')}<span class="dots">${dots}</span></div>`;
}

/** Honest probability line. p = top_buys pick or predict result. */
export function probLine(p) {
  const wp = num(p.win_prob); if (wp === null) return '';
  const src = p.prob_kind === 'stock'
    ? `這檔回測近一年同類訊號 <span class="n">${p.win_prob_n} 次</span>`
    : `此類設定（${esc(p.win_prob_class || '')}）近 12 個月回測`;
  const hz = p.horizon_days ? `，約 ${p.horizon_days} 天` : '';
  const bad = wp < 40;
  return `<div class="prob ${bad ? 'bad' : ''}">${p.outlook_tag || '📈'} <b>${esc(p.outlook || '短線偏多')}</b>　${src}勝率約 <b>${wp}%</b>${hz}${p.prob_kind !== 'stock' ? `<span class="n">（樣本數見「這套推薦準不準」）</span>` : ''}${p.outlook_note ? `<div class="n mt1">${esc(p.outlook_note)}</div>` : ''}${p.regime_warn ? `<div class="n mt1">⚠️ ${esc(p.regime_warn)}</div>` : ''}</div>`;
}

/** 停損 ── 現價 ── 目標 mini bar */
export function planBar({ entry, stop_loss, stop, target, risk_reward, price }) {
  const s = num(stop_loss ?? stop), t = num(target), e = num(entry), cur = num(price) ?? e;
  if (s === null || t === null || cur === null || t <= s) return '';
  const pos = Math.max(0, Math.min(100, (cur - s) / (t - s) * 100));
  return `<div class="plan">
    <div class="lab"><span>停損 <b class="num down">${fmtPrice(s)}</b></span>${e !== null ? `<span>進場 <b class="num">${fmtPrice(e)}</b></span>` : ''}<span>目標 <b class="num up">${fmtPrice(t)}</b></span></div>
    <div class="track"><span class="cur" style="left:${pos.toFixed(1)}%"></span></div>
    ${risk_reward ? `<div class="rr">風報比 1 : ${risk_reward}</div>` : ''}</div>`;
}

/** Full pick card (top_buys anatomy). */
export function pickCard(p, { rank = null, compact = false } = {}) {
  const why = (p.reasons || []).slice(0, 2);
  const r5 = p.range5 && p.range5.length === 2 ? `<div class="xs dim mt2">🔮 5日 ±1σ 區間 <b class="num" style="color:var(--text)">${fmtPrice(p.range5[0])}–${fmtPrice(p.range5[1])}</b>（依近期日波動 ×√5 推估${num(p.band_coverage) !== null ? `；1 日帶實測覆蓋 ${p.band_coverage}%` : ''}）</div>` : '';
  return `<a class="card tap" href="${stockHref(p.code)}">
    <div class="row between">${rank !== null ? `<span class="rank">${rank}</span>` : ''}<div class="grow">${ident(p)}</div>${priceBox(p)}</div>
    ${srcBadges(p.sources, p.n_sources)}
    ${why.length ? `<ul class="why"><span class="lbl">為什麼</span>${why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${compact ? '' : probLine(p)}
    ${compact ? '' : r5}
    ${compact ? '' : planBar(p)}
  </a>`;
}

/** Holding card from /api/portfolio_signals + local cost/qty. */
const ACTION_KIND = { below_stop: ['bad', '🛑'], hit_target: ['ok', '🎯'], near_target: ['ok', '📍'], buy_zone: ['ok', '✅'], wait_pullback: ['warn', '⏳'], watch: ['warn', '👀'], neutral: ['neutral', '➖'] };
const TREND_ICON = { up: '📈', down: '📉', flat: '➡️' };
export function holdingCard(h, hold = {}, unit = 'stock') {
  const [kind, icon] = ACTION_KIND[h.action] || ['neutral', '➖'];
  const cost = num(String(hold.cost || '').replace(/,/g, '')), qty = num(String(hold.qty || '').replace(/,/g, ''));
  let pl = '';
  if (cost && h.price) {
    const pct = (h.price - cost) / cost * 100; const shares = qty ? (unit === 'lot' ? qty * 1000 : qty) : 0;
    const amt = shares ? (h.price - cost) * shares : null;
    pl = `<div class="row between mt2 sm"><span class="dim">成本 <b class="num">${fmtPrice(cost)}</b>${qty ? ` · ${fmtInt(qty)} ${unit === 'lot' ? '張' : '股'}` : ''}</span><span class="num b ${cls(pct)}">${signPct(pct)}${amt !== null ? ` (${amt >= 0 ? '+' : '−'}${fmtInt(Math.abs(amt))})` : ''}</span></div>`;
  }
  const err = h.error ? `<div class="note mt2">資料不足，暫無法分析</div>` : '';
  return `<div class="card">
    <a class="row between" href="${stockHref(h.code)}"><div class="grow">${ident(h)}</div>${priceBox(h)}</a>
    <div class="row mt2" style="flex-wrap:wrap;gap:6px">${judge(h.action_label || '觀察', kind, icon)}${h.trend_label ? chip(`${TREND_ICON[h.trend] || ''} ${esc(h.trend_label)}`) : ''}</div>
    ${h.action_desc ? `<div class="why mt2">${esc(h.action_desc)}</div>` : ''}
    ${pl}${err}
    ${planBar({ entry: h.entry, stop_loss: h.stop_loss, target: h.target, price: h.price })}
    <div class="row mt3" style="gap:8px">
      <button class="btn sm grow" data-act="cost" data-code="${esc(h.code)}">✏️ 成本/數量</button>
      <button class="btn sm grow" data-act="alert" data-code="${esc(h.code)}" data-name="${esc(h.name || '')}" data-price="${h.price ?? ''}">🔔 設提醒</button>
      <button class="btn sm" data-act="remove" data-code="${esc(h.code)}" aria-label="移除">✕</button>
    </div></div>`;
}

export function alertRow(a) {
  const dir = a.direction === 'up' ? '漲到 ≥' : '跌到 ≤';
  return `<div class="li"><div class="grow"><div class="ident"><span class="name"><a href="${stockHref(a.code)}">${esc(a.name || a.code)}</a></span><span class="code">${esc(a.code)}</span></div><div class="xs dim mt1">${dir} <b class="num ${a.direction === 'up' ? 'up' : 'down'}">${fmtPrice(a.target)}</b> · 到價推 LINE</div></div><button class="btn sm" data-act="del-alert" data-id="${a.id}" aria-label="刪除提醒">✕</button></div>`;
}

export function tiles(items) {
  return `<div class="tiles">${items.map(t => `<div class="tile"><div class="k">${esc(t.k)}</div><div class="v num ${t.cls || ''}">${t.v}</div></div>`).join('')}</div>`;
}

/** 市場天氣 hero. w = /api/market_weather; idx = market_summary.tse */
export function weatherCard(w, idx, { compact = false } = {}) {
  if (!w || !w.label) return '';
  const c = idx ? cls(idx.change_pct) : 'flat';
  return `<div class="card hero">
    <div class="row between">
      <div><div class="xs dim">大盤天氣</div><div class="regime">${w.icon || ''} ${esc(w.label)}格局</div></div>
      ${idx ? `<div class="pricebox num"><div class="big ${c}">${fmtInt(idx.price)}</div><div class="ch ${c}">${idx.change ? `${num(idx.change) > 0 ? '+' : ''}${fmtInt(idx.change)} ` : ''}${signPct(idx.change_pct)}</div></div>` : ''}
    </div>
    ${compact ? '' : `<div class="sm mt3" style="color:var(--text-2)">歷史同格局 5 日後上漲機率 <b class="gold">${w.fwd5_up_prob ?? '—'}%</b><span class="dim xs">（${w.n_hist || 0} 次，參考用）</span>${w.class_win_rate_here != null ? ` · 此格局進場訊號勝率 <b>${w.class_win_rate_here}%</b><span class="dim xs">（${w.class_n_here} 筆）</span>` : ''}</div>`}
  </div>`;
}

/** 預測自評 + 戰績 */
export function calibrationCard(rep, pnl) {
  const st = (pnl && pnl.stats) || {};
  let cal = '';
  if (rep && rep.buckets && rep.buckets.length) {
    cal = `<div class="cal">${rep.buckets.map(b => `<div class="r"><span>說 <b>${b.predicted_avg}%</b></span><div class="bars"><div class="bar"><i class="pred" style="width:${b.predicted_avg}%"></i></div><div class="bar"><i class="act" style="width:${b.actual_win_rate}%"></i></div></div><span class="num">實際 <b>${b.actual_win_rate}%</b><br><span class="dim">${b.n} 筆</span></span></div>`).join('')}</div><div class="note mt2">灰＝我說的機率，金＝實際發生率。越接近越誠實。</div>`;
  } else if (rep && rep.total) {
    cal = `<div class="note">🔮 預測自評：樣本累積中（已結 ${rep.total} 筆，滿 10 筆開始評分）</div>`;
  } else {
    cal = `<div class="note">🔮 預測自評：從每筆推薦的「我說的機率」對照「實際結果」，滿 10 筆開始評分。</div>`;
  }
  const t = st.closed_count ? tiles([
    { k: '勝率', v: `${st.win_rate ?? 0}%<div class="xs dim">${num(st.wins) !== null && num(st.losses) !== null ? `${st.wins} 勝 ${st.losses} 敗` : `${st.closed_count} 筆`}</div>`, cls: '' },
    { k: '累積報酬', v: signPct(st.total_pnl_pct, 1), cls: cls(st.total_pnl_pct) },
    { k: '每筆期望', v: signPct(st.expectancy_pct ?? st.avg_pnl_pct, 2), cls: cls(st.expectancy_pct ?? st.avg_pnl_pct) },
    { k: '持有中', v: `${st.open_count ?? 0}`, cls: '' },
  ]) : `<div class="note">戰績帳本尚無已平倉紀錄</div>`;
  return `<div class="card"><div class="stitle"><h2>🔮 預測自評 · 戰績</h2>${pnl && /^https:\/\//i.test(String(pnl.dashboard_url || '')) ? `<a href="${esc(pnl.dashboard_url)}" target="_blank" rel="noopener">完整戰績 ›</a>` : ''}</div>${cal}<div class="mt3">${t}</div><div class="note mt2">紙上模擬，不含手續費／滑價。</div></div>`;
}

// ── sheets: search / quick actions / alert ──
let stockList = null;
async function loadStockList() {
  if (stockList) return stockList;
  try { const r = await fetch('/api/stock_list'); stockList = await r.json(); } catch { stockList = []; }
  return stockList;
}
export function openSearchSheet() {
  const hot = ['2330 台積電', '2317 鴻海', '2454 聯發科', '2382 廣達', '0050 元大台灣50', '00878 國泰永續高股息'];
  const sh = openSheet(`<div class="searchbar"><input id="q" class="input" placeholder="輸入代碼或名稱，例如 2330 / 台積電" inputmode="search" enterkeyhint="search" autocomplete="off"></div>
    <div id="q-res" class="list mt3"><div class="xs dim mb2">熱門</div>${hot.map(h => { const [c, n] = h.split(' '); return `<a class="li" href="${stockHref(c)}"><div class="ident"><span class="name">${n}</span><span class="code">${c}</span></div></a>`; }).join('')}</div>`);
  const inp = sh.querySelector('#q'); const res = sh.querySelector('#q-res');
  setTimeout(() => inp.focus(), 250);
  let t = null;
  inp.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = inp.value.trim(); if (!q) return;
      const list = await loadStockList();
      const ql = q.toUpperCase();
      const m = list.filter(s => String(s.code).startsWith(ql) || (s.name || '').includes(q)).slice(0, 12);
      res.innerHTML = m.length ? m.map(s => `<a class="li" href="${stockHref(s.code)}"><div class="ident"><span class="name">${esc(s.name)}</span><span class="code">${esc(s.code)}${s.market ? ' · ' + mkTag(s.market) : ''}</span></div><span class="dim">›</span></a>`).join('')
        : `<div class="empty sm">找不到「${esc(q)}」</div>`;
    }, 200);
  });
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && /^\d{4,6}[A-Z]?$/i.test(inp.value.trim())) { closeSheet(); go(stockHref(inp.value.trim().toUpperCase())); } });
  sh.addEventListener('click', e => { if (e.target.closest('a.li')) closeSheet(); });
}

export function openAlertSheet(code, name, price) {
  const sh = openSheet(`<div class="stitle"><h2>🔔 設定到價提醒</h2></div>
    <div class="sm dim mb3">${esc(name || code)}（${esc(code)}）現價 <b class="num" style="color:var(--text)">${fmtPrice(price)}</b>。到價自動推 LINE，漲／跌方向依現價自動判斷。</div>
    <input id="al-price" class="input" placeholder="目標價" inputmode="decimal">
    <div class="row mt3" style="gap:8px"><button class="btn grow" id="al-cancel">取消</button><button class="btn primary grow" id="al-ok">設定提醒</button></div>
    <div id="al-msg" class="note mt2"></div>`);
  sh.querySelector('#al-cancel').onclick = closeSheet;
  sh.querySelector('#al-ok').onclick = async () => {
    const v = parseFloat(String(sh.querySelector('#al-price').value).replace(/,/g, ''));
    const msg = sh.querySelector('#al-msg');
    if (!v) { msg.textContent = '請輸入目標價'; return; }
    msg.textContent = '設定中…';
    try {
      const d = await API.alertAdd(code, v);
      if (!d.ok) { msg.textContent = d.msg || '設定失敗'; return; }
      toast(`✓ ${d.name}(${code}) ${d.direction === 'up' ? '漲到 ≥' : '跌到 ≤'} ${v}，到價推 LINE`, 'ok'); closeSheet();
    } catch { msg.textContent = '設定失敗，請稍後再試'; }
  };
  setTimeout(() => sh.querySelector('#al-price').focus(), 250);
}

export function openQuickActions(code, name, price) {
  const sh = openSheet(`<div class="stitle"><h2>${esc(name || code)} <span class="sub">${esc(code)}</span></h2></div>
    <div class="col">
      <button class="btn block" data-q="detail">📊 看完整分析</button>
      <button class="btn block" data-q="hold">💼 加入持股</button>
      <button class="btn block" data-q="alert">🔔 設到價提醒</button>
    </div>`);
  sh.addEventListener('click', e => {
    const b = e.target.closest('[data-q]'); if (!b) return;
    const q = b.dataset.q; closeSheet();
    if (q === 'detail') go(stockHref(code));
    if (q === 'alert') setTimeout(() => openAlertSheet(code, name, price), 280);
    if (q === 'hold') { addHolding(code, name); }
  });
}

// ── holdings local store (mirrors legacy keys so both UIs stay in sync) ──
export const holdings = {
  stocks() { return store.get('portfolioStocks', []) || []; },
  data() { return store.get('portfolio', {}) || {}; },
  unit() { try { return localStorage.getItem('pUnit') || 'stock'; } catch { return 'stock'; } },
  setUnit(u) { try { localStorage.setItem('pUnit', u); } catch {} },
  has(code) { return this.stocks().some(s => s.code === code); },
};
export function addHolding(code, name, market = 'tse') {
  const list = holdings.stocks();
  if (list.some(s => s.code === code)) { toast('已在持股中'); return false; }
  list.push({ code, name: name || code, market });
  store.set('portfolioStocks', list); syncPortfolio();
  toast(`已加入持股 ${name || code}`, 'ok'); return true;
}
export function removeHolding(code) {
  store.set('portfolioStocks', holdings.stocks().filter(s => s.code !== code));
  const d = holdings.data(); delete d[code]; store.set('portfolio', d); syncPortfolio(true);
}
export function setHolding(code, cost, qty) {
  const d = holdings.data(); d[code] = { cost: String(cost ?? ''), qty: String(qty ?? '') }; store.set('portfolio', d); syncPortfolio();
}
let syncT = null; let cloudOk = false; try { cloudOk = !!localStorage.getItem('portfolioStocks'); } catch {}
export function markCloudOk() { cloudOk = true; }
export function syncPortfolio(allowEmpty = false) {
  clearTimeout(syncT);
  syncT = setTimeout(async () => {
    if (!cloudOk) {   // 開機時雲端沒讀到（502／離線）→ 先把雲端的合併回本機，絕不能用本機的少量清單蓋掉雲端
      let d = null;
      try { d = await API.portfolioGet(); cloudOk = true; } catch { toast('雲端持股尚未確認，暫不同步', 'err'); return; }
      if (d && Array.isArray(d.stocks) && d.stocks.length) {
        const local = holdings.stocks();
        const cloudCodes = new Set(d.stocks.filter(s => s && s.code).map(s => String(s.code)));
        const merged = [...d.stocks.filter(s => s && s.code), ...local.filter(s => s && s.code && !cloudCodes.has(String(s.code)))];
        store.set('portfolioStocks', merged);
        store.set('portfolio', { ...(d.holdings || {}), ...holdings.data() });   // 本機剛填的成本優先
        let hasUnit = false; try { hasUnit = !!localStorage.getItem('pUnit'); } catch {}
        if (d.unit && !hasUnit) holdings.setUnit(d.unit);
        toast('已把雲端持股合併回來', 'ok');
      }
    }
    const stocks = holdings.stocks(); if (!stocks.length && !allowEmpty) return;
    try { await API.portfolioSync(stocks, holdings.data(), holdings.unit()); } catch {}
  }, 1200);
}
/** Cross-device restore. Distinguishes 502 (unreachable) from {} (empty). */
export async function restorePortfolio() {
  let hasLocal = false; try { hasLocal = !!localStorage.getItem('portfolioStocks'); } catch {}
  if (hasLocal) { cloudOk = true; return; }
  try {
    const d = await API.portfolioGet(); cloudOk = true;
    if (d && Array.isArray(d.stocks) && d.stocks.length) {
      store.set('portfolioStocks', d.stocks); if (d.holdings) store.set('portfolio', d.holdings); if (d.unit) holdings.setUnit(d.unit);
    }
  } catch { /* 502 → keep cloudOk=false; syncs stay blocked */ }
}

// ═══ 市場天氣 reference components ═══
const SECTOR_ICON = { '半導體': '🔲', '電子': '💻', '金融': '🏦', '金融保險': '🏦', '航運': '🚢', '生技': '🧬', '生技醫療': '🧬', '食品': '🍱', '塑膠': '🧴', '紡織': '🧵', '電機': '⚙️', '電機機械': '⚙️', '電器': '🔌', '化學': '⚗️', '玻璃': '🪟', '造紙': '📄', '鋼鐵': '🏗️', '橡膠': '🛞', '汽車': '🚗', '建材': '🧱', '建材營造': '🧱', '營造': '🧱', '觀光': '🏖️', '觀光餐旅': '🏖️', '貿易': '🛍️', '貿易百貨': '🛍️', '油電': '⛽', '油電燃氣': '⛽', '光電': '💡', '通信': '📡', '通信網路': '📡', '電子零組件': '🔩', '電腦': '🖥️', '電腦週邊': '🖥️', '其他': '📦', '水泥': '🏭', '數位雲端': '☁️', '綠能': '🌱', '運動休閒': '🏃', '居家生活': '🏠' };
export const sectorIcon = (name) => { const n = String(name || ''); for (const k of Object.keys(SECTOR_ICON)) if (n.includes(k)) return SECTOR_ICON[k]; return '📊'; };
const SKY = { '晴': 'sunny', '晴時多雲': 'sunny', '多雲': 'cloudy', '陰': 'cloudy', '雨': 'rain' };

/** 市場天氣 hero（reference look）。b = /api/market_breadth，idx = market_summary.tse（可空）。
 *  b === undefined → 載入中；null → 服務無回應（顯示指數即可）。 */
export function skyHero(b, idx) {
  const c = idx ? cls(idx.change_pct) : 'flat';
  const idxLine = idx && num(idx.price) !== null
    ? `<span class="num ${c}">加權 ${fmtInt(idx.price)}　${signPct(idx.change_pct)}</span>` : '';
  if (b === undefined) return `<div class="sky"><div class="glow"></div><div class="sun"></div><div class="cloud c1"></div><div class="caption"><div class="k">MARKET WEATHER</div><div class="sk sk-line" style="width:160px;height:34px">.</div><div class="sub"><span class="sk sk-line" style="width:200px">.</span></div></div><div class="foot">${idxLine}</div></div>`;
  if (!b) return `<div class="sky cloudy"><div class="glow"></div><div class="sun"></div><div class="cloud c1"></div><div class="cloud c2"></div><div class="caption"><div class="k">MARKET WEATHER</div><div class="label">暫無天氣</div><div class="sub">市場天氣服務暫時無回應</div></div><div class="foot">${idxLine}</div></div>`;
  const kind = SKY[b.weather] || 'cloudy';
  const clouds = kind === 'sunny' && b.weather === '晴' ? '' : `<div class="cloud c1"></div>${kind !== 'sunny' ? '<div class="cloud c2"></div>' : ''}`;
  const d8 = String(b.as_of || ''); const md = /^\d{8}$/.test(d8) ? `${+d8.slice(4, 6)}/${+d8.slice(6, 8)}` : d8;
  const when = b.market_open ? `盤中 ${esc(b.tw_time || '')}` : `${esc(md)} 收盤`;
  return `<div class="sky ${kind}"><div class="glow"></div><div class="sun"></div>${clouds}
    <div class="caption"><div class="k">市場天氣 · ${when}</div><div class="label">${esc(b.weather)}</div><div class="sub">${esc(b.headline)}</div></div>
    <div class="foot">${idxLine}${idxLine ? ' · ' : ''}樣本 ${b.n} 檔熱門股 · 描述現況，不是預測</div></div>`;
}

/** 「今天，大家都漲嗎？」breadth + 市場起伏 */
export function breadthCard(b) {
  if (!b) return '';
  const up = num(b.up_pct) ?? 0, dn = num(b.down_pct) ?? 0, fl = Math.max(0, 100 - up - dn);
  const lv = ['平穩', '震盪', '劇烈'];
  return `<div class="card">
    <div class="eyebrow">TODAY</div><div class="h-display">${b.market_open ? '今天' : '這個交易日'}，大家都漲嗎？</div>
    <div class="breadth"><i class="u" style="width:${up}%"></i><i class="f" style="width:${fl}%"></i><i class="d" style="width:${dn}%"></i></div>
    <div class="legend3"><div class="it u"><div class="k">上漲</div><div class="v num">${up}%</div></div><div class="it f"><div class="k">持平</div><div class="v num">${fl}%</div></div><div class="it d"><div class="k">下跌</div><div class="v num">${dn}%</div></div></div>
    <div class="sm mt2" style="color:var(--text-2)">每 10 檔約 <b>${b.per10 ?? Math.round(up / 10)}</b> 檔上漲<span class="dim xs">（熱門股樣本 ${b.n} 檔，±0.2% 內視為持平）</span></div>
    <div class="hairline"></div>
    <div class="eyebrow">VOLATILITY</div><div class="b mt1">市場起伏</div>
    <div class="vol3">${lv.map(l => `<span class="${b.vol_level === l ? 'on' : ''}">${l}</span>`).join('')}</div>
    <div class="xs dim mt2">平均單檔波動 ${b.avg_abs_pct}%：小於 1% 平穩、1–2.5% 震盪、以上劇烈。</div>
  </div>`;
}

/** 產業地圖：list = /api/sectors（realtime dicts；濾掉加權 t00）。limit 張數。 */
export function sectorMap(list, { limit = 6 } = {}) {
  const rows = (Array.isArray(list) ? list : []).filter(s => s && s.code !== 't00' && num(s.change_pct) !== null);
  if (!rows.length) return '';
  const sorted = [...rows].sort((a, b) => num(b.change_pct) - num(a.change_pct));
  const show = limit ? [...sorted.slice(0, Math.ceil(limit / 2)), ...sorted.slice(-Math.floor(limit / 2))].filter((s, i, arr) => arr.indexOf(s) === i) : sorted;
  const tile = (s) => { const v = num(s.change_pct); const k = v > 0.05 ? 'u' : v < -0.05 ? 'd' : 'f';
    return `<a class="stile ${k}" href="#/market/sectors"><div class="ic">${sectorIcon(s.name)}</div><div class="nm ellipsis" style="max-width:100%">${esc(String(s.name || '').replace(/類?指數$/, ''))}</div><div class="ch num ${cls(v)}">${signPct(v, 1)}</div></a>`; };
  const top = sorted[0], bot = sorted[sorted.length - 1];
  const insight = sorted.length > 1 ? `${esc(String(top.name).replace(/類?指數$/, ''))}${num(top.change_pct) > 0 ? '領漲' : '相對抗跌'}，${esc(String(bot.name).replace(/類?指數$/, ''))}${num(bot.change_pct) < 0 ? '偏弱' : '漲幅最小'}` : '';
  return `<div class="tiles3">${show.map(tile).join('')}</div>${insight ? `<div class="card mt3"><div class="row"><span style="font-size:22px">💡</span><div class="grow"><div class="b">${insight}</div><div class="xs dim mt1">依各類股指數即時漲跌幅（TWSE）</div></div></div></div>` : ''}`;
}

/** 說明列：為什麼關注 / 證據是什麼 / 需要注意 / 下一個觀察點 */
export function xrow(icon, k, v, href = '') {
  const inner = `<div class="ic">${icon}</div><div class="grow"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>${href ? '<span class="arr">›</span>' : ''}`;
  return href ? `<a class="xrow" href="${href}">${inner}</a>` : `<div class="xrow">${inner}</div>`;
}

/** 股票觀察卡（reference：為什麼關注／證據是什麼／需要注意／下一個觀察點）。
 *  sig = /api/stock_signal（可空／error），pred = /api/predict（可空），q = realtime dict（可空）。
 *  只用後端實際給的欄位；沒有資料的列顯示「資料不足」，不編造。 */
export function observeRows(sig, pred, q = null, { code = '' } = {}) {
  const ok = sig && !sig.error;
  const bulls = ok ? (sig.signals || []).filter(x => x && x.bullish !== false) : [];
  const bears = ok ? (sig.signals || []).filter(x => x && x.bullish === false) : [];
  const why = ok
    ? (bulls.length ? `${esc(bulls[0].icon || '')} ${esc(bulls[0].desc || bulls[0].type || '')}${bulls.length > 1 ? `<span class="dim xs">　+${bulls.length - 1} 個多方訊號</span>` : ''}` : `<span class="dim">目前沒有多方技術訊號</span>`)
    : `<span class="dim">${sig && sig.error === 'insufficient_data' ? '歷史資料不足，無法判斷' : '訊號資料不足'}</span>`;
  const evid = ok
    ? `${esc(sig.verdict_icon || '')} ${esc(sig.verdict || '')}<span class="dim xs">　多方 ${num(sig.bullish_weight) ?? 0} · 空方 ${num(sig.bearish_weight) ?? 0}（${num(sig.signal_count) ?? 0} 個訊號）</span>`
    : `<span class="dim">資料不足</span>`;
  const stop = ok ? num(sig.stop_loss) : null;
  const care = bears.length ? `${esc(bears[0].icon || '')} ${esc(bears[0].desc || bears[0].type || '')}`
    : (stop !== null ? `跌破停損 <b class="num down">${fmtPrice(stop)}</b>${sig.stop_pct ? `<span class="dim xs">（−${sig.stop_pct}%）</span>` : ''}` : `<span class="dim">資料不足</span>`);
  const r5 = pred && Array.isArray(pred.range5) && pred.range5.length === 2 ? pred.range5 : null;
  const target = ok ? num(sig.target) : null;
  const nextp = target !== null ? `目標 <b class="num up">${fmtPrice(target)}</b>${sig.target_pct ? `<span class="dim xs">（+${sig.target_pct}%）</span>` : ''}${r5 ? `<span class="dim xs">　5 日區間 ${fmtPrice(r5[0])}–${fmtPrice(r5[1])}</span>` : ''}`
    : (r5 ? `5 日 ±1σ 區間 <b class="num">${fmtPrice(r5[0])}–${fmtPrice(r5[1])}</b><span class="dim xs">（依日波動推估${num(pred.band_coverage) !== null ? `；1 日帶實測覆蓋 ${pred.band_coverage}%` : ''}）</span>` : `<span class="dim">資料不足</span>`);
  const href = code ? `#/stock/${encodeURIComponent(code)}/` : '';
  return xrow('🎯', '為什麼關注', why, href ? href + 'signals' : '')
    + xrow('🧾', '證據是什麼', evid, href ? href + 'signals' : '')
    + xrow('⚠️', '需要注意', care, href ? href + 'chart' : '')
    + xrow('🧭', '下一個觀察點', nextp, href ? href + 'predict' : '');
}

/** 股票 hero（reference 插畫卡）。q = realtime dict；tag = 例如「成長觀察」；art = emoji 插畫 */
export function stockHero(q, { tag = '', tagKind = '', tagIcon = '', lead = '', art = '📈' } = {}) {
  if (!q) return '';
  const c = cls(q.change_pct);
  return `<div class="shero"><div class="art" aria-hidden="true">${art}</div>
    <div class="nm">${esc(q.name || q.code)}<span class="dim sm" style="font-family:var(--font)"> ${esc(q.code)}${q.market ? ' · ' + mkTag(q.market) : ''}</span>${tag ? judge(tag, tagKind || 'ok', tagIcon) : ''}</div>
    ${lead ? `<div class="lead">${lead}</div>` : ''}
    <div class="px num ${c}">${fmtPrice(q.price)} <span class="lg">${signPct(q.change_pct)}</span></div>
  </div>`;
}
