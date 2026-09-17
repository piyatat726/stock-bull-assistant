// 台股小牛 v2 — 市場：大盤 | 法人 | 排行 | 新聞（sticky 子分段，記住上次分段，params[0] 可覆寫）。
// 非個人化、非推薦的市場脈絡資料。每張卡各自 fetch、各自 skeleton、互不阻塞；
// 分段切換或 teardown 後，所有進行中的填充一律略過（segGen / alive 守門）。
// 顏色規則：價格／漲跌／買賣超／量能 → 紅漲綠跌（cls / pctPill / priceBox）；
// 盤後展望這類「判斷」只用 judge() 徽章，不替裸數字上判斷色。
import { render as paint, esc, num, cls, signPct, fmtPrice, fmtInt, pctPill, skLines, timeAgo, marketOpen, store, twNow, toast } from '../ui.js';
import { API, get, invalidate } from '../api.js';
import { sectionHead, chip, judge, emptyState, stockRow, stockHref, tiles, sectorIcon, skyHero, breadthCard, sectorMap } from '../components.js';
import { mountEquity } from '../chart.js';

// ── constants ──
const SEGS = [['overview', '大盤'], ['inst', '法人'], ['rank', '排行'], ['news', '新聞']];
// 舊路由／其他頁面連進來的別名（首頁「盤中異動 看全部」用 #/market/moves）
const ALIAS = { moves: 'rank', ranking: 'rank', institutional: 'inst', margin: 'inst', sectors: 'overview', gooaye: 'news' };
// 顯示字 → 送給 /api/news 的關鍵字（後端會自動補「股票」，非數字關鍵字用完整詞比較準）
const NEWS_KW = [['台股', '台股'], ['台積電', '台積電'], ['AI', 'AI概念股'], ['半導體', '半導體'], ['金融', '金融股'], ['ETF', 'ETF']];
const SEG_KEY = 'market_seg', NEWS_KEY = 'market_news_q';
const ANN_FOLD = 6;   // 公告先顯示幾則

// ── private helpers ──
const card = (inner, k = '') => `<div class="card${k ? ' ' + k : ''}">${inner}</div>`;
const arr = (v) => (Array.isArray(v) ? v : []);
const cleanNum = (v) => num(String(v ?? '').replace(/,/g, ''));
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? esc(u) : '#');
const hhmm = (d = twNow()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const isSeg = (k) => SEGS.some(([s]) => s === k);
/** 有號整數（張／點），紅漲綠跌 */
const signedInt = (v) => { const n = num(v); return n === null ? '<span class="num flat">—</span>' : `<span class="num ${cls(n)}">${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtInt(Math.abs(n))}</span>`; };
/** 有號價格（指數點數／匯率），d = 小數位（null → fmtPrice） */
const signedPx = (v, d = null) => { const n = num(v); if (n === null) return '—'; const a = Math.abs(n); return `${n > 0 ? '+' : n < 0 ? '−' : ''}${d === null ? fmtPrice(a) : a.toFixed(d)}`; };
/** 融資券餘額（張）：大數用「萬張」 */
const fmtLots = (v) => { const n = num(v); if (n === null) return '—'; return Math.abs(n) >= 100000 ? `${(n / 10000).toFixed(1)} 萬張` : `${fmtInt(n)} 張`; };
/** 民國 yyy/MM/dd → 西元；其他格式原樣回傳 */
const rocDate = (s) => { const m = String(s || '').match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/); return m ? `${+m[1] + 1911}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}` : String(s || ''); };
const trunc = (s, n = 14) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
/** daily_summary.outlook 是文字判斷 → 徽章種類（先測空再測多，避免「多空不明」誤判） */
const outlookKind = (s) => { s = String(s || ''); if (/空|弱|保守|謹慎/.test(s)) return 'warn'; if (/多|強|樂觀/.test(s)) return 'ok'; return 'neutral'; };
/** 盤中異動類型 chip：漲停／大漲 紅、跌停／大跌 綠（方向色） */
const typeChip = (x) => chip(`${esc(x.icon || '')} ${esc(x.type || '異動')}`, /漲/.test(x.type || '') ? 'up' : /跌/.test(x.type || '') ? 'down' : '');
const failNote = (msg, key) => `<div class="row between"><span class="note">${msg}</span><button class="btn sm" data-act="retry" data-load="${key}">重試</button></div>`;
/** HTTP-200 error body（{error:…}）→ 視為空資料 */
const isErr = (d) => !!(d && typeof d === 'object' && !Array.isArray(d) && d.error);
/** 等 lightweight-charts（index.html 用 defer 載入，可能比模組晚到） */
function waitLW(ms = 6000) {
  return new Promise(res => { const t0 = Date.now(); (function tick() { if (window.LightweightCharts) return res(true); if (Date.now() - t0 > ms) return res(false); setTimeout(tick, 150); })(); });
}
/** 可點列 + 迷你長條（法人買賣超／成交量）。pct = 長條寬度 %，dir = up|down（紅漲綠跌） */
function barRow(s, { rank = null, pct = 0, dir = 'flat', right = '', sub = '' } = {}) {
  const w = Math.max(0, Math.min(100, num(pct) || 0)).toFixed(1);
  return `<a class="li" href="${stockHref(s.code)}">${rank !== null ? `<span class="rank">${rank}</span>` : ''}
    <div class="grow"><div class="ident"><span class="name">${esc(s.name || s.code)}</span><span class="code">${esc(s.code)}</span></div>
    <div class="mbar mt1"><i class="${dir}" style="width:${w}%"></i></div>${sub ? `<div class="xs dim ellipsis mt1">${sub}</div>` : ''}</div>
    <div class="right">${right}</div></a>`;
}
/** 卡內雙面板切換（.subtabs 36px 高 + 間距 ≈ 44px 觸控）：paneTabs 產生按鈕，pane 產生面板 */
const paneTabs = (id, opts, active) => `<div class="subtabs" role="group" data-panes="${id}">${opts.map(([k, l]) => `<button data-act="pane" data-pane="${k}" class="${k === active ? 'on' : ''}" aria-pressed="${k === active}">${l}</button>`).join('')}</div>`;
const pane = (id, k, active, inner) => `<div data-pane-of="${id}" data-pane="${k}"${k === active ? '' : ' hidden'}>${inner}</div>`;
const listOr = (rows, emptyHtml) => (rows.length ? `<div class="list">${rows.join('')}</div>` : emptyHtml);

export async function render(view, params = []) {
  let alive = true;
  let segGen = 0;                 // 分段世代：切換後舊的非同步填充全部作廢
  const segClean = [];            // 本分段的 timers / chart
  const loaders = {};             // 重試按鈕 → 對應 loader
  const slot = (id) => (alive ? view.querySelector('#' + id) : null);
  const ok = (g) => alive && g === segGen;
  const runSegClean = () => { while (segClean.length) { try { segClean.pop()(); } catch {} } };

  // ── 分段解析：params[0]（含別名）> 上次記住 > 大盤 ──
  const p0 = String(params[0] || '');
  const focusMoves = p0 === 'moves';
  let seg = (Object.prototype.hasOwnProperty.call(ALIAS, p0) ? ALIAS[p0] : null) || (isSeg(p0) ? p0 : null) || store.get(SEG_KEY, 'overview');
  if (!isSeg(seg)) seg = 'overview';
  let newsQ = String(store.get(NEWS_KEY, '台股') || '台股');
  let newsSeq = 0;

  // ── shell：sticky 分段列 + 內容 + 唯一免責 ──
  paint(view, `
    <div class="segbar"><div class="seg" role="tablist" aria-label="市場分段">${SEGS.map(([k, l]) => `<button role="tab" data-act="seg" data-seg="${k}" class="${k === seg ? 'on' : ''}" aria-selected="${k === seg}">${l}</button>`).join('')}</div></div>
    <div id="m-body"></div>
    <div class="disclaimer">資料來源 TWSE／TPEx／Yahoo／Google News · 僅供參考，不構成投資建議 · 更新 <span id="m-upd" class="num">${hhmm()}</span></div>`);
  const stamp = () => { const u = slot('m-upd'); if (u) u.textContent = hhmm(); };

  // ═══════════════ 大盤 ═══════════════
  function showOverview() {
    paint(slot('m-body'), `
      <section class="section" id="m-sky" style="margin-top:var(--s-3)">${skyHero(undefined, null)}</section>
      <section class="section" id="m-breadth"><div class="card">${skLines(9)}</div></section>
      <section class="section" id="m-map"><div class="eyebrow">SECTORS</div><div class="h-display">今天，哪些產業較強？</div>${skCards(2)}</section>
      <section class="section" id="m-idx">${sectionHead('📈 台股指數')}${card(skLines(2))}</section>
      <section class="section" id="m-taiex">${sectionHead('加權指數走勢', { sub: '近 3 個月收盤' })}${card(`<div class="eqchart" id="m-taiex-ch">${skLines(3)}</div><div id="m-taiex-meta" class="mt2">${skLines(1)}</div>`)}</section>
      <section class="section" id="m-global">${sectionHead('🌐 國際指標')}${card(skLines(2))}</section>
      <section class="section" id="m-sectors">${sectionHead('🏭 類股表現')}${card(skLines(5))}</section>
      <section class="section" id="m-summary">${sectionHead('📝 每日盤後總結')}${card(skLines(4))}</section>`);
    fillSky(); fillIndex(true); fillTaiex(); fillGlobal(); fillSectors(); fillSummary();
    if (marketOpen()) {   // 盤中每 30 秒刷新指數與類股（分頁隱藏時暫停；market_summary 有 15s TTL，成本很低）
      const t = setInterval(() => { if (document.hidden || !marketOpen()) return; fillSky(); fillIndex(false); fillSectors(); }, 30000);
      segClean.push(() => clearInterval(t));
    }
  }
  // 市場天氣（reference hero）：breadth 與指數各自到達各自重繪；天氣＝現況描述，不是預測
  const sky = { b: undefined, idx: undefined };
  async function fillSky() {
    const g = segGen; if (!slot('m-sky')) return;
    const repaint = () => {
      if (!ok(g) || !slot('m-sky')) return;
      const idx = sky.idx && num(sky.idx.price) !== null ? sky.idx : null;
      paint(slot('m-sky'), skyHero(sky.b, idx));
      const bc = slot('m-breadth'); if (!bc) return;
      if (sky.b) paint(bc, breadthCard(sky.b));
      else if (sky.b === null) paint(bc, card(failNote('市場天氣暫時無法取得', 'sky')));
    };
    API.marketSummary().then(d => { sky.idx = (d && d.tse) || null; }).catch(() => { sky.idx = null; }).finally(repaint);
    try { const b = await API.breadth(); sky.b = (b && b.weather) ? b : null; } catch { sky.b = null; }
    repaint();
  }
  loaders.sky = fillSky;
  async function fillIndex(first) {
    const g = segGen; if (!slot('m-idx')) return;
    try {
      const d = await API.marketSummary(); if (!ok(g) || !slot('m-idx')) return;
      const items = [['tse', '加權指數'], ['otc', '櫃買指數']]
        .filter(([k]) => d && d[k] && num(d[k].price) !== null)
        .map(([k, l]) => { const s = d[k]; return { k: l, cls: cls(s.change_pct), v: `${fmtPrice(s.price)}<div class="sm">${signedPx(s.change)} · ${signPct(s.change_pct)}</div>${s.traded === false ? '<div class="xs dim">試撮／參考值</div>' : ''}` }; });
      const t = d && d.tse && d.tse.time ? String(d.tse.time).slice(0, 5) : '';
      paint(slot('m-idx'), sectionHead('📈 台股指數', { sub: t ? `${t} 更新` : '' }) + (items.length ? tiles(items) : card(emptyState('📡', '指數暫時無法取得'))));
      stamp();
    } catch { if (ok(g) && first) paint(slot('m-idx'), sectionHead('📈 台股指數') + card(failNote('指數暫時無法取得', 'idx'))); }
  }
  loaders.idx = () => fillIndex(true);
  async function fillTaiex() {
    const g = segGen; if (!slot('m-taiex')) return;
    let rows = null;
    try { rows = await get('/api/taiex_history', { ttl: 3600000, timeout: 30000 }); } catch { rows = null; }
    if (!ok(g) || !slot('m-taiex')) return;
    const pts = arr(rows).filter(p => p && p.date && num(p.close) !== null).map(p => ({ date: String(p.date), cum: num(p.close) }));
    if (pts.length < 2) {
      paint(slot('m-taiex-ch'), '');
      paint(slot('m-taiex-meta'), rows === null ? failNote('指數歷史暫時無法取得', 'taiex') : `<div class="note">指數歷史資料不足。</div>`);
      return;
    }
    const first = pts[0].cum, last = pts[pts.length - 1].cum;
    const closes = pts.map(p => p.cum), hi = Math.max(...closes), lo = Math.min(...closes);
    const chg = first ? (last - first) / first * 100 : null;
    paint(slot('m-taiex-meta'), `<div class="row between"><span class="xs dim">${esc(pts[0].date)} → ${esc(pts[pts.length - 1].date)}</span><span class="num sm"><b>${fmtPrice(last)}</b> ${pctPill(chg)}</span></div>
      <div class="xs dim mt1">期間最高 <span class="num">${fmtPrice(hi)}</span> · 最低 <span class="num">${fmtPrice(lo)}</span> · 區間漲跌以第一個收盤為基準</div>`);
    const hasLW = await waitLW(); if (!ok(g)) return;
    const el = slot('m-taiex-ch'); if (!el) return;
    if (!hasLW) { paint(el, `<div class="empty sm">圖表元件載入失敗，數字仍可參考</div>`); return; }
    const inst = mountEquity(el, pts);
    if (inst) segClean.push(() => { try { inst.destroy(); } catch {} });
  }
  loaders.taiex = fillTaiex;
  async function fillGlobal() {
    const g = segGen; if (!slot('m-global')) return;
    try {
      const d = await get('/api/global', { ttl: 60000, timeout: 20000 }); if (!ok(g) || !slot('m-global')) return;
      const items = [];
      const fx = d && d.usd_twd, es = d && d.sp500_futures;
      if (fx && num(fx.price) !== null) items.push({ k: '美元／台幣', cls: cls(fx.change_pct), v: `${num(fx.price).toFixed(3)}<div class="sm">${signedPx(fx.change, 3)} · ${signPct(fx.change_pct)}</div>` });
      if (es && num(es.price) !== null) items.push({ k: 'S&P 500 期貨', cls: cls(es.change_pct), v: `${fmtPrice(es.price)}<div class="sm">${signedPx(es.change, 2)} · ${signPct(es.change_pct)}</div>` });
      paint(slot('m-global'), sectionHead('🌐 國際指標') + (items.length
        ? tiles(items) + `<div class="note mt2">美元／台幣上漲＝台幣走貶，常與外資匯出同向；S&P 期貨反映美股開盤前情緒。</div>`
        : card(`<div class="note">國際指標暫時無資料。</div>`)));
    } catch { if (ok(g)) paint(slot('m-global'), sectionHead('🌐 國際指標') + card(failNote('國際指標暫時無法取得', 'global'))); }
  }
  loaders.global = fillGlobal;
  async function fillSectors() {
    const g = segGen; if (!slot('m-sectors')) return;
    try {
      const d = await API.sectors(); if (!ok(g) || !slot('m-sectors')) return;
      const list = arr(d).filter(s => s && s.code !== 't00' && s.name && num(s.change_pct) !== null)
        .sort((a, b) => num(b.change_pct) - num(a.change_pct));
      if (!list.length) { const mp = slot('m-map'); if (mp) paint(mp, ''); paint(slot('m-sectors'), sectionHead('🏭 類股表現') + card(emptyState('🏭', '類股資料暫時無法取得'))); return; }
      const max = Math.max(...list.map(s => Math.abs(num(s.change_pct))), 0.01);
      const ups = list.filter(s => num(s.change_pct) > 0).length, downs = list.filter(s => num(s.change_pct) < 0).length;
      const mp = slot('m-map'); if (mp) paint(mp, `<div class="eyebrow">SECTORS</div><div class="h-display">今天，哪些產業較強？</div>${sectorMap(list, { limit: 6 })}<div class="xs dim mt2">顯示最強 3 與最弱 3 個類股，完整列表見下方「類股表現」。</div>`);
      const rows = list.map(s => `<div class="li"><div class="grow"><div class="row between"><span class="b">${sectorIcon(s.name)} ${esc(s.name)}</span>${pctPill(s.change_pct)}</div><div class="mbar mt1"><i class="${cls(s.change_pct)}" style="width:${(Math.abs(num(s.change_pct)) / max * 100).toFixed(1)}%"></i></div></div></div>`);
      paint(slot('m-sectors'), sectionHead('🏭 類股表現', { sub: `${ups} 漲 · ${downs} 跌 · 依漲幅排序` }) + card(`<div class="list">${rows.join('')}</div>`));
    } catch { if (ok(g)) { const mp = slot('m-map'); if (mp) paint(mp, ''); paint(slot('m-sectors'), sectionHead('🏭 類股表現') + card(failNote('類股資料暫時無法取得', 'sectors'))); } }
  }
  loaders.sectors = fillSectors;
  async function fillSummary() {
    const g = segGen; if (!slot('m-summary')) return;
    try {
      const d = await get('/api/daily_summary', { ttl: 600000, timeout: 30000 }); if (!ok(g) || !slot('m-summary')) return;
      const paras = (d && !isErr(d)) ? arr(d.paragraphs).filter(p => p && (p.title || p.text)) : [];
      if (!paras.length) { paint(slot('m-summary'), sectionHead('📝 每日盤後總結') + card(`<div class="note">今日盤後總結尚未產生（通常收盤後約一小時更新）。</div>`)); return; }
      const inst = d.institutional || {};
      const instLine = ['foreign', 'trust', 'total'].some(k => num(inst[k]) !== null)
        ? `<div class="hairline"></div><div class="xs dim">三大法人　外資 ${signedInt(inst.foreign)} · 投信 ${signedInt(inst.trust)} · 合計 ${signedInt(inst.total)} 張</div>` : '';
      paint(slot('m-summary'), sectionHead('📝 每日盤後總結', { sub: d.date ? `${esc(d.date)} 盤後` : '' }) + card(
        `<div class="chips">${d.outlook ? judge(d.outlook, outlookKind(d.outlook), d.outlook_icon || '') : ''}<span class="xs dim">由系統依收盤數據與法人籌碼自動整理（非 AI 生成）</span></div>`
        + paras.map(p => `<div class="mt3">${p.title ? `<div class="sm b">${esc(p.title)}</div>` : ''}<div class="why">${esc(p.text || '')}</div></div>`).join('')
        + instLine));
      stamp();
    } catch { if (ok(g)) paint(slot('m-summary'), sectionHead('🤖 AI 每日盤後總結') + card(failNote('盤後總結暫時無法取得', 'summary'))); }
  }
  loaders.summary = fillSummary;

  // ═══════════════ 法人 ═══════════════
  function showInst() {
    paint(slot('m-body'), `
      <section class="section" id="m-inst">${sectionHead('🏦 三大法人買賣超')}${card(skLines(6))}</section>
      <section class="section" id="m-margin">${sectionHead('💳 融資融券')}${card(skLines(4))}</section>
      <section class="section" id="m-hot">${sectionHead('🔥 外資／投信買超排行')}${card(skLines(4))}</section>`);
    fillInst(); fillMargin(); fillHot();
  }
  async function fillInst() {
    const g = segGen; if (!slot('m-inst')) return;
    try {
      const d = await get('/api/institutional', { ttl: 1800000, timeout: 40000 }); if (!ok(g) || !slot('m-inst')) return;
      const valid = (x) => x && x.code && num(x.total_net) !== null;
      const buy = (d && !isErr(d)) ? arr(d.top_buy).filter(valid) : [], sell = (d && !isErr(d)) ? arr(d.top_sell).filter(valid) : [];
      const head = sectionHead('🏦 三大法人買賣超', { sub: d && d.date ? `${esc(d.date)} · 單位 張` : '' });
      if (!buy.length && !sell.length) {   // 後端上游失敗時會回 {date:'', top_buy:[]}（不是真的沒資料）→ 當成暫時無法取得，可重試
        invalidate('/api/institutional');
        paint(slot('m-inst'), sectionHead('🏦 三大法人買賣超') + card(failNote(d && d.date ? `${esc(d.date)} 沒有法人買賣超資料` : '法人資料暫時無法取得（證交所尚未公布或連線失敗）', 'inst'))); return; }
      const max = Math.max(...[...buy, ...sell].map(x => Math.abs(num(x.total_net))), 1);
      // 後端單位是「股」→ 除以 1000 成「張」；長條依合計買賣超絕對值等比例，買超紅／賣超綠
      const row = (s, i) => { const n = num(s.total_net); return barRow(s, { rank: i + 1, pct: Math.abs(n) / max * 100, dir: cls(n),
        right: `<div class="b">${signedInt(n / 1000)}</div><div class="xs dim">張</div>`,
        sub: `外資 ${signedInt(num(s.foreign_net) / 1000)} · 投信 ${signedInt(num(s.trust_net) / 1000)} · 自營 ${signedInt(num(s.dealer_net) / 1000)}` }); };
      paint(slot('m-inst'), head + card(
        paneTabs('inst', [['buy', `買超 TOP ${buy.length}`], ['sell', `賣超 TOP ${sell.length}`]], 'buy')
        + pane('inst', 'buy', 'buy', listOr(buy.map(row), emptyState('🏦', '今天沒有買超資料')))
        + pane('inst', 'sell', 'buy', listOr(sell.map(row), emptyState('🏦', '今天沒有賣超資料')))
        + `<div class="note mt2">合計＝外資＋投信＋自營商；法人連續同向通常比單日更有意義，可點進個股看籌碼頁。</div>`));
      stamp();
    } catch { if (ok(g)) paint(slot('m-inst'), sectionHead('🏦 三大法人買賣超') + card(failNote('法人資料暫時無法取得', 'inst'))); }
  }
  loaders.inst = fillInst;
  async function fillMargin() {
    const g = segGen; if (!slot('m-margin')) return;
    try {
      const d = await get('/api/margin', { ttl: 1800000, timeout: 40000 }); if (!ok(g) || !slot('m-margin')) return;
      const s = (d && !isErr(d) && d.summary) || {};
      // summary 值是帶千分位的字串；margin_balance/short_balance = 前日餘額，*_today = 今日餘額（張）
      const mT = cleanNum(s.margin_today), mP = cleanNum(s.margin_balance), sT = cleanNum(s.short_today), sP = cleanNum(s.short_balance);
      const inc = arr(d && d.stocks_increase).filter(x => x && x.code), dec = arr(d && d.stocks_decrease).filter(x => x && x.code);   // 'stocks' 是永遠為空的死鍵，不用
      const head = sectionHead('💳 融資融券', { sub: d && d.date ? `${rocDate(d.date)} · 單位 張` : '' });
      if (mT === null && !inc.length && !dec.length) { paint(slot('m-margin'), head + card(emptyState('💳', '近 7 個交易日沒有融資券資料'))); return; }
      const mC = (mT !== null && mP !== null) ? mT - mP : null, sC = (sT !== null && sP !== null) ? sT - sP : null;
      const sum = mT === null ? '' : tiles([
        { k: '融資餘額', v: `${fmtLots(mT)}<div class="xs dim">前日 ${fmtLots(mP)}</div>` },
        { k: '融資增減', v: signedInt(mC), cls: '' },
        { k: '融券餘額', v: `${fmtLots(sT)}<div class="xs dim">前日 ${fmtLots(sP)}</div>` },
        { k: '融券增減', v: signedInt(sC), cls: '' },
      ]) + `<div class="note mt2">融資增加＝散戶借錢加碼，籌碼偏散戶；融券增加＝放空累積，股價續漲時有回補壓力。這是慣例解讀，不是預測。</div>`;
      const row = (x, i) => stockRow(x, { rank: i + 1,
        right: `<div class="b">${signedInt(x.margin_change)} <span class="xs dim">張</span></div><div class="xs dim">融券 ${signedInt(x.short_change)}</div>`,
        sub: `融資餘額 <span class="num">${fmtInt(x.margin_balance)}</span> 張 · 融券餘額 <span class="num">${fmtInt(x.short_balance)}</span> 張` });
      paint(slot('m-margin'), head + card(sum + (inc.length || dec.length
        ? (sum ? '<div class="hairline"></div>' : '') + paneTabs('margin', [['inc', '融資增加最多'], ['dec', '融資減少最多']], 'inc')
          + pane('margin', 'inc', 'inc', listOr(inc.map(row), emptyState('💳', '暫無資料')))
          + pane('margin', 'dec', 'inc', listOr(dec.map(row), emptyState('💳', '暫無資料')))
        : '')));
      stamp();
    } catch { if (ok(g)) paint(slot('m-margin'), sectionHead('💳 融資融券') + card(failNote('融資券資料暫時無法取得', 'margin'))); }
  }
  loaders.margin = fillMargin;
  async function fillHot() {
    const g = segGen; if (!slot('m-hot')) return;
    try {
      const d = await get('/api/hot_stocks', { ttl: 1800000, timeout: 40000 }); if (!ok(g) || !slot('m-hot')) return;
      const valid = (x) => x && x.code && num(x.lots) !== null;
      const fr = (d && !isErr(d)) ? arr(d.foreign).filter(valid) : [], tr = (d && !isErr(d)) ? arr(d.trust).filter(valid) : [];
      const head = sectionHead('🔥 外資／投信買超排行', { sub: '最近可取得的交易日 · 單位 張 · 不含 ETF' });
      if (!fr.length && !tr.length) { paint(slot('m-hot'), head + card(emptyState('🔥', '暫無買超排行資料'))); return; }
      const row = (x, i) => stockRow(x, { rank: i + 1,
        right: `<div class="b">${signedInt(x.lots)} <span class="xs dim">張</span></div>`,
        sub: `外資 ${signedInt(x.foreign_lots)} · 投信 ${signedInt(x.trust_lots)} · 合計 ${signedInt(x.total_lots)}` });
      paint(slot('m-hot'), head + card(
        paneTabs('hot', [['fr', '外資買超'], ['tr', '投信買超']], 'fr')
        + pane('hot', 'fr', 'fr', listOr(fr.map(row), emptyState('🔥', '外資今天沒有買超個股')))
        + pane('hot', 'tr', 'fr', listOr(tr.map(row), emptyState('🔥', '投信今天沒有買超個股')))));
    } catch { if (ok(g)) paint(slot('m-hot'), sectionHead('🔥 外資／投信買超排行') + card(failNote('買超排行暫時無法取得', 'hot'))); }
  }
  loaders.hot = fillHot;

  // ═══════════════ 排行 ═══════════════
  const intraHead = (t, n = 0) => `<div class="stitle"><h2>⚡ 盤中異動 <span class="sub"><span class="live" aria-hidden="true"></span> LIVE${t ? ` ${esc(t)}` : ''} · ±5%</span></h2>${n ? `<span class="sub">${n} 檔</span>` : ''}</div>`;
  function showRank() {
    const open = marketOpen();
    paint(slot('m-body'), `
      ${open || focusMoves ? `<section class="section" id="m-intra">${intraHead('')}${card(skLines(4))}</section>` : ''}
      <section class="section" id="m-movers">${sectionHead('🏅 漲跌幅排行')}${card(skLines(6))}</section>
      <section class="section" id="m-vol">${sectionHead('📊 成交量排行')}${card(skLines(6))}</section>`);
    if (open) {
      fillIntra(true);
      const t = setInterval(() => { if (document.hidden) return; if (!marketOpen()) { clearInterval(t); closeIntra(); return; } fillIntra(false); }, 60000);
      segClean.push(() => clearInterval(t));
    } else if (focusMoves) closeIntra();
    fillMovers(); fillVol();
    if (focusMoves) setTimeout(() => { const el = slot('m-intra'); if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 80);
  }
  function closeIntra() {
    const el = slot('m-intra'); if (!el) return;
    paint(el, sectionHead('⚡ 盤中異動') + card(`<div class="note">已收盤。盤中異動只在交易時段（週一至五 09:00–13:30）每 60 秒更新；收盤後請看下方漲跌幅排行。</div>`));
  }
  async function fillIntra(first) {
    const g = segGen; if (!slot('m-intra')) return;
    try {
      const d = await API.intraday(); if (!ok(g) || !slot('m-intra')) return;
      if (d && d.market_open === false) { closeIntra(); return; }   // 伺服器說休市（例如國定假日）
      const list = arr(d && d.alerts).filter(x => x && x.code);
      const rows = list.map(x => stockRow(x, { sub: typeChip(x) }));
      paint(slot('m-intra'), intraHead(d && d.tw_time, list.length) + card(listOr(rows, emptyState('😴', '目前沒有 ±5% 以上的急拉／急殺或漲跌停'))));
      stamp();
    } catch { if (ok(g) && first) paint(slot('m-intra'), intraHead('') + card(`<div class="note">盤中異動暫時無法取得，60 秒後自動重試。</div>`)); }
  }
  async function fillMovers() {
    const g = segGen; if (!slot('m-movers')) return;
    try {
      const d = await get('/api/top_movers', { ttl: 30000, timeout: 20000 }); if (!ok(g) || !slot('m-movers')) return;
      const valid = (x) => x && x.code && num(x.price) !== null;
      const gain = (d && !isErr(d)) ? arr(d.gainers).filter(valid) : [], lose = (d && !isErr(d)) ? arr(d.losers).filter(valid) : [];
      const head = sectionHead('🏅 漲跌幅排行', { sub: '取樣 60 檔熱門股（上市＋上櫃）' });
      if (!gain.length && !lose.length) { paint(slot('m-movers'), head + card(emptyState('🏅', '暫無漲跌幅資料（盤前或休市）'))); return; }
      const row = (s, i) => stockRow(s, { rank: i + 1, sub: s.traded === false ? '試撮參考價' : '' });
      paint(slot('m-movers'), head + card(
        paneTabs('movers', [['g', '漲幅'], ['l', '跌幅']], 'g')
        + pane('movers', 'g', 'g', listOr(gain.map(row), emptyState('🏅', '樣本內今天沒有上漲的股票')))
        + pane('movers', 'l', 'g', listOr(lose.map(row), emptyState('🏅', '樣本內今天沒有下跌的股票')))));
      stamp();
    } catch { if (ok(g)) paint(slot('m-movers'), sectionHead('🏅 漲跌幅排行') + card(failNote('漲跌幅排行暫時無法取得', 'movers'))); }
  }
  loaders.movers = fillMovers;
  async function fillVol() {
    const g = segGen; if (!slot('m-vol')) return;
    try {
      const d = await get('/api/volume_rank', { ttl: 60000, timeout: 20000 }); if (!ok(g) || !slot('m-vol')) return;
      const list = arr(d).filter(s => s && s.code && cleanNum(s.volume) !== null);   // realtime volume 是字串（張）
      const head = sectionHead('📊 成交量排行', { sub: '取樣 60 檔熱門股 · 單位 張' });
      if (!list.length) { paint(slot('m-vol'), head + card(emptyState('📊', '暫無成交量資料'))); return; }
      const max = Math.max(...list.map(s => cleanNum(s.volume)), 1);
      const rows = list.map((s, i) => { const v = cleanNum(s.volume); return barRow(s, { rank: i + 1, pct: v / max * 100, dir: cls(s.change_pct),
        right: `<div class="num b">${fmtInt(v)}張</div>`,
        sub: `<span class="num ${cls(s.change_pct)}">${fmtPrice(s.price)} ${signPct(s.change_pct)}</span>${s.traded === false ? ' · 試撮參考價' : ''}` }); });
      paint(slot('m-vol'), head + card(`<div class="list">${rows.join('')}</div><div class="note mt2">量能長條依成交張數等比例；顏色＝當日漲跌方向。</div>`));
    } catch { if (ok(g)) paint(slot('m-vol'), sectionHead('📊 成交量排行') + card(failNote('成交量排行暫時無法取得', 'vol'))); }
  }
  loaders.vol = fillVol;

  // ═══════════════ 新聞 ═══════════════
  function showNews() {
    paint(slot('m-body'), `
      <section class="section" id="m-news">${sectionHead('📰 台股新聞')}
        <div class="subtabs" id="m-news-tabs" role="group" aria-label="新聞關鍵字">${NEWS_KW.map(([l, q]) => `<button data-act="news-kw" data-q="${esc(q)}" class="${q === newsQ ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="searchbar"><input id="m-news-q" class="input" placeholder="搜尋關鍵字或股票代碼" inputmode="search" enterkeyhint="search" autocomplete="off" aria-label="搜尋新聞"><button class="btn" data-act="news-search">搜尋</button></div>
        <div id="m-news-list" class="mt3">${card(skLines(5))}</div></section>
      <section class="section" id="m-ann">${sectionHead('📢 證交所公告')}${card(skLines(3))}</section>
      <section class="section" id="m-gooaye">${sectionHead('🎙 股癌觀點')}${card(skLines(4))}</section>`);
    fillNews(newsQ); fillAnn(); fillGooaye();
  }
  async function fillNews(q) {
    q = String(q || '').trim() || '台股';
    newsQ = q; store.set(NEWS_KEY, q);
    const g = segGen, seq = ++newsSeq;   // 序號守門：慢的舊請求不能蓋掉新的
    view.querySelectorAll('#m-news-tabs button').forEach(b => { const on = b.dataset.q === q; b.classList.toggle('on', on); });
    const el = slot('m-news-list'); if (!el) return;
    paint(el, card(skLines(5)));
    let list = null;
    try { const d = await get('/api/news?q=' + encodeURIComponent(q), { ttl: 300000, timeout: 20000 }); list = isErr(d) ? [] : arr(d).filter(n => n && n.title); }
    catch { list = null; }
    if (!ok(g) || seq !== newsSeq || !slot('m-news-list')) return;
    if (list === null) { paint(slot('m-news-list'), card(failNote('新聞暫時無法取得', 'news'))); return; }
    if (!list.length) { paint(slot('m-news-list'), card(emptyState('📰', `找不到「${esc(q)}」的相關新聞，換個關鍵字試試`))); return; }
    const rows = list.map(n => `<a class="li" href="${safeUrl(n.link)}" target="_blank" rel="noopener"><div class="grow"><div class="sm b">${esc(n.title)}</div><div class="xs dim mt1">${esc(n.source || '')}${n.date ? ` · ${esc(timeAgo(n.date))}` : ''}</div></div><span class="dim">↗</span></a>`);
    paint(slot('m-news-list'), card(`<div class="xs dim mb2">「${esc(q)}」 · ${list.length} 則 · 更新 <span class="num">${hhmm()}</span></div><div class="list">${rows.join('')}</div>`));
    stamp();
  }
  loaders.news = () => fillNews(newsQ);
  function doSearch() {
    const inp = slot('m-news-q'); const q = inp ? inp.value.trim() : '';
    if (!q) { toast('請輸入關鍵字'); return; }
    if (inp) inp.blur();
    fillNews(q);
  }
  async function fillAnn() {
    const g = segGen; if (!slot('m-ann')) return;
    try {
      const d = await get('/api/announcements', { ttl: 600000, timeout: 20000 }); if (!ok(g) || !slot('m-ann')) return;
      const list = arr(d).filter(x => x && x.title);
      if (!list.length) { paint(slot('m-ann'), sectionHead('📢 證交所公告') + card(`<div class="note">今天沒有新公告。</div>`)); return; }
      const rows = list.map((x, i) => `<div class="li"${i >= ANN_FOLD ? ' data-more="ann" hidden' : ''}><div class="grow"><div class="sm">${esc(x.title)}</div>${x.date ? `<div class="xs dim mt1">${esc(x.date)}</div>` : ''}</div></div>`);
      paint(slot('m-ann'), sectionHead('📢 證交所公告', { sub: `${list.length} 則` }) + card(`<div class="list">${rows.join('')}</div>${list.length > ANN_FOLD ? `<button class="btn sm block mt2" data-act="more" data-target="ann">顯示全部 ${list.length} 則</button>` : ''}`));
    } catch { if (ok(g)) paint(slot('m-ann'), sectionHead('📢 證交所公告') + card(failNote('公告暫時無法取得', 'ann'))); }
  }
  loaders.ann = fillAnn;
  async function fillGooaye() {
    const g = segGen; if (!slot('m-gooaye')) return;
    try {
      const d = await get('/api/gooaye', { ttl: 90000, timeout: 30000 }); if (!ok(g) || !slot('m-gooaye')) return;
      const groups = (d && !isErr(d)) ? arr(d.groups).filter(x => x && (x.label || arr(x.tw).length || arr(x.us).length)) : [];
      const head = sectionHead('🎙 股癌觀點', { sub: 'Podcast 產業重點整理' });
      if (!groups.length) { paint(slot('m-gooaye'), head + card(emptyState('🎙', '目前沒有股癌重點摘要<div class="xs mt1">資料來源尚未設定或本週尚未更新</div>'))); return; }
      const live = (d.live && typeof d.live === 'object') ? d.live : {};
      const sig = new Set(arr(d.signals).map(String));
      const quote = (q) => (q && num(q.price) !== null) ? ` <span class="num ${cls(q.change_pct)}">${fmtPrice(q.price)} ${signPct(q.change_pct)}</span>` : '';
      // 標籤字串如「台積電 2330」/「NVIDIA NVDA」：抽代碼對應 live 報價；台股 chip 連到個股頁
      const twChip = (s) => { const m = String(s).match(/(\d{4,6})/); const k = m ? m[1] : null; const q = k ? live[k] : null;
        return k ? `<a class="chip info" href="${stockHref(k)}">${esc(trunc(s))}${quote(q)}${sig.has(k) ? ' 📊' : ''}</a>` : chip(esc(trunc(s))); };
      const usChip = (s) => { const t = String(s).match(/[A-Za-z]{2,6}/g); const k = t ? t[t.length - 1].toUpperCase() : null; return chip(`${esc(trunc(s))}${quote(k ? live[k] : null)}`, 'gold'); };
      const grp = (x) => `<div>
        <div class="row"><span>${esc(x.icon || '')}</span><span class="b">${esc(x.label || '')}</span></div>
        ${arr(x.tw).length ? `<div class="mt2"><div class="xs dim mb2">台股</div><div class="chips">${arr(x.tw).map(twChip).join('')}</div></div>` : ''}
        ${arr(x.us).length ? `<div class="mt2"><div class="xs dim mb2">美股</div><div class="chips">${arr(x.us).map(usChip).join('')}</div></div>` : ''}
        ${x.source ? `<div class="note mt2">來源：${esc(x.source)}</div>` : ''}</div>`;
      const lv = Object.values(live), ups = lv.filter(q => num(q && q.change_pct) > 0).length, downs = lv.filter(q => num(q && q.change_pct) < 0).length;
      const metas = [d.updated && `最新 ${d.updated}`, d.coverage, d.period].filter(Boolean);
      paint(slot('m-gooaye'), head + card(
        `${d.title ? `<div class="lg b">${esc(d.title)}</div>` : ''}${d.subtitle ? `<div class="sm dim mt1">${esc(d.subtitle)}</div>` : ''}`
        + (metas.length ? `<div class="chips mt2">${metas.map(m => chip(esc(m))).join('')}</div>` : '')
        + (lv.length ? `<div class="xs dim mt2">即時報價 <span class="num up">${ups} 漲</span> · <span class="num down">${downs} 跌</span>${sig.size ? ` · 📊 ${sig.size} 檔今天同時命中 app 技術進場訊號` : ''}</div>` : '')
        + '<div class="hairline"></div>' + groups.map(grp).join('<div class="hairline"></div>')
        + `<div class="note mt3">📊＝今天 app 的技術進場掃描也命中；點台股標籤看完整分析。摘要為節目觀點整理，不是本站推薦。</div>`));
      stamp();
    } catch { if (ok(g)) paint(slot('m-gooaye'), sectionHead('🎙 股癌觀點') + card(failNote('股癌摘要暫時無法取得', 'gooaye'))); }
  }
  loaders.gooaye = fillGooaye;

  // ── 分段切換：記住、同步 hash（replaceState 不觸發重新 render）、清掉舊分段的 timer / chart ──
  const SHOW = { overview: showOverview, inst: showInst, rank: showRank, news: showNews };
  function switchSeg(k, { push = false } = {}) {
    if (!isSeg(k)) k = 'overview';
    seg = k; segGen++; store.set(SEG_KEY, k); runSegClean();
    view.querySelectorAll('[data-act="seg"]').forEach(b => { const on = b.dataset.seg === k; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    if (push) { try { history.replaceState(null, '', '#/market/' + k); } catch {} window.scrollTo({ top: 0 }); }
    SHOW[k]();
  }

  // ── events（委派） ──
  function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b || !view.contains(b)) return;
    const act = b.dataset.act;
    if (act === 'seg') { if (b.dataset.seg !== seg) switchSeg(b.dataset.seg, { push: true }); }
    else if (act === 'pane') {
      const box = b.closest('[data-panes]'); if (!box) return;
      const id = box.dataset.panes, k = b.dataset.pane;
      box.querySelectorAll('button').forEach(x => { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on); });
      view.querySelectorAll(`[data-pane-of="${id}"]`).forEach(p => { p.hidden = p.dataset.pane !== k; });
    }
    else if (act === 'retry') { const fn = loaders[b.dataset.load]; if (fn) fn(); }
    else if (act === 'news-kw') fillNews(b.dataset.q);
    else if (act === 'news-search') doSearch();
    else if (act === 'more') { view.querySelectorAll(`[data-more="${b.dataset.target}"]`).forEach(x => { x.hidden = false; }); b.remove(); }
  }
  function onKey(e) { if (e.key === 'Enter' && e.target && e.target.id === 'm-news-q') { e.preventDefault(); doSearch(); } }
  // 回到前景：盤中的 live 卡立刻補一次，不用等下個 tick
  function onVis() {
    if (document.hidden || !marketOpen()) return;
    if (seg === 'rank') fillIntra(false);
    if (seg === 'overview') fillIndex(false);
  }
  view.addEventListener('click', onClick);
  view.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVis);

  switchSeg(seg);   // 首次 paint（不改 hash，不捲動；app.js 會還原捲動位置）

  return () => {
    alive = false; segGen++; runSegClean();
    view.removeEventListener('click', onClick);
    view.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
  };
}
