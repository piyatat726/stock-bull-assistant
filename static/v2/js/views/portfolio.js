// 台股小牛 v2 — 持股：持股 | 關注 | 提醒（分段記在 'pf_seg'，hash 第 2 段 #/portfolio/<seg> 可覆寫）。
// 持股 = components.holdings（localStorage，經 syncPortfolio 鏡射雲端；本檔不直接碰 portfolio_get/sync）。
// 關注 = 本機清單 'wl_v2'（伺服器 /api/watchlist 在 Vercel 上是暫存檔、會重置，故不採用）。
// 提醒 = /api/alerts_list（伺服器快取 8 秒 → 新增／刪除一律先樂觀更新，逾時再對帳）。
// 頁面唯一主要動作 = 頂部 .cta（依分段變成 加入持股／加入關注／新增提醒），三者共用同一個選股 sheet。
// 每張卡片各自 fetch、各自 skeleton；所有非同步回填都以 (alive, gen) 守門，切分段或離開後一律略過。
import { render as paint, esc, num, cls, signPct, fmtPrice, fmtInt, skCards, skLines, openSheet, closeSheet, toast, store, marketOpen, twNow } from '../ui.js';
import { API, get, invalidate } from '../api.js';
import { holdingCard, alertRow, tiles, emptyState, judge, chip, stockHref, mkTag, priceBox, holdings, addHolding, removeHolding, setHolding, syncPortfolio, openAlertSheet } from '../components.js';

// ── constants ──
const SEGS = [['holdings', '💼 持股'], ['watch', '👀 關注'], ['alerts', '🔔 提醒']];
const SEG_LABEL = Object.fromEntries(SEGS);
const SEG_ALIAS = { holdings: 'holdings', hold: 'holdings', '持股': 'holdings', watch: 'watch', watchlist: 'watch', '關注': 'watch', alerts: 'alerts', alert: 'alerts', '提醒': 'alerts' };
const CTA = { holdings: ['＋ 加入持股', 'pick-hold'], watch: ['＋ 加入關注', 'pick-watch'], alerts: ['＋ 新增提醒', 'pick-alert'] };
const HOT = [['2330', '台積電'], ['2317', '鴻海'], ['2454', '聯發科'], ['2382', '廣達'], ['0050', '元大台灣50'], ['00878', '國泰永續高股息']];
const WL_KEY = 'wl_v2';
const WL_SEED = ['2330', '2317', '2454', '2382'];
const SIG_BATCH = 20;          // /api/portfolio_signals 一次最多 20 檔
const PENDING_TTL = 20000;     // 樂觀更新保留時間（伺服器快取 8 秒 + 餘裕）
const RECON_MS = 9500;         // 新增提醒後多久回頭對帳

// ── module-level state (survives segment switches and re-renders) ──
// alerts_list 伺服器快取 8 秒：剛新增／刪除的提醒先記在這裡，畫清單時合併，對帳後自然失效。
const pendingAlerts = { adds: [], dels: new Map() };   // adds: [{id,code,name,target,direction,pending,t}], dels: id → t
let alertCount = null;                                  // 最近一次取得的提醒數（分段標籤用）
let undoT = null;
let listP = null;                                       // /api/stock_list 的 promise（選股 sheet 本機過濾用）

// ── private helpers ──
const hhmm = (d = twNow()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const cleanNum = (v) => num(String(v ?? '').replace(/,/g, ''));   // '1,020' 不能被當成 1
const card = (inner, k = '') => `<div class="card${k ? ' ' + k : ''}">${inner}</div>`;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const hasCloud = () => { try { return !!localStorage.getItem('portfolioStocks'); } catch { return false; } };
const cloudHint = () => `<div class="hint">${hasCloud() ? '☁️ 持股會同步到雲端；盤後健診推播需先在「更多 › 設定」連結 LINE' : '☁️ 加一檔即同步雲端；LINE 推播需在「更多 › 設定」連結'}</div>`;
/** traded===false 的報價是委買委賣中價：盤前／盤中叫「試撮」，其餘時段其實是「昨收」 */
function estLabel() {
  const t = twNow(); const m = t.getHours() * 60 + t.getMinutes(); const wd = t.getDay();
  return wd >= 1 && wd <= 5 && m >= 8 * 60 + 30 && m <= 13 * 60 + 30 ? '試撮' : '昨收';
}
/** /api/search 回 realtime dict 陣列（可能 []，也可能 200 帶 {error}）→ 代碼完全相符者優先，否則第一筆 */
async function lookup(q) {
  const r = await API.search(q);
  const list = Array.isArray(r) ? r.filter(x => x && x.code) : [];
  if (!list.length) return null;
  const ql = q.toUpperCase();
  return list.find(x => String(x.code).toUpperCase() === ql) || list[0];
}
/** 全市場名單（~11K 筆）：一小時內只抓一次；失敗回 [] 並允許下次重試 */
function stockList() {
  if (!listP) listP = get('/api/stock_list', { ttl: 3600000, timeout: 30000 })
    .then(l => (Array.isArray(l) ? l.filter(s => s && s.code) : []))
    .catch(() => { listP = null; return []; });
  return listP;
}
function filterList(list, q) {
  const ql = q.toUpperCase();
  return list.filter(s => String(s.code).toUpperCase().startsWith(ql) || String(s.name || '').includes(q)).slice(0, 12);
}
/** 分段內的快速加入列（Enter 與按鈕都走 submit，由 view 層委派）。按鈕不用 primary：每頁只有頂部 .cta 一個薰衣草主動作 */
function addBar(id, form, placeholder, mode = 'search') {
  return `<form class="searchbar" data-form="${form}"><input id="${id}" class="input" placeholder="${esc(placeholder)}" inputmode="${mode}" enterkeyhint="done" autocomplete="off" autocapitalize="characters" aria-label="${esc(placeholder)}"><button type="submit" class="btn">加入</button></form>`;
}
/** ui.toast 只吃純文字；移除需要「復原」按鈕 → 共用同一個 #toast 節點自己畫 */
function undoToast(msg, onUndo, ms = 4000) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.innerHTML = `<span class="row"><span>${esc(msg)}</span><button class="btn sm" data-undo>復原</button></span>`;
  el.className = 'toast show';
  el.querySelector('[data-undo]').onclick = () => { clearTimeout(undoT); el.classList.remove('show'); onUndo(); };
  clearTimeout(undoT); undoT = setTimeout(() => el.classList.remove('show'), ms);
}
// 本機關注清單：null = 從未建立（要種子），[] = 使用者清空（不重種）
const wl = {
  get() { const v = store.get(WL_KEY, null); return Array.isArray(v) ? v.filter(x => x && x.code).map(x => ({ ...x, code: String(x.code) })) : null; },
  set(list) { store.set(WL_KEY, list); },
};
/** 首次使用種 4 檔：先存代碼（離線也能用），名稱用一次 realtime 補齊，補不到的再逐檔 search */
async function ensureWatchlist() {
  const cur = wl.get(); if (cur) return cur;
  const seed = WL_SEED.map(code => ({ code, name: '', market: 'tse' }));
  wl.set(seed);
  try {
    const q = await API.realtime(WL_SEED, WL_SEED.map(() => 'tse'));
    for (const r of (Array.isArray(q) ? q : [])) { const s = seed.find(x => x.code === String(r && r.code)); if (s && r.name) { s.name = r.name; if (r.market) s.market = r.market; } }
  } catch { /* 下面逐檔補 */ }
  for (const s of seed) if (!s.name) { try { const r = await lookup(s.code); if (r) { s.name = r.name || ''; s.market = r.market || s.market; } } catch { /* 留空，之後報價會補 */ } }
  wl.set(seed); return seed;
}
/** 關注列：名稱＋報價整塊連到個股頁；✕ 是真正的 44px button（不塞進 <a> 裡） */
function watchRow(s, q) {
  const r = q ? { ...s, ...q, name: (q.name || s.name || s.code) } : { ...s, name: s.name || s.code };
  const sub = q && q.traded === false ? `<div class="mt1">${chip(estLabel())}</div>` : '';
  const px = q ? priceBox(r) : `<div class="sk sk-line" style="width:64px">.</div>`;
  return `<div class="li"><a class="row grow" href="${stockHref(r.code)}"><div class="grow"><div class="ident"><span class="name">${esc(r.name)}</span><span class="code">${esc(r.code)}${r.market ? ' · ' + mkTag(r.market) : ''}</span></div>${sub}</div>${px}</a><button class="btn" data-act="wl-del" data-code="${esc(r.code)}" aria-label="移除關注 ${esc(r.name)}">✕</button></div>`;
}
/** 剛新增、伺服器清單還沒跟上的提醒列：不可刪，標「同步中」 */
function pendingRow(a) {
  const up = a.direction === 'up';
  return `<div class="li"><div class="grow"><div class="ident"><span class="name"><a href="${stockHref(a.code)}">${esc(a.name || a.code)}</a></span><span class="code">${esc(a.code)}</span></div><div class="xs dim mt1">${up ? '漲到 ≥' : '跌到 ≤'} <b class="num ${up ? 'up' : 'down'}">${fmtPrice(a.target)}</b> · ${chip('同步中…')}</div></div><button class="btn sm" disabled aria-label="同步中">…</button></div>`;
}
function queueAlertAdd(row) {
  if (pendingAlerts.adds.some(p => p.code === row.code && num(p.target) === num(row.target))) return;
  pendingAlerts.adds.push(row);
}
/** 選股 sheet 的一列：<button class="li"> 在 .list（flex column）裡自動撐滿寬度 */
function pickRow(s, added = false) {
  return `<button type="button" class="li${added ? ' dim' : ''}" data-pick="${esc(s.code)}" data-name="${esc(s.name || '')}" data-market="${esc(s.market || '')}"${added ? ' disabled aria-disabled="true"' : ''}><div class="grow"><div class="ident"><span class="name">${esc(s.name || s.code)}</span><span class="code">${esc(s.code)}${s.market ? ' · ' + mkTag(s.market) : ''}</span></div></div>${added ? chip('已加入') : '<span class="dim lg">＋</span>'}</button>`;
}
/** 選股 sheet（components.openSearchSheet 的「選取」版）：本機過濾 /api/stock_list，選到就呼叫 onPick(code,name,market)，不導頁。
 *  事件只掛在本次新建的節點上（#sheet 是共用元素，掛在它身上會累積舊 listener、重複觸發）。 */
function openPickSheet({ title, hint = '', placeholder = '輸入代碼或名稱，例如 2330 / 台積電', has = () => false, onPick }) {
  const hot = () => `<div class="xs dim mb2">熱門</div>${HOT.map(([code, name]) => pickRow({ code, name, market: 'tse' }, has(code))).join('')}`;
  const sh = openSheet(`<div class="stitle"><h2>${esc(title)}</h2></div>${hint ? `<div class="sm dim mb3">${hint}</div>` : ''}
    <form class="searchbar" data-pform><input id="pk-q" class="input" placeholder="${esc(placeholder)}" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="characters" aria-label="${esc(placeholder)}"><button type="submit" class="btn">選取</button></form>
    <div id="pk-res" class="list mt3">${hot()}</div><div id="pk-msg" class="note mt2"></div>`);
  const inp = sh.querySelector('#pk-q'), res = sh.querySelector('#pk-res'), msg = sh.querySelector('#pk-msg'), form = sh.querySelector('[data-pform]');
  let t = null, busy = false;
  const pick = async (s) => {
    const code = String(s.code || '').trim().toUpperCase(); if (!code || busy) return;
    if (has(code)) { msg.textContent = '已在清單中'; return; }
    busy = true; closeSheet();
    try { await onPick(code, s.name || '', s.market || 'tse'); } catch { toast('加入失敗，請稍後再試', 'err'); }
  };
  inp.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = inp.value.trim();
      if (!q) { res.innerHTML = hot(); return; }
      const m = filterList(await stockList(), q);
      if (inp.value.trim() !== q) return;                                  // 使用者又打了字，這批結果已過期
      res.innerHTML = m.length ? m.map(s => pickRow(s, has(String(s.code).toUpperCase()))).join('')
        : `<div class="empty sm">找不到「${esc(q)}」<br><span class="xs">可直接按「選取」用代碼查即時報價</span></div>`;
    }, 150);
  });
  res.addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (!b || b.disabled) return; pick({ code: b.dataset.pick, name: b.dataset.name, market: b.dataset.market }); });
  form.onsubmit = async (e) => {
    e.preventDefault(); const q = inp.value.trim(); if (!q) { inp.focus(); return; }
    const ql = q.toUpperCase();
    const m = filterList(await stockList(), q);
    let s = m.find(x => String(x.code).toUpperCase() === ql) || m[0] || null;
    if (!s) { msg.textContent = '查詢中…'; try { s = await lookup(q); } catch { s = null; } }
    if (!s) { msg.textContent = `找不到「${q}」`; return; }
    pick(s);
  };
  setTimeout(() => inp.focus(), 250);
}
/** 共用的到價提醒 sheet 沒有 callback：包住它的「設定提醒」按鈕。
 *  成功時 sheet 會自己關閉（失敗則留在畫面顯示原因）→ 按下後 sheet 已關閉 = 成功，回報給 onAdded 做樂觀更新。 */
function openAlertTracked(code, name, price, onAdded) {
  openAlertSheet(code, name, price);
  const sh = document.getElementById('sheet'); const btn = sh && sh.querySelector('#al-ok'); const orig = btn ? btn.onclick : null;
  if (typeof orig !== 'function') return;
  btn.onclick = async (ev) => {
    const v = cleanNum((sh.querySelector('#al-price') || {}).value);
    await orig.call(btn, ev);
    if (v === null || v <= 0 || sh.classList.contains('show')) return;
    const t = Date.now(), cur = num(price);
    onAdded({ id: `pending-${t}`, code, name, target: v, direction: cur !== null && v < cur ? 'down' : 'up', pending: true, t });
  };
}

export async function render(view, params = []) {
  let alive = true, gen = 0, segTeardown = null;
  let H = {};                       // 目前分段的 data-act / data-form 處理器
  let segApi = {};                  // 目前分段開給頁面層 CTA 的小介面（refresh / add）
  const timers = new Set();
  const ok = (g) => alive && g === gen;
  const slotIn = (id) => (alive ? view.querySelector('#' + id) : null);
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (alive) fn(); }, ms); timers.add(t); return t; };
  const alias = (k) => Object.prototype.hasOwnProperty.call(SEG_ALIAS, k) ? SEG_ALIAS[k] : null;
  let seg = alias(String(params[0] || '').toLowerCase()) || alias(String(store.get('pf_seg', 'holdings'))) || 'holdings';

  // ── shell: 編輯式標題 + 唯一主動作 + 分段列 + 內容 + 唯一免責 ──
  paint(view, `
    <div class="mt4 mb3"><div class="eyebrow">MY STOCKS</div><div class="h-display">我的持股，今天還好嗎？</div>
      <button class="cta" id="pf-cta" data-act="${CTA[seg][1]}">${CTA[seg][0]}</button></div>
    <div class="segbar"><div class="seg" role="tablist" aria-label="持股分段">${SEGS.map(([k, l]) => `<button role="tab" data-act="seg" data-seg="${k}" class="${k === seg ? 'on' : ''}" aria-selected="${k === seg}">${l}</button>`).join('')}</div></div>
    <div id="pf-body" class="section"></div>
    <div class="disclaimer">資料來源 TWSE／TPEx／Yahoo · 持股與提醒是個人紀錄工具；趨勢與進出場參考由程式依歷史價格判讀，不構成投資建議</div>`);
  const body = () => slotIn('pf-body');

  function paintSegLabels() {
    const counts = { holdings: holdings.stocks().length, watch: (wl.get() || []).length, alerts: alertCount };
    for (const b of view.querySelectorAll('[data-act="seg"]')) {
      const n = counts[b.dataset.seg];
      b.innerHTML = `${SEG_LABEL[b.dataset.seg]}${n ? ` <span class="num">${n}</span>` : ''}`;
    }
  }
  function showSeg(next, { persist = false, replace = false } = {}) {
    seg = next; gen++; H = {}; segApi = {};
    if (segTeardown) { try { segTeardown(); } catch { /* noop */ } segTeardown = null; }
    for (const b of view.querySelectorAll('[data-act="seg"]')) { const on = b.dataset.seg === seg; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
    const c = slotIn('pf-cta'); if (c) { c.textContent = CTA[seg][0]; c.dataset.act = CTA[seg][1]; }
    if (persist) store.set('pf_seg', seg);
    if (replace) { try { history.replaceState(null, '', `#/portfolio/${seg}`); } catch { /* noop */ } }   // 不觸發 hashchange，網址仍可分享
    paintSegLabels();
    segTeardown = ({ holdings: showHoldings, watch: showWatch, alerts: showAlerts })[seg](gen) || null;
  }
  /** 任一處新增提醒成功 → 樂觀加一列、更新分段計數；正在看提醒分段就立刻重畫並排程對帳 */
  const onAlertAdded = (row) => {
    queueAlertAdd(row); alertCount = (alertCount || 0) + 1; paintSegLabels();
    if (seg === 'alerts' && segApi.refresh) segApi.refresh();
  };

  // ═══════════════ 持股 ═══════════════
  function showHoldings(g) {
    const el = body(); if (!el) return null;
    // sig / quotes 以代碼為 key；sigState: loading | done。慢的分析與快的報價各自到達各自重繪。
    const st = { sig: new Map(), quotes: new Map(), sigState: 'loading', sigFailed: 0 };
    let list = [];
    paint(el, `${addBar('pf-add', 'add-hold', '輸入代碼快速加入，如 2330', 'numeric')}<div id="pf-sum" class="mt3"></div><div id="pf-cards" class="mt3"></div>`);

    /** 一檔持股要畫的資料：有分析 → 分析列；否則用報價墊底，並誠實標「分析中／尚未分析」 */
    function rowFor(s) {
      const sg = st.sig.get(s.code), q = st.quotes.get(s.code);
      if (sg && !sg.error) return { ...s, ...sg, name: sg.name || s.name || s.code, market: sg.market || s.market };
      const base = { ...s, name: (q && q.name) || (sg && sg.name) || s.name || s.code,
        price: q ? q.price : (sg ? sg.price : null), change: q ? q.change : (sg ? sg.change : null), change_pct: q ? q.change_pct : (sg ? sg.change_pct : null) };
      if (sg && sg.error) return { ...base, error: sg.error };                       // holdingCard → 「資料不足，暫無法分析」
      const loading = st.sigState === 'loading';
      return { ...base, action: 'neutral', action_label: loading ? '分析中…' : '尚未分析', action_desc: loading ? '' : '趨勢分析暫時無法取得，僅顯示報價。' };
    }
    function paintSummary() {
      const box = slotIn('pf-sum'); if (!box) return;
      const n = list.length;
      if (!n) { paint(box, cloudHint()); return; }
      const data = holdings.data(), unit = holdings.unit();
      let up = 0, dn = 0, fl = 0, quoted = 0, pctSum = 0, nCost = 0, amt = 0, nAmt = 0;
      const need = { below_stop: 0, hit_target: 0, near_target: 0, buy_zone: 0 };
      for (const s of list) {
        const r = rowFor(s); const p = num(r.price), c = num(r.change_pct);
        if (c !== null) { quoted++; if (c > 0) up++; else if (c < 0) dn++; else fl++; }
        const h = data[s.code] || {}; const cost = cleanNum(h.cost), qty = cleanNum(h.qty);
        if (p !== null && cost && cost > 0) {
          nCost++; pctSum += (p - cost) / cost * 100;
          if (qty && qty > 0) { nAmt++; amt += (p - cost) * (unit === 'lot' ? qty * 1000 : qty); }
        }
        if (hasOwn(need, r.action)) need[r.action]++;
      }
      const t = [{ k: '持股數', v: `${n}` }, { k: '今日', v: quoted ? `<span class="up">${up} 漲</span><span class="dim sm"> / </span><span class="down">${dn} 跌</span>` : '<span class="dim">—</span>' }];
      if (nCost) { const avg = pctSum / nCost; t.push({ k: '平均損益', v: signPct(avg), cls: cls(avg) }); }   // 沒填成本就不顯示，不假裝
      // 白話回答標題那句「今天還好嗎？」：全部由即時報價、趨勢分析與使用者填的成本推得
      let ans;
      if (!quoted && st.sigState === 'loading') ans = skLines(1);
      else {
        const parts = [quoted ? `今天 ${up} 檔漲、${dn} 檔跌${fl ? `、${fl} 檔平` : ''}` : '報價暫時取不到'];
        if (st.sigState === 'loading') parts.push('趨勢分析中');
        else if (st.sigFailed) parts.push('部分持股的趨勢分析沒取得');
        else if (need.below_stop) parts.push('有持股跌破停損參考，先看下面的卡');
        else if (need.hit_target + need.near_target) parts.push('有持股達到或接近目標價');
        else parts.push('沒有需要優先處理的');
        if (nAmt) parts.push(`已填成本的 ${nAmt} 檔未實現損益 <b class="num ${cls(amt)}">${amt >= 0 ? '+' : '−'}${fmtInt(Math.abs(amt))}</b> 元`);
        ans = `<div class="why">${parts.join('；')}。</div>`;
      }
      const chips = [];
      if (need.below_stop) chips.push(judge(`${need.below_stop} 檔跌破停損`, 'bad', '🛑'));
      if (need.hit_target + need.near_target) chips.push(judge(`${need.hit_target + need.near_target} 檔達到／接近目標`, 'ok', '🎯'));
      if (need.buy_zone) chips.push(judge(`${need.buy_zone} 檔在進場區`, 'ok', '✅'));
      paint(box, card(`<div class="stitle"><h2>💼 我的持股 <span class="sub">${n} 檔</span></h2><div class="seg" role="group" aria-label="數量單位"><button data-act="unit" data-unit="stock" class="${unit === 'stock' ? 'on' : ''}">股</button><button data-act="unit" data-unit="lot" class="${unit === 'lot' ? 'on' : ''}">張</button></div></div>
        ${tiles(t)}
        ${nCost && nCost < n ? `<div class="note mt1">平均損益只計 ${nCost}/${n} 檔有填成本的持股</div>` : ''}
        ${ans}
        ${chips.length ? `<div class="chips mt2">${chips.join('')}</div>` : ''}
        <div class="mt3">${cloudHint()}</div>`));
    }
    function paintCards() {
      const box = slotIn('pf-cards'); if (!box) return;
      if (!list.length) { paint(box, emptyState('💼', '還沒有持股<br><span class="sm">點上方「＋ 加入持股」或輸入代碼；小牛每天盤後幫你健診（LINE 推播需在「更多」設定）</span>')); return; }
      if (st.sigState === 'loading' && !st.quotes.size && !st.sig.size) { paint(box, `${skCards(Math.min(list.length, 3))}<div class="note mt2 center">首次分析約需 10–20 秒，報價會先顯示。</div>`); return; }
      const data = holdings.data(), unit = holdings.unit();
      let notice = '';
      if (st.sigState === 'loading') notice = `<div class="note mb2">⏳ 趨勢分析中（首次約 10–20 秒），先顯示即時報價。</div>`;
      else if (st.sigFailed) notice = `<div class="row between mb2"><span class="note">⚠️ 部分持股的趨勢分析沒取得，僅顯示報價。</span><button class="btn sm" data-act="retry-sig">重試</button></div>`;
      paint(box, notice + list.map(s => holdingCard(rowFor(s), data[s.code] || {}, unit)).join(''));
    }
    /** 分析：每 20 檔一批、各批獨立到達即重繪；回傳失敗批數。200 帶 {error} 或非陣列視同失敗。 */
    async function fetchSig(items) {
      const batches = []; for (let i = 0; i < items.length; i += SIG_BATCH) batches.push(items.slice(i, i + SIG_BATCH));
      let failed = 0;
      await Promise.all(batches.map(b => API.portfolioSignals(b.map(s => s.code), b.map(s => s.market || 'tse')).then(rows => {
        if (!ok(g)) return;
        if (!Array.isArray(rows)) throw new Error('bad body');
        for (const r of rows) if (r && r.code) st.sig.set(String(r.code), r);
        paintSummary(); paintCards();
      }).catch(() => { failed++; })));
      return failed;
    }
    async function fill() {
      if (!ok(g)) return;
      list = holdings.stocks().filter(s => s && s.code).map(s => ({ ...s, code: String(s.code) }));
      paintSegLabels(); paintSummary(); paintCards();
      if (!list.length) return;
      // 快的先到：即時報價（15 秒 TTL，重複呼叫很便宜）
      API.realtime(list.map(s => s.code), list.map(s => s.market || 'tse')).then(q => {
        if (!ok(g)) return;
        for (const r of (Array.isArray(q) ? q : [])) if (r && r.code) st.quotes.set(String(r.code), r);
        paintSummary(); paintCards();
      }).catch(() => { /* 報價失敗不影響分析卡 */ });
      // 慢的：只補還沒有分析結果的代碼（新加入一檔不必重掃全部）
      const need = list.filter(s => !st.sig.has(s.code));
      if (!need.length) { st.sigState = 'done'; paintSummary(); paintCards(); return; }
      st.sigState = 'loading'; st.sigFailed = 0;
      const failed = await fetchSig(need);
      if (!ok(g)) return;
      st.sigState = 'done'; st.sigFailed = failed; paintSummary(); paintCards();
    }
    function openCostSheet(code) {
      const s = list.find(x => x.code === code) || { code }; const r = rowFor(s);
      const h = holdings.data()[code] || {}; const lot = holdings.unit() === 'lot';
      const sh = openSheet(`<div class="stitle"><h2>✏️ 成本／數量</h2><span class="sub">${esc(r.name || code)} ${esc(code)}</span></div>
        <div class="sm mb3"><span class="dim">現價</span> <b class="num">${fmtPrice(r.price)}</b><span class="dim">。填了成本才會算損益；數量單位目前是「${lot ? '張' : '股'}」，可在持股頁切換。</span></div>
        <form data-cform>
          <div class="xs dim mb2">買入均價</div><input id="pf-cost" class="input" inputmode="decimal" enterkeyhint="next" placeholder="如 580" value="${esc(h.cost || '')}">
          <div class="xs dim mb2 mt3">數量（${lot ? '張' : '股'}）</div><input id="pf-qty" class="input" inputmode="decimal" enterkeyhint="done" placeholder="${lot ? '如 1' : '如 1000'}" value="${esc(h.qty || '')}">
          <div class="row mt4"><button type="button" class="btn grow" data-s="cancel">取消</button><button type="submit" class="btn primary grow">儲存</button></div>
          <div id="pf-msg" class="note mt2"></div>
        </form>`);
      const form = sh.querySelector('[data-cform]'), msg = sh.querySelector('#pf-msg');
      sh.querySelector('[data-s="cancel"]').onclick = closeSheet;
      form.onsubmit = (e) => {
        e.preventDefault();
        const rawCost = sh.querySelector('#pf-cost').value.trim(), rawQty = sh.querySelector('#pf-qty').value.trim();
        const cost = cleanNum(rawCost), qty = cleanNum(rawQty);   // 去掉千分位逗號
        if (rawCost && (cost === null || cost <= 0)) { msg.textContent = '成本需為大於 0 的數字'; return; }
        if (rawQty && (qty === null || qty < 0)) { msg.textContent = '數量需為數字'; return; }
        setHolding(code, cost ?? '', qty ?? '');
        closeSheet(); toast('已儲存，雲端同步中', 'ok'); paintSummary(); paintCards();
      };
      setTimeout(() => sh.querySelector('#pf-cost').focus(), 250);
    }

    H['add-hold'] = async (form) => {
      const inp = form.querySelector('input'), btn = form.querySelector('button'); const q = inp.value.trim();
      if (!q) { inp.focus(); return; }
      btn.disabled = true;
      try {
        const r = await lookup(q);                          // API.search 第一筆（代碼完全相符優先）
        if (!ok(g)) return;
        if (!r) { toast(`找不到「${q}」`, 'err'); return; }
        if (addHolding(String(r.code), r.name || '', r.market || 'tse')) { inp.value = ''; fill(); }
      } catch { toast('查詢失敗，請稍後再試', 'err'); }
      finally { btn.disabled = false; }
    };
    H.unit = (b) => { holdings.setUnit(b.dataset.unit === 'lot' ? 'lot' : 'stock'); syncPortfolio(); paintSummary(); paintCards(); };
    H.cost = (b) => openCostSheet(String(b.dataset.code));
    H.alert = (b) => openAlertTracked(String(b.dataset.code), b.dataset.name || '', num(b.dataset.price), onAlertAdded);
    H.remove = (b) => {
      const code = String(b.dataset.code); const s = list.find(x => x.code === code); if (!s) return;
      const keep = { ...s, hold: holdings.data()[code] || null };
      removeHolding(code);
      list = list.filter(x => x.code !== code); paintSegLabels(); paintSummary(); paintCards();
      undoToast(`已移除 ${keep.name || code}`, () => {          // 4 秒內可復原（連成本／數量一起還原）
        if (!addHolding(keep.code, keep.name, keep.market || 'tse')) return;
        if (keep.hold && (keep.hold.cost || keep.hold.qty)) setHolding(keep.code, keep.hold.cost, keep.hold.qty);
        fill();
      });
    };
    H['retry-sig'] = () => { invalidate('/api/portfolio_signals'); fill(); };
    segApi = { refresh: fill };
    fill();
    return null;
  }

  // ═══════════════ 關注 ═══════════════
  function showWatch(g) {
    const el = body(); if (!el) return null;
    let list = null, updated = null, qErr = false; const quotes = new Map();
    paint(el, `${addBar('wl-add', 'add-watch', '輸入代碼快速加入，如 2454', 'numeric')}<div id="wl-head" class="stitle mt3"><h2>👀 關注清單</h2></div><div id="wl-list">${card(skLines(4))}</div>`);

    function paintList() {
      const head = slotIn('wl-head'), box = slotIn('wl-list'); if (!box) return;
      if (!list) { paint(box, card(skLines(4))); return; }
      if (head) paint(head, `<h2>👀 關注清單 <span class="sub">${list.length} 檔</span></h2><span class="xs dim num">${marketOpen() ? '<span class="live"></span> ' : ''}${updated ? `更新 ${updated}` : (qErr ? '報價暫時取不到' : '報價載入中…')}</span>`);
      if (!list.length) { paint(box, card(emptyState('👀', '關注清單是空的<br><span class="sm">加入想追蹤但還沒買的股票，開盤時每 30 秒更新報價</span>'))); return; }
      paint(box, card(`<div class="list">${list.map(s => watchRow(s, quotes.get(s.code) || (qErr ? {} : null))).join('')}</div>`));
    }
    async function refresh() {
      if (!list) return;
      if (!list.length) { updated = hhmm(); paintList(); return; }
      try {
        const q = await API.realtime(list.map(s => s.code), list.map(s => s.market || 'tse'));
        if (!ok(g)) return;
        let named = false;
        for (const r of (Array.isArray(q) ? q : [])) {
          if (!r || !r.code) continue; quotes.set(String(r.code), r);
          const s = list.find(x => x.code === String(r.code));
          if (s && !s.name && r.name) { s.name = r.name; if (r.market) s.market = r.market; named = true; }   // 種子檔補名
        }
        if (named) wl.set(list);
        updated = hhmm(); qErr = false;
      } catch { if (!ok(g)) return; qErr = true; }
      paintList();
    }
    const iv = setInterval(() => { if (marketOpen() && !document.hidden) refresh(); }, 30000); timers.add(iv);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    /** 加入一檔（頁面 CTA 與快速加入列共用）；q = 已有的 realtime dict（search 回的就是），可直接當報價 */
    function add(item, q) {
      if (!list) { toast('關注清單載入中，請再試一次'); return false; }
      if (list.some(x => x.code === item.code)) { toast('已在關注清單'); return false; }
      list.push(item); wl.set(list);
      if (q) quotes.set(item.code, q);
      toast(`已加入關注 ${item.name || item.code}`, 'ok'); paintSegLabels(); paintList(); refresh();
      return true;
    }

    H['add-watch'] = async (form) => {
      const inp = form.querySelector('input'), btn = form.querySelector('button'); const q = inp.value.trim();
      if (!q || !list) { inp.focus(); return; }
      btn.disabled = true;
      try {
        const r = await lookup(q);
        if (!ok(g)) return;
        if (!r) { toast(`找不到「${q}」`, 'err'); return; }
        if (add({ code: String(r.code), name: r.name || '', market: r.market || 'tse' }, r)) inp.value = '';
      } catch { toast('查詢失敗，請稍後再試', 'err'); }
      finally { btn.disabled = false; }
    };
    H['wl-del'] = (b) => {
      if (!list) return;
      const code = String(b.dataset.code); const i = list.findIndex(x => x.code === code); if (i < 0) return;
      const [s] = list.splice(i, 1); wl.set(list); paintSegLabels(); paintList();
      undoToast(`已移除關注 ${s.name || code}`, () => {
        if (!list.some(x => x.code === code)) { list.splice(Math.min(i, list.length), 0, s); wl.set(list); }
        toast(`已復原 ${s.name || code}`, 'ok'); paintSegLabels(); paintList();
      });
    };
    segApi = { add };

    ensureWatchlist().then(l => { if (!ok(g)) return; list = l; paintSegLabels(); paintList(); refresh(); });
    return () => { clearInterval(iv); timers.delete(iv); document.removeEventListener('visibilitychange', onVis); };
  }

  // ═══════════════ 提醒 ═══════════════
  function showAlerts(g) {
    const el = body(); if (!el) return null;
    let rows = null, err = false, reconT = null;
    paint(el, `<div class="stitle"><h2>🔔 到價提醒</h2><span class="sub">到價自動推 LINE</span></div><div id="al-list">${card(skLines(3))}</div>
      <div class="note mt2">到價時由伺服器自動推 LINE（盤中每 5 分鐘檢查，不用開 app），推送成功後該提醒即完成。清單在伺服器約 8 秒更新一次，剛新增／刪除的會先顯示為同步中。</div>`);

    /** 伺服器清單 + 樂觀更新（剛加的補進去、剛刪的濾掉；逾時自動失效） */
    function merged() {
      const now = Date.now();
      pendingAlerts.adds = pendingAlerts.adds.filter(a => now - a.t < PENDING_TTL);
      for (const [id, t] of pendingAlerts.dels) if (now - t > PENDING_TTL) pendingAlerts.dels.delete(id);
      const base = (rows || []).filter(a => !pendingAlerts.dels.has(String(a.id)));
      const extra = pendingAlerts.adds.filter(p => !base.some(a => String(a.code) === p.code && num(a.target) === num(p.target)));
      return [...extra, ...base];
    }
    function paintList() {
      const box = slotIn('al-list'); if (!box) return;
      if (rows === null && !err) { paint(box, card(skLines(3))); return; }
      const all = merged();
      if (!all.length) {
        paint(box, card(err
          ? `<div class="empty"><div class="big">📡</div>提醒清單暫時載入不到<div class="mt3"><button class="btn" data-act="retry-alerts">重試</button></div></div>`
          : emptyState('🔔', '還沒有到價提醒<br><span class="sm">設定目標價，到價時自動推 LINE 通知你，不用開 app；每張持股卡也有「設提醒」</span>', '<button class="btn" data-act="pick-alert">＋ 新增提醒</button>')));
        return;
      }
      paint(box, card(`<div class="list">${all.map(a => a.pending ? pendingRow(a) : alertRow(a)).join('')}</div>`) + (err ? `<div class="note mt2">⚠️ 清單更新失敗，顯示上次結果。</div>` : ''));
    }
    /** 還有沒對上帳的樂觀新增 → 等伺服器快取過期後再抓一次 */
    function scheduleRecon() {
      const wait = pendingAlerts.adds.reduce((m, p) => Math.max(m, p.t + RECON_MS - Date.now()), 0);
      if (wait > 0 && !reconT) reconT = later(() => { reconT = null; if (ok(g)) fetchAlerts(); }, wait);
    }
    async function fetchAlerts() {
      try {
        const d = await API.alertsList(); if (!ok(g)) return;
        rows = (d && Array.isArray(d.alerts)) ? d.alerts.filter(a => a && a.code) : [];   // {alerts:[]} 也可能是「儲存未設定」，兩者外觀相同
        err = false; alertCount = rows.length; paintSegLabels();
      } catch { if (!ok(g)) return; err = true; }
      paintList(); scheduleRecon();
    }

    H['retry-alerts'] = () => fetchAlerts();
    H['del-alert'] = (b) => {
      const id = String(b.dataset.id || ''); if (!id || id.startsWith('pending')) return;
      pendingAlerts.dels.set(id, Date.now()); paintList();                              // 先移除，再打 API
      API.alertDel(id).then(d => { if (d && d.ok === false) throw new Error('del failed'); toast('已刪除提醒'); if (alertCount) { alertCount--; paintSegLabels(); } })
        .catch(() => { pendingAlerts.dels.delete(id); if (ok(g)) { toast('刪除失敗，請再試一次', 'err'); paintList(); } });
    };
    segApi = { refresh: () => { paintList(); scheduleRecon(); } };
    // 別的分段剛加的提醒：切進來時先畫樂觀列，再抓真實清單
    if (pendingAlerts.adds.length) rows = rows || [];
    fetchAlerts();
    return () => { if (reconT) { clearTimeout(reconT); timers.delete(reconT); } };
  }

  // ── 頁面層主動作（頂部 .cta；提醒空狀態的按鈕也走這裡）──
  const PICK = {
    'pick-hold': () => openPickSheet({
      title: '＋ 加入持股', hint: '加入後小牛每天盤後幫你健診（已連結 LINE 才會推播）；成本與數量可之後再填。',
      has: (c) => holdings.has(c),
      onPick: async (code, name, market) => {
        let r = null; try { r = await lookup(code); } catch { r = null; }        // 用 search 的正式名稱與市場（stock_list 的 market 只是推測）
        if (!alive) return;
        if (addHolding(code, (r && r.name) || name, (r && r.market) || market)) { paintSegLabels(); if (seg === 'holdings' && segApi.refresh) segApi.refresh(); }
      },
    }),
    'pick-watch': () => openPickSheet({
      title: '＋ 加入關注', hint: '還沒買、想先追蹤的股票放這裡；開盤時每 30 秒更新報價。',
      has: (c) => (wl.get() || []).some(x => x.code === c),
      onPick: async (code, name, market) => {
        let r = null; try { r = await lookup(code); } catch { r = null; }
        if (!alive) return;
        const item = { code, name: (r && r.name) || name, market: (r && r.market) || market };
        if (seg === 'watch' && segApi.add) { segApi.add(item, r); return; }
        const l = wl.get() || await ensureWatchlist(); if (!alive) return;
        if (l.some(x => x.code === code)) { toast('已在關注清單'); return; }
        l.push(item); wl.set(l); toast(`已加入關注 ${item.name || code}`, 'ok'); paintSegLabels();
      },
    }),
    'pick-alert': () => openPickSheet({
      title: '＋ 新增到價提醒', hint: '先選股票，下一步輸入目標價；到價時自動推 LINE，漲／跌方向依現價自動判斷。',
      onPick: async (code, name) => {
        let r = null; try { r = await lookup(code); } catch { r = null; }        // 需要現價才能開提醒 sheet
        if (!alive) return;
        if (!r) { toast('查無即時報價，暫時無法設定提醒', 'err'); return; }
        later(() => openAlertTracked(code, r.name || name, r.price, onAlertAdded), 300);   // 等選股 sheet 關閉動畫結束
      },
    }),
  };

  // ── events (delegated on view) ──
  function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b || !view.contains(b)) return;
    const act = b.dataset.act;
    if (act === 'seg') { if (b.dataset.seg !== seg) showSeg(b.dataset.seg, { persist: true, replace: true }); return; }
    if (hasOwn(PICK, act)) { e.preventDefault(); PICK[act](); return; }
    if (!hasOwn(H, act)) return;
    e.preventDefault(); H[act](b, e);
  }
  function onSubmit(e) {
    const f = e.target.closest('[data-form]'); if (!f) return;
    e.preventDefault(); if (hasOwn(H, f.dataset.form)) H[f.dataset.form](f);
  }
  view.addEventListener('click', onClick);
  view.addEventListener('submit', onSubmit);

  showSeg(seg);   // 深連結的分段不寫回 pf_seg，只有使用者親自點才記住

  return () => {
    alive = false; gen++;
    if (segTeardown) { try { segTeardown(); } catch { /* noop */ } }
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers.clear();
    view.removeEventListener('click', onClick);
    view.removeEventListener('submit', onSubmit);
  };
}
