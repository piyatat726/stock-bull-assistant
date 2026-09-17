// 台股小牛 v2 — 首頁：個人化每日簡報。
// 順序依 HOME COMPOSITION：天氣 hero → 行動摘要 chips → 需要處理 → 持股健康 →
// 今日精選 → 預測自評 → 時段卡（盤中異動／盤後重點／下週觀察）→ 接下來 → 免責。
// 每張卡片各自 fetch、各自 skeleton，互不阻塞；所有非同步填充在 teardown 後一律略過。
import { render as paint, esc, num, cls, signPct, fmtInt, skLines, skCards, twNow, marketOpen, timeAgo } from '../ui.js';
import { API, get } from '../api.js';
import { sectionHead, chip, judge, emptyState, stockRow, pickCard, skyHero, calibrationCard, holdings, stockHref } from '../components.js';

// ── private helpers ──
const ACTIONABLE = new Set(['below_stop', 'hit_target', 'near_target']);
// mirrors components.js ACTION_KIND (not exported) — judgement = icon + text badge, never price colour
const ACTION_KIND = { below_stop: ['bad', '🛑'], hit_target: ['ok', '🎯'], near_target: ['ok', '📍'], buy_zone: ['ok', '✅'], wait_pullback: ['warn', '⏳'], watch: ['warn', '👀'], neutral: ['neutral', '➖'] };
const hhmm = (d = twNow()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const isWeekend = () => { const d = twNow().getDay(); return d === 0 || d === 6; };
const cleanNum = (v) => num(String(v ?? '').replace(/,/g, ''));
const card = (inner, k = '') => `<div class="card${k ? ' ' + k : ''}">${inner}</div>`;
const safeUrl = (u) => /^https?:\/\//i.test(String(u || '')) ? esc(u) : '#';

function actionBadge(h) {
  if (!h || h.error || !h.action) return judge('資料不足', 'neutral', '➖');
  const [kind, icon] = ACTION_KIND[h.action] || ['neutral', '➖'];
  return judge(h.action_label || h.action, kind, icon);
}
/** 推薦「可進場」= 有技術進場價且現價 ≤ 進場價 +2% */
const canEnter = (p) => { const e = num(p && p.entry), pr = num(p && p.price); return e !== null && pr !== null && e > 0 && pr <= e * 1.02; };
/** daily_summary.outlook 是文字判斷 → 徽章種類（先測空再測多，避免「多空不明」誤判） */
function outlookKind(s) { s = String(s || ''); if (/空|弱|保守|謹慎/.test(s)) return 'warn'; if (/多|強|樂觀/.test(s)) return 'ok'; return 'neutral'; }
/** 法人買賣超：買超紅／賣超綠（方向色，非判斷色） */
const signedInt = (v) => { const n = num(v); return n === null ? '<span class="num flat">—</span>' : `<span class="num ${cls(n)}">${n > 0 ? '+' : ''}${fmtInt(n)}</span>`; };
/** /api/dividend 的 date 格式未固定：支援 YYYY/MM/DD、YYYYMMDD、民國 yyy/MM/dd、MM/DD */
function parseDay(s) {
  const str = String(s || '').trim(); let m;
  if ((m = str.match(/^(\d{2,3})年(\d{1,2})月(\d{1,2})日/))) return new Date(+m[1] + 1911, +m[2] - 1, +m[3]);   // TWSE 除權息表：115年09月10日
  if ((m = str.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/))) return new Date(+m[1], +m[2] - 1, +m[3]);
  if ((m = str.match(/^(\d{4})(\d{2})(\d{2})$/))) return new Date(+m[1], +m[2] - 1, +m[3]);
  if ((m = str.match(/^(\d{2,3})[/\-.](\d{1,2})[/\-.](\d{1,2})/))) return new Date(+m[1] + 1911, +m[2] - 1, +m[3]);
  if ((m = str.match(/^(\d{1,2})[/\-.](\d{1,2})$/))) return new Date(twNow().getFullYear(), +m[1] - 1, +m[2]);
  return null;
}

export async function render(view) {
  let alive = true;
  let timer = null;
  const slot = (id) => (alive ? view.querySelector('#' + id) : null);
  const stamp = () => { const u = slot('h-upd'); if (u) u.textContent = hhmm(); };
  const myStocks = holdings.stocks().filter(s => s && s.code);
  const myCodes = new Set(myStocks.map(s => String(s.code)));

  // progressive state shared between cards
  const brief = { todo: null, alerts: null, entry: null };   // null = 尚未載入
  const todo = { sig: [], intra: [] };
  const hero = { w: undefined, idx: undefined, b: undefined };  // undefined = 載入中, null = 失敗
  const next = { div: [], line: undefined };

  const picksHead = (state = 'loading', n = 0) =>
    `<div class="stitle"><h2>⭐ 今日精選${state === 'stale' ? ` ${chip('⟳ 快取 · 更新中')}` : state === 'ready' ? ` <span class="sub">共 ${n} 檔</span>` : ''}</h2><a href="#/picks">看全部 ›</a></div>`;

  // ── 0. shell: every card starts as a skeleton ──
  paint(view, `
    <div id="h-hero">${skyHero(undefined, null)}</div>
    <div id="h-odds"></div>
    <div id="h-brief" class="brief" aria-live="polite" hidden></div>
    <section id="h-todo" class="section" hidden></section>
    <section id="h-health" class="section">${sectionHead('💼 我的持股健康')}${card(skLines(3))}</section>
    <section id="h-picks" class="section">${picksHead()}${skCards(3)}<div class="note mt2 center">綜合掃描約需 10–20 秒，有上次結果會先顯示。</div></section>
    <section id="h-cal" class="section">${card(skLines(6))}</section>
    <section id="h-slot" class="section">${skCards(1)}</section>
    <section id="h-next" class="section" hidden></section>
    <div class="disclaimer">資料來源 TWSE／TPEx／Yahoo · 僅供參考，不構成投資建議 · 更新 <span id="h-upd" class="num">${hhmm()}</span></div>`);

  // ── 1. 市場天氣 hero（reference look：天氣＝現況描述；格局勝率另列一行，各自到達各自重繪） ──
  function paintHero() {
    const el = slot('h-hero'); if (!el) return;
    const idx = hero.idx && num(hero.idx.price) !== null ? hero.idx : null;
    paint(el, skyHero(hero.b, idx));
    const od = slot('h-odds'); if (!od) return;
    if (hero.w && hero.w.label) {
      paint(od, `<div class="card mt3"><div class="row between"><div><div class="xs dim">大盤格局（MA20／MA60）</div><div class="b lg">${hero.w.icon || ''} ${esc(hero.w.label)}格局</div></div><a class="chip" href="#/market">看市場 ›</a></div>
        <div class="sm mt2" style="color:var(--text-2)">歷史同格局 5 日後上漲機率 <b class="gold">${hero.w.fwd5_up_prob ?? '—'}%</b><span class="dim xs">（${hero.w.n_hist || 0} 次，參考用）</span>${hero.w.class_win_rate_here != null ? ` · 此格局進場訊號勝率 <b>${hero.w.class_win_rate_here}%</b><span class="dim xs">（${hero.w.class_n_here} 筆）</span>` : ''}</div></div>`);
      stamp();
    } else if (hero.w === undefined) {
      paint(od, `<div class="note mt2 center">計算歷史同格局勝率中（冷啟動約 10–30 秒）…</div>`);
    } else {
      paint(od, `<div class="note mt2 center">大盤格局服務暫時無回應，其他卡片不受影響。</div>`);
    }
  }
  API.marketSummary().then(d => { hero.idx = (d && d.tse) || null; }).catch(() => { hero.idx = null; }).finally(paintHero);
  API.breadth().then(b => { hero.b = (b && b.weather) ? b : null; }).catch(() => { hero.b = null; }).finally(paintHero);
  API.weather().then(w => { hero.w = (w && w.label) ? w : null; }).catch(() => { hero.w = null; }).finally(paintHero);

  // ── 1b. 行動摘要 chips（三個來源各自到達即更新；全部為 0 才說「沒有待處理」） ──
  function paintBrief() {
    const el = slot('h-brief'); if (!el) return;
    const chips = [];
    if (brief.todo) chips.push(`<button class="chip warn" data-act="scroll" data-to="h-todo">🛎 ${brief.todo} 檔持股需處理</button>`);
    if (brief.alerts) chips.push(`<a class="chip" href="#/portfolio/alerts">🔔 ${brief.alerts} 個到價提醒</a>`);
    if (brief.entry) chips.push(`<button class="chip gold" data-act="scroll" data-to="h-picks">✅ ${brief.entry} 檔推薦在進場區</button>`);
    const settled = brief.todo !== null && brief.alerts !== null && brief.entry !== null;
    if (!chips.length && settled) chips.push(chip('✓ 今天沒有待處理事項'));
    el.hidden = !chips.length;
    paint(el, chips.join(''));
  }
  API.alertsList().then(d => { brief.alerts = (d && Array.isArray(d.alerts)) ? d.alerts.length : 0; }).catch(() => { brief.alerts = 0; }).finally(paintBrief);

  // ── 2. 需要處理（只在非空時渲染；來源：持股訊號 + 盤中異動∩持股） ──
  function paintTodo() {
    const el = slot('h-todo'); if (!el) return;
    const seen = new Set(); const rows = [];
    for (const h of todo.sig) { seen.add(String(h.code)); rows.push(stockRow(h, { right: actionBadge(h), sub: h.action_desc ? esc(h.action_desc) : '' })); }
    for (const x of todo.intra) { if (seen.has(String(x.code))) continue; rows.push(stockRow(x, { sub: `${esc(x.icon || '')} 盤中${esc(x.type || '異動')} · 持股中` })); }
    if (!rows.length) { el.hidden = true; paint(el, ''); return; }
    el.hidden = false;
    paint(el, sectionHead('🛎 需要處理', { sub: `${rows.length} 項`, link: '看全部', href: '#/portfolio' })
      + card(`<div class="list">${rows.slice(0, 5).join('')}</div>${rows.length > 5 ? `<a class="btn sm block mt2" href="#/portfolio">看全部 ${rows.length} 項 ›</a>` : ''}`));
  }
  async function fillIntraTodo() {
    if (!marketOpen() || !myCodes.size) return;
    try {
      const d = await API.intraday(); if (!alive) return;
      todo.intra = ((d && Array.isArray(d.alerts)) ? d.alerts : []).filter(x => x && myCodes.has(String(x.code)));
      paintTodo();
    } catch { /* 盤中異動失敗不影響其他列 */ }
  }

  // ── 3. 我的持股健康（也是「需要處理」與摘要 chip 的持股來源） ──
  function pnlSummary(rows) {
    const data = holdings.data(), unit = holdings.unit();
    let costSum = 0, valSum = 0, todaySum = 0, hasToday = false, nQty = 0, nCost = 0, pctSum = 0;
    for (const r of rows) {
      const price = num(r.price); const h = data[r.code] || {};
      const cost = cleanNum(h.cost), qty = cleanNum(h.qty);
      if (price === null || !cost || cost <= 0) continue;
      nCost++; pctSum += (price - cost) / cost * 100;
      const shares = qty ? (unit === 'lot' ? qty * 1000 : qty) : 0;
      if (shares > 0) {
        nQty++; costSum += cost * shares; valSum += price * shares;
        const ch = num(r.change); if (ch !== null) { todaySum += ch * shares; hasToday = true; }
      }
    }
    if (!nCost) return '';
    if (costSum > 0) {   // 有數量 → 依市值加權；沒填數量的持股不計入金額
      const pct = (valSum - costSum) / costSum * 100, amt = valSum - costSum;
      return `<div class="row between mt2 sm"><span class="dim">總損益${nQty < nCost ? `<span class="xs">（${nQty}/${nCost} 檔有填數量）</span>` : ''}</span><span class="num b ${cls(pct)}">${signPct(pct)} <span class="sm">(${amt >= 0 ? '+' : '−'}${fmtInt(Math.abs(amt))})</span></span></div>`
        + (hasToday ? `<div class="row between sm"><span class="dim">今日</span><span class="num ${cls(todaySum)}">${todaySum >= 0 ? '+' : '−'}${fmtInt(Math.abs(todaySum))}</span></div>` : '');
    }
    const avg = pctSum / nCost;   // 只有成本、沒有數量 → 等權平均
    return `<div class="row between mt2 sm"><span class="dim">平均損益 <span class="xs">（未填數量，等權）</span></span><span class="num b ${cls(avg)}">${signPct(avg)}</span></div>`;
  }
  async function fillHealth() {
    const el = slot('h-health'); if (!el) return;
    const head = sectionHead('💼 我的持股健康', myStocks.length ? { sub: `${myStocks.length} 檔`, link: '看全部', href: '#/portfolio' } : {});
    if (!myStocks.length) {
      paint(el, head + card(emptyState('💼', '加入第一檔持股，小牛每天幫你健診', `<a class="btn primary" href="#/portfolio">＋ 加入持股</a>`)));
      todo.sig = []; brief.todo = 0; paintTodo(); paintBrief(); return;
    }
    paint(el, head + card(skLines(3)));
    const batch = myStocks.slice(0, 20);   // /api/portfolio_signals 上限 20 檔
    let rows = null;
    try { const d = await API.portfolioSignals(batch.map(s => s.code), batch.map(s => s.market || 'tse')); rows = Array.isArray(d) ? d : []; }
    catch { rows = null; }
    if (!alive) return;
    const byCode = new Map(); (rows || []).forEach(r => { if (r && r.code) byCode.set(String(r.code), r); });
    const merged = myStocks.map(s => ({ ...s, ...(byCode.get(String(s.code)) || {}) }));   // 每檔持股都有一列，缺資料就標「資料不足」
    const good = merged.filter(r => !r.error && num(r.price) !== null);
    todo.sig = good.filter(r => ACTIONABLE.has(r.action));
    brief.todo = todo.sig.length; paintTodo(); paintBrief();

    const ups = good.filter(r => num(r.change_pct) > 0).length, downs = good.filter(r => num(r.change_pct) < 0).length, flats = good.length - ups - downs;
    const pills = good.length
      ? `<div class="row"><span class="pill-num num up">${ups} 漲</span><span class="pill-num num down">${downs} 跌</span>${flats ? `<span class="pill-num num flat">${flats} 平</span>` : ''}</div>`
      : `<span class="sm dim">健診資料不足</span>`;
    const rail = `<div class="subtabs">${merged.map(r => `<a class="btn sm" href="${stockHref(r.code)}"><span class="ellipsis">${esc(r.name || r.code)} ${actionBadge(r)}</span></a>`).join('')}</div>`;
    const status = rows === null ? `<div class="row between mt2"><span class="note">健診服務暫時無回應，先列出持股。</span><button class="btn sm" data-act="retry-health">重試</button></div>` : '';
    paint(el, head + card(`<div class="row between">${pills}<span class="xs dim">健診 ${hhmm()}${myStocks.length > 20 ? ' · 僅前 20 檔' : ''}</span></div>${pnlSummary(good)}${rail}${status}`));
    stamp();
  }

  // ── 4. 今日精選（SWR：先畫快取 + 「更新中」pill，再畫新結果） ──
  function paintPicks(data, { stale = false, error = null } = {}) {
    const el = slot('h-picks'); if (!el) return;
    const list = Array.isArray(data) ? data.filter(p => p && p.code) : [];
    const failed = !!(data && !Array.isArray(data) && data.error);   // HTTP-200 error body → 空狀態
    brief.entry = list.filter(canEnter).length; paintBrief();
    const body = list.length
      ? list.slice(0, 3).map((p, i) => pickCard(p, { rank: i + 1 })).join('')
      : card(emptyState('🔍', failed ? '推薦引擎暫時無法取得資料' : '今天沒有符合條件的綜合推薦'));
    const foot = stale ? `<div class="note mt2 center">${error ? '重新掃描失敗，顯示上次結果。' : '顯示上次結果，背景重新掃描中（約 10–20 秒）。'}</div>` : '';
    paint(el, picksHead(stale ? 'stale' : 'ready', list.length) + body + foot);
    if (!stale) stamp();
  }
  async function fillPicks() {
    if (!slot('h-picks')) return;
    try { await API.topBuys(paintPicks); }
    catch {
      if (!alive) return;
      brief.entry = 0; paintBrief();
      paint(slot('h-picks'), picksHead() + card(emptyState('😵', '推薦暫時無法載入', `<button class="btn sm" data-act="retry-picks">重試</button>`)));
    }
  }

  // ── 5. 預測自評 + 戰績（兩個快速端點，同一張卡） ──
  async function fillCal() {
    let rep = null, pnl = null;
    await Promise.allSettled([
      API.predictionReport().then(d => { rep = d && typeof d === 'object' ? d : null; }),
      API.pnlStats().then(d => { pnl = d && typeof d === 'object' ? d : null; }),
    ]);
    paint(slot('h-cal'), calibrationCard(rep, pnl));
  }

  // ── 6. 時段卡 ──
  const movesHead = (t) => `<div class="stitle"><h2>⚡ 盤中異動 <span class="sub"><span class="live" aria-hidden="true"></span> LIVE${t ? ` ${esc(t)}` : ''} · ±5%</span></h2><a href="#/market/moves">看全部 ›</a></div>`;
  async function fillMoves(first) {
    const el = slot('h-slot'); if (!el) return;
    if (first) paint(el, movesHead('') + card(skLines(3)));
    try {
      const d = await API.intraday(); if (!alive) return;
      if (d && d.market_open === false) { stopTick(); return fillAfterClose(); }   // 伺服器說休市（例如國定假日）
      const list = (d && Array.isArray(d.alerts)) ? d.alerts.filter(x => x && x.code) : [];
      const rows = list.slice(0, 5).map(x => stockRow(x, { sub: `${esc(x.icon || '')} ${esc(x.type || '')}${myCodes.has(String(x.code)) ? ' · 持股中' : ''}` })).join('');
      const body = rows
        ? `<div class="list">${rows}</div>${list.length > 5 ? `<a class="btn sm block mt2" href="#/market/moves">看全部 ${list.length} 檔 ›</a>` : ''}`
        : emptyState('😴', '目前沒有 ±5% 以上的急拉／急殺或漲跌停');
      paint(slot('h-slot'), movesHead(d && d.tw_time) + card(body));
      stamp();
    } catch {
      if (alive && first) paint(slot('h-slot'), movesHead('') + card(`<div class="note">盤中異動暫時無法取得，60 秒後自動重試。</div>`));
    }
  }
  function summaryHtml(d) {
    const paras = d && Array.isArray(d.paragraphs) ? d.paragraphs.filter(p => p && (p.title || p.text)) : [];
    if (!paras.length) return `<div class="note">今日盤後總結尚未產生（通常收盤後約一小時更新）。</div>`;
    const inst = d.institutional || {};
    const instLine = ['foreign', 'trust', 'total'].some(k => num(inst[k]) !== null)
      ? `<div class="xs dim mt2">三大法人 外資 ${signedInt(inst.foreign)} · 投信 ${signedInt(inst.trust)} · 合計 ${signedInt(inst.total)} 張</div>` : '';
    return `<div class="chips">${d.outlook ? judge(d.outlook, outlookKind(d.outlook), d.outlook_icon || '') : ''}<span class="xs dim">${esc(d.date || '')} 盤後分析</span></div>`
      + paras.slice(0, 2).map(p => `<div class="mt2">${p.title ? `<div class="sm b">${esc(p.title)}</div>` : ''}<div class="why">${esc(p.text || '')}</div></div>`).join('')
      + instLine;
  }
  function newsHtml(n) {
    const list = Array.isArray(n) ? n.filter(x => x && x.title).slice(0, 3) : [];
    if (!list.length) return `<div class="note">暫無台股頭條。</div>`;
    return `<div class="xs dim">📰 台股頭條</div><div class="list">${list.map(x =>
      `<a class="li" href="${safeUrl(x.link)}" target="_blank" rel="noopener"><div class="grow"><div class="sm b">${esc(x.title)}</div><div class="xs dim mt1">${esc(x.source || '')}${x.date ? ` · ${esc(timeAgo(x.date))}` : ''}</div></div><span class="dim">↗</span></a>`).join('')}</div>`;
  }
  function fillAfterClose() {
    const el = slot('h-slot'); if (!el) return;
    const pre = twNow().getHours() < 9;
    paint(el, sectionHead(pre ? '📝 昨日盤後重點' : '📝 盤後重點', { link: '看市場', href: '#/market' })
      + card(`<div id="h-sum">${skLines(3)}</div><div class="hairline"></div><div id="h-news">${skLines(3)}</div>`));
    get('/api/daily_summary', { ttl: 600000, timeout: 30000 })
      .then(d => { paint(slot('h-sum'), summaryHtml(d)); stamp(); })
      .catch(() => paint(slot('h-sum'), `<div class="note">盤後總結暫時無法取得。</div>`));
    get('/api/news?q=' + encodeURIComponent('台股'), { ttl: 600000, timeout: 20000 })
      .then(n => paint(slot('h-news'), newsHtml(n)))
      .catch(() => paint(slot('h-news'), `<div class="note">新聞暫時無法取得。</div>`));
  }
  function fillWeekend() {
    const el = slot('h-slot'); if (!el) return;
    const head = sectionHead('📋 下週觀察名單', { sub: '最近交易日收盤資料', link: '看全部', href: '#/picks' });
    paint(el, head + skCards(2));
    API.topBuys((data) => {   // 與今日精選共用同一個請求（api.js inflight 去重）
      const list = Array.isArray(data) ? data.filter(p => p && p.code) : [];
      paint(slot('h-slot'), head + (list.length ? list.slice(0, 3).map((p, i) => pickCard(p, { rank: i + 1 })).join('') : card(emptyState('📋', '目前沒有可放入觀察的推薦'))));   // 完整卡：含勝率／樣本／期間
    }).catch(() => paint(slot('h-slot'), head + card(`<div class="note">觀察名單暫時無法取得。</div>`)));
  }
  function fillSlot() {
    if (isWeekend()) return fillWeekend();
    if (marketOpen()) return fillMoves(true);
    return fillAfterClose();
  }
  // 盤中每 60 秒刷新（分頁隱藏時暫停）；收盤後自動切成盤後重點
  function stopTick() { if (timer) { clearInterval(timer); timer = null; } }
  function startTick() {
    timer = setInterval(() => {
      if (document.hidden) return;
      if (!marketOpen()) { stopTick(); todo.intra = []; paintTodo(); fillAfterClose(); return; }
      fillMoves(false); fillIntraTodo();
    }, 60000);
  }
  const onVis = () => { if (!document.hidden && timer && marketOpen()) { fillMoves(false); fillIntraTodo(); } };

  // ── 7. 接下來（持股 14 天內除權息 + LINE 未連結提示；都沒有就不出現） ──
  function paintNext() {
    const el = slot('h-next'); if (!el) return;
    const parts = [];
    if (next.div.length) parts.push(`<div class="xs dim mb2">💰 持股除權息（14 天內）</div><div class="list">${next.div.map(x =>
      `<a class="li" href="${stockHref(x.code)}"><div class="grow"><div class="ident"><span class="name">${esc(x.name || x.code)}</span><span class="code">${esc(x.code)}</span></div><div class="xs dim mt1">${esc(x.type || '除權息')} · ${esc(x.date)}</div></div><div class="right">${chip(esc(x.when))}</div></a>`).join('')}</div>`);
    if (next.line === false) parts.push(`<div class="hint">🔗 <a href="#/more">連結 LINE 直推可省額度並開啟雙向查股（更多 › 設定）</a></div>`);
    if (!parts.length) { el.hidden = true; paint(el, ''); return; }
    el.hidden = false;
    paint(el, sectionHead('📅 接下來') + card(parts.join('<div class="hairline"></div>')));
  }
  if (myCodes.size) {
    get('/api/dividend', { ttl: 600000, timeout: 20000 }).then(list => {
      const today = twNow(); today.setHours(0, 0, 0, 0);
      const out = [];
      for (const x of (Array.isArray(list) ? list : [])) {
        if (!x || !myCodes.has(String(x.code))) continue;
        const d = parseDay(x.date); if (!d) continue;
        const diff = Math.round((d - today) / 86400000);
        if (diff < 0 || diff > 14) continue;
        out.push({ ...x, diff, when: diff === 0 ? '今天' : diff === 1 ? '明天' : `${diff} 天後` });
      }
      next.div = out.sort((a, b) => a.diff - b.diff).slice(0, 5);
    }).catch(() => {}).finally(paintNext);
  }
  API.lineStatus().then(d => { next.line = d && d.ok ? d.has_line_to : undefined; }).catch(() => {}).finally(paintNext);

  // ── events (delegated) ──
  function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'scroll') {   // chip → 捲到對應卡片（扣掉 sticky header 高度）
      const t = view.querySelector('#' + b.dataset.to); if (!t) return;
      window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - 72, behavior: 'smooth' });
    } else if (act === 'retry-health') fillHealth();
    else if (act === 'retry-picks') fillPicks();
  }
  view.addEventListener('click', onClick);
  document.addEventListener('visibilitychange', onVis);

  // ── kick off — nothing awaited, first paint is the skeleton above ──
  fillHealth(); fillIntraTodo(); fillPicks(); fillCal(); fillSlot();
  if (marketOpen()) startTick();

  return () => {
    alive = false; stopTick();
    view.removeEventListener('click', onClick);
    document.removeEventListener('visibilitychange', onVis);
  };
}
