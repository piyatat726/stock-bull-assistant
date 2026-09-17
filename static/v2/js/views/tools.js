// 台股小牛 v2 — 工具頁 #/tools/:tool（calc｜dca｜backtest｜dividend；其他 → 工具選單）。
// 每個工具：.backbar（← 回 #/more）＋ 表單卡 ＋ 結果區 ＋ 底部唯一一則 .disclaimer。
// 慣例：價格／損益／報酬率 紅漲綠跌（cls）；手續費與稅是中性數字；表單先畫、結果各自填。
// 事件全部委派在 view 上，teardown 時移除監聽並銷毀圖表（view 是同一個 <main>，不移除會累積）。
import { render as paint, esc, num, cls, signPct, fmtPrice, fmtInt, pctPill, skCards, toast, store, twNow } from '../ui.js';
import { get } from '../api.js';
import { sectionHead, chip, emptyState, ident, tiles, stockRow, stockHref, holdings } from '../components.js';
import { mountEquity } from '../chart.js';

// ── 私有小工具（ui.js／components.js 沒有的，見 missing_components） ──
const TOOLS = {
  calc:     { icon: '🧮', title: '買賣成本／損益試算', desc: '把手續費、證交稅算進去，看真實成本與淨損益' },
  dca:      { icon: '📊', title: '定期定額試算', desc: '用歷史收盤價模擬每月定額買進的結果' },
  backtest: { icon: '📈', title: '多股回測', desc: '比較最多 5 檔在同一區間的報酬與最大回撤' },
  dividend: { icon: '📅', title: '除權息日曆', desc: '近 3 個月除權息，可只看我的持股' },
};
const backbar = (t) => `<div class="backbar"><a class="btn" href="#/more" aria-label="返回更多">←</a><div class="title">${t.icon} ${esc(t.title)}</div></div>`;
const disclaimer = (text) => `<div class="disclaimer">${text}</div>`;
/** 帶正負號的整數金額（損益用；負號用 U+2212 對齊 holdingCard） */
const signInt = (v) => { const n = num(v); return n === null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtInt(Math.abs(n))}`; };
/** 小數（股數用） */
const fmtDec = (v, d = 2) => { const n = num(v); return n === null ? '—' : n.toLocaleString('zh-TW', { maximumFractionDigits: d }); };
const CODE_RE = /^\d{4,6}[A-Z]?$/;
const normCode = (s) => String(s || '').trim().toUpperCase();
/** 把「2330, 2317、0050」切成最多 max 個合法代碼（去重），回報被略過的與是否超量 */
function normCodes(str, max = 5) {
  const out = [], bad = [];
  for (const raw of String(str || '').split(/[,，、\s]+/)) {
    const c = normCode(raw); if (!c) continue;
    if (!CODE_RE.test(c)) { bad.push(c); continue; }
    if (!out.includes(c)) out.push(c);
  }
  return { codes: out.slice(0, max), over: out.length > max, bad };
}
/** 委派事件：一次掛、一次拆 */
function listen(view, map) {
  const offs = Object.entries(map).map(([type, fn]) => { view.addEventListener(type, fn); return () => view.removeEventListener(type, fn); });
  return () => offs.forEach(f => f());
}
/** .seg 內切換 .on，回傳被點的 data-v */
function segPick(btn) { for (const b of btn.parentElement.querySelectorAll('button')) b.classList.toggle('on', b === btn); return btn.dataset.v; }
const segHtml = (act, opts, cur) => `<div class="seg">${opts.map(([v, label]) => `<button type="button" data-act="${act}" data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
const ERR_TXT = { 'need code': '請輸入股票代碼', 'need codes': '請輸入股票代碼', 'invalid amount': '金額格式不正確' };
const failCard = (e, act = 'run') => `<div class="card">${emptyState('😵', (e && e.body && e.body.error && (ERR_TXT[e.body.error] || esc(String(e.body.error)))) || '取得資料失敗，請稍後再試', `<button type="button" class="btn sm" data-act="${act}">重試</button>`)}</div>`;
/** /api/dividend 的 date 實測是民國「115年09月10日」；也容忍 YYYY/MM/DD、YYYYMMDD、民國 yyy/MM/dd、MM/DD */
function parseDay(s) {
  const str = String(s || '').trim(); let m;
  const mk = (y, mo, d) => { const t = new Date(y, mo - 1, d); return Number.isNaN(t.getTime()) ? null : t; };
  if ((m = str.match(/^(\d{2,4})年(\d{1,2})月(\d{1,2})/))) return mk(+m[1] < 1911 ? +m[1] + 1911 : +m[1], +m[2], +m[3]);
  if ((m = str.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/))) return mk(+m[1], +m[2], +m[3]);
  if ((m = str.match(/^(\d{4})(\d{2})(\d{2})$/))) return mk(+m[1], +m[2], +m[3]);
  if ((m = str.match(/^(\d{2,3})[/\-.](\d{1,2})[/\-.](\d{1,2})/))) return mk(+m[1] + 1911, +m[2], +m[3]);
  if ((m = str.match(/^(\d{1,2})[/\-.](\d{1,2})$/))) return mk(twNow().getFullYear(), +m[1], +m[2]);
  return null;
}

export async function render(view, params = []) {
  const fn = { calc: renderCalc, dca: renderDca, backtest: renderBacktest, dividend: renderDividend }[String(params[0] || '')];
  return fn ? fn(view, params.slice(1)) : renderMenu(view);
}

// ── 選單（未知 tool） ──
function renderMenu(view) {
  paint(view, `${backbar({ icon: '🧰', title: '工具' })}
    <div class="card"><div class="list">${Object.entries(TOOLS).map(([k, t]) => `<a class="li" href="#/tools/${k}"><span class="lg">${t.icon}</span><div class="grow"><div class="name">${esc(t.title)}</div><div class="xs dim mt1">${esc(t.desc)}</div></div><span class="dim">›</span></a>`).join('')}</div></div>
    ${disclaimer('工具僅為試算與歷史模擬，不構成投資建議')}`);
  return null;
}

// ── 🧮 買賣成本／損益試算（純前端） ──
// 沿用舊版公式：手續費 = round(金額 × 0.1425% × 折扣)，證交稅 = round(賣出金額 × 稅率)、只在賣出收。
// 差異：最低手續費依規格取 20 元（舊版是 1 元）；新增 ETF 0.1% 稅率；張數 × 1,000 = 股數（0.5 張＝零股 500 股）。
const FEE_RATE = 0.001425, MIN_FEE = 20;
const DISCOUNTS = [[1, '無折扣'], [0.6, '6 折'], [0.5, '5 折'], [0.38, '3.8 折'], [0.28, '2.8 折']];
function calcAll(s) {
  const shares = Math.round(Math.max(0, num(s.lots) ?? 0) * 1000);
  const disc = num(s.disc) ?? 1, taxRate = num(s.tax) ?? 0.003;
  const fee = (amt) => Math.max(Math.round(amt * FEE_RATE * disc), MIN_FEE);
  const buy = num(s.buy), sell = num(s.sell);
  const r = { shares };
  if (shares > 0 && buy > 0) { r.buyAmt = buy * shares; r.buyFee = fee(r.buyAmt); r.cost = r.buyAmt + r.buyFee; r.perShare = r.cost / shares; }
  if (shares > 0 && sell > 0) { r.sellAmt = sell * shares; r.sellFee = fee(r.sellAmt); r.tax = Math.round(r.sellAmt * taxRate); r.net = r.sellAmt - r.sellFee - r.tax; }
  if (r.cost != null && r.net != null) { r.pnl = r.net - r.cost; r.pct = r.pnl / r.cost * 100; }
  if (r.cost != null) { const k = 1 - FEE_RATE * disc - taxRate; r.breakeven = k > 0 ? r.cost / (shares * k) : null; }   // 不含最低費門檻的近似值
  return r;
}
function renderCalc(view) {
  const s = Object.assign({ buy: '', sell: '', lots: '1', disc: 0.6, tax: 0.003 }, store.get('v2.tools.calc', {}) || {});
  const save = () => store.set('v2.tools.calc', s);
  const field = (k, label, ph) => `<div class="grow col"><label class="xs dim" for="c-${k}">${label}</label><input id="c-${k}" class="input num" data-k="${k}" inputmode="decimal" autocomplete="off" placeholder="${ph}" value="${esc(s[k])}"></div>`;
  paint(view, `${backbar(TOOLS.calc)}
    <div class="card">
      <div class="row">${field('buy', '買價', '例如 500')}${field('sell', '賣價', '例如 520')}</div>
      <div class="row mt3">${field('lots', '張數', '1')}<div class="grow col"><label class="xs dim" for="c-disc">手續費折扣</label><select id="c-disc" class="input" data-k="disc">${DISCOUNTS.map(([v, l]) => `<option value="${v}"${String(v) === String(s.disc) ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>
      <div class="row between mt3"><span class="sm dim">證交稅</span>${segHtml('tax', [[0.003, '股票 0.3%'], [0.001, 'ETF 0.1%']], s.tax)}</div>
      <div class="note mt2">1 張＝1,000 股，填 0.5 張代表零股 500 股。手續費 0.1425%×折扣，買賣各收一次、最低 20 元；證交稅只在賣出時收。</div>
    </div>
    <div id="c-out" class="mt3"></div>
    ${disclaimer('依公開費率試算，實際手續費與最低收費以各券商為準，不構成投資建議')}`);
  function draw() {
    const el = view.querySelector('#c-out'); if (!el) return;
    const r = calcAll(s);
    const fee = r.buyFee != null || r.sellFee != null ? (r.buyFee || 0) + (r.sellFee || 0) : null;
    paint(el, `<div class="card">${tiles([
      { k: '買進成本 (元)', v: r.cost != null ? fmtInt(r.cost) : '—' },
      { k: '賣出淨收 (元)', v: r.net != null ? fmtInt(r.net) : '—' },
      { k: '手續費 (元)', v: fee != null ? fmtInt(fee) : '—' },
      { k: '證交稅 (元)', v: r.tax != null ? fmtInt(r.tax) : '—' },
      { k: '損益 (元)', v: signInt(r.pnl), cls: cls(r.pnl) },
      { k: '報酬率', v: signPct(r.pct), cls: cls(r.pct) },
    ])}
    <div class="note mt3">${r.shares > 0 ? `共 <b class="num">${fmtInt(r.shares)}</b> 股` : '請輸入張數'}${r.perShare != null ? ` · 每股實際成本 <b class="num">${fmtPrice(r.perShare)}</b>` : ''}${r.breakeven != null ? ` · 損益兩平賣價約 <b class="num">${fmtPrice(r.breakeven)}</b>（含來回手續費與稅）` : ''}</div></div>`);
  }
  draw();
  return listen(view, {
    input:  (e) => { const k = e.target.dataset && e.target.dataset.k; if (!k || k === 'disc') return; s[k] = e.target.value; save(); draw(); },
    change: (e) => { if (e.target.dataset && e.target.dataset.k === 'disc') { s.disc = Number(e.target.value) || 1; save(); draw(); } },
    click:  (e) => { const b = e.target.closest('[data-act="tax"]'); if (!b) return; s.tax = Number(segPick(b)); save(); draw(); },
  });
}

// ── 📊 定期定額試算（/api/dca_calc） ──
// 200 也可能是 {error:'no data'|'not enough data'} → 當空狀態，不當錯誤。
function renderDca(view, rest) {
  const saved = store.get('v2.tools.dca', {}) || {};
  const s = { code: normCode(rest[0] || saved.code || ''), amount: saved.amount || 3000, months: saved.months || 12 };
  let alive = true, seq = 0, last = null, expanded = false;
  const out = () => (alive ? view.querySelector('#d-out') : null);
  paint(view, `${backbar(TOOLS.dca)}
    <div class="card">
      <div class="col"><label class="xs dim" for="d-code">股票代碼</label><input id="d-code" class="input num" inputmode="numeric" autocomplete="off" enterkeyhint="go" placeholder="例如 2330、0056" value="${esc(s.code)}"></div>
      <div class="col mt3"><label class="xs dim" for="d-amt">每月投入 (元)</label><input id="d-amt" class="input num" inputmode="numeric" autocomplete="off" enterkeyhint="go" placeholder="3000" value="${esc(s.amount)}"></div>
      <div class="row between mt3"><span class="sm dim">投入月數</span>${segHtml('months', [[6, '6 個月'], [12, '12 個月'], [24, '24 個月'], [36, '36 個月']], s.months)}</div>
      <button type="button" class="btn primary block mt3" data-act="run">開始試算</button>
      <div class="note mt2">以每月第一個交易日收盤價模擬買進，最多回看 36 個月；未計手續費。</div>
    </div>
    <div id="d-out" class="mt3"></div>
    ${disclaimer('歷史模擬不代表未來報酬，不構成投資建議')}`);

  function draw(d, code) {
    const el = out(); if (!el) return;
    if (!d || typeof d !== 'object' || Array.isArray(d)) { paint(el, `<div class="card">${emptyState('😵', '回傳格式不正確，請稍後再試')}</div>`); return; }
    if (d.error) {
      const msg = d.error === 'no data' ? `找不到 ${esc(code)} 的歷史資料，請確認代碼` : d.error === 'not enough data' ? '歷史資料不足，至少需要 2 個月的收盤價' : (ERR_TXT[d.error] || esc(String(d.error)));
      paint(el, `<div class="card">${emptyState('🔍', msg)}</div>`); return;
    }
    const recs = Array.isArray(d.records) ? d.records.filter(r => r && r.month) : [];
    const shown = expanded ? recs : recs.slice(-12);
    const profit = num(d.profit), pct = num(d.profit_pct);
    paint(el, `<div class="card">
      <a class="row between" href="${stockHref(d.code || code)}"><div class="grow">${ident({ name: d.name, code: d.code || code })}<div class="xs dim mt1">每月 <span class="num">${fmtInt(d.monthly_amount)}</span> 元 × <span class="num">${fmtInt(d.months)}</span> 個月</div></div><div class="pricebox num"><div class="xs dim">現價</div><div class="px">${fmtPrice(d.current_price)}</div></div></a>
      <div class="mt3">${tiles([
        { k: '累計投入 (元)', v: fmtInt(d.total_invested) },
        { k: '目前市值 (元)', v: fmtInt(d.current_value) },
        { k: '損益 (元)', v: signInt(profit), cls: cls(profit) },
        { k: '報酬率', v: signPct(pct), cls: cls(pct) },
        { k: '平均成本', v: fmtPrice(d.avg_cost) },
        { k: '持有股數', v: fmtDec(d.total_shares, 2) },
      ])}</div>
      ${recs.length ? `<div class="hairline"></div>
        <div class="row between xs dim"><span>月份 · 當月買進價</span><span>買進股數 · 累計市值</span></div>
        <div class="list">${shown.map(r => `<div class="li"><div class="grow"><b class="num">${esc(r.month)}</b> <span class="xs dim">@ <span class="num">${fmtPrice(r.price)}</span></span></div><div class="right num"><div>${fmtDec(r.shares, 2)} 股</div><div class="xs dim">${fmtInt(r.value)} 元</div></div></div>`).join('')}</div>
        ${recs.length > shown.length ? `<button type="button" class="btn block mt2" data-act="expand">顯示全部 ${recs.length} 個月</button>` : ''}` : ''}
    </div>`);
  }
  async function run() {
    const codeEl = view.querySelector('#d-code'), amtEl = view.querySelector('#d-amt');
    const code = normCode(codeEl && codeEl.value);
    const amount = Math.round(num(String(amtEl ? amtEl.value : '').replace(/,/g, '')) ?? 0);
    if (!CODE_RE.test(code)) { toast('請輸入正確的股票代碼', 'err'); if (codeEl) codeEl.focus(); return; }
    if (!(amount >= 100)) { toast('每月金額至少 100 元', 'err'); if (amtEl) amtEl.focus(); return; }
    const months = Math.min(36, Math.max(1, Number(s.months) || 12));
    Object.assign(s, { code, amount, months }); store.set('v2.tools.dca', s);
    const my = ++seq; expanded = false;
    const el = out(); if (!el) return;
    paint(el, `${skCards(1)}<div class="note mt2 center">取得歷史資料中，約 3–10 秒…</div>`);
    let d;
    try { d = await get(`/api/dca_calc?code=${encodeURIComponent(code)}&amount=${amount}&months=${months}`, { ttl: 300000, timeout: 40000 }); }
    catch (e) { if (alive && my === seq) paint(out(), failCard(e)); return; }
    if (!alive || my !== seq) return;
    last = { d, code }; draw(d, code);
  }
  const off = listen(view, {
    click: (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'months') { s.months = Number(segPick(b)); store.set('v2.tools.dca', s); }
      else if (a === 'run') run();
      else if (a === 'expand' && last) { expanded = true; draw(last.d, last.code); }
    },
    keydown: (e) => { if (e.key === 'Enter' && e.target.matches && e.target.matches('#d-code, #d-amt')) { e.preventDefault(); e.target.blur(); run(); } },
  });
  if (rest[0] && CODE_RE.test(s.code)) run();   // #/tools/dca/2330 → 直接算
  return () => { alive = false; off(); };
}

// ── 📈 多股回測（/api/backtest） ──
function renderBacktest(view, rest) {
  const saved = store.get('v2.tools.bt', {}) || {};
  const s = { codes: rest[0] || saved.codes || '', months: [3, 6, 12].includes(Number(saved.months)) ? Number(saved.months) : 6 };
  let alive = true, seq = 0; const charts = [];
  const out = () => (alive ? view.querySelector('#b-out') : null);
  const killCharts = () => { for (const c of charts.splice(0)) { try { c.destroy(); } catch {} } };
  const mine = holdings.stocks().map(x => normCode(x && x.code)).filter(c => CODE_RE.test(c)).slice(0, 5);
  paint(view, `${backbar(TOOLS.backtest)}
    <div class="card">
      <div class="col"><label class="xs dim" for="b-codes">股票代碼（逗號分隔，最多 5 檔）</label><input id="b-codes" class="input" inputmode="text" autocomplete="off" enterkeyhint="go" placeholder="例如 2330, 2317, 0050" value="${esc(s.codes)}"></div>
      <div class="row between mt3"><span class="sm dim">回測期間</span>${segHtml('months', [[3, '3 個月'], [6, '6 個月'], [12, '12 個月']], s.months)}</div>
      <div class="row mt3"><button type="button" class="btn primary grow" data-act="run">開始回測</button>${mine.length ? `<button type="button" class="btn" data-act="fill">帶入持股</button>` : ''}</div>
      <div class="note mt2">報酬以區間第一個交易日收盤價為基準；最大回撤＝期間最高價到最低價的跌幅。</div>
    </div>
    <div id="b-out" class="mt3"></div>
    ${disclaimer('歷史模擬未含手續費與滑價，過去績效不代表未來，不構成投資建議')}`);

  function draw(data, codes, months) {
    const el = out(); if (!el) return;
    const rows = Array.isArray(data) ? data.filter(r => r && r.code) : [];
    if (!rows.length) { paint(el, `<div class="card">${emptyState('🔍', data && data.error ? (ERR_TXT[data.error] || esc(String(data.error))) : '找不到這些代碼的歷史資料，請確認代碼')}</div>`); return; }
    const missing = codes.filter(c => !rows.some(r => normCode(r.code) === c));
    const lw = !!window.LightweightCharts;
    paint(el, sectionHead(`近 ${months} 個月報酬排行`, { sub: '依區間報酬排序' }) + rows.map((r, i) => {
      const pts = Array.isArray(r.chart) ? r.chart : [];
      const chartMsg = !lw ? '圖表元件尚未載入' : pts.length < 2 ? '資料點不足，無法畫曲線' : '';
      return `<div class="card">
        <a class="row between" href="${stockHref(r.code)}"><span class="rank">${i + 1}</span><div class="grow">${ident(r)}<div class="xs dim mt1"><span class="num">${fmtInt(r.data_points)}</span> 個交易日</div></div>${pctPill(r.total_return)}</a>
        <div class="mt3">${tiles([
          { k: '區間報酬', v: signPct(r.total_return), cls: cls(r.total_return) },
          { k: '最大回撤', v: signPct(r.max_drawdown), cls: cls(r.max_drawdown) },
          { k: '起始價', v: fmtPrice(r.start_price) },
          { k: '期末價', v: fmtPrice(r.end_price) },
        ])}</div>
        <div class="xs dim mt2">期間最高 <span class="num">${fmtPrice(r.max_price)}</span> · 最低 <span class="num">${fmtPrice(r.min_price)}</span> · 曲線＝相對起始價的累計漲跌幅</div>
        <div class="eqchart mt2" data-ch="${i}">${chartMsg ? `<div class="empty sm">${chartMsg}</div>` : ''}</div>
      </div>`; }).join('')
      + (missing.length ? `<div class="note mt3">找不到資料：${missing.map(esc).join('、')}（代碼錯誤，或該股歷史資料抓不到）</div>` : ''));
    if (!lw) return;
    rows.forEach((r, i) => {
      const pts = (Array.isArray(r.chart) ? r.chart : []).map(p => ({ date: p && p.date, cum: num(p && p.pct) })).filter(p => p.date && p.cum !== null);
      const box = el.querySelector(`[data-ch="${i}"]`); if (!box || pts.length < 2) return;
      const h = mountEquity(box, pts); if (h) charts.push(h);
    });
  }
  async function run() {
    const inp = view.querySelector('#b-codes');
    const { codes, over, bad } = normCodes(inp ? inp.value : '');
    if (!codes.length) { toast('請輸入至少 1 個股票代碼', 'err'); if (inp) inp.focus(); return; }
    if (bad.length) toast(`略過不像代碼的：${bad.slice(0, 3).join('、')}`);
    else if (over) toast('最多 5 檔，已取前 5 檔');
    const months = s.months;
    Object.assign(s, { codes: codes.join(',') }); store.set('v2.tools.bt', s); if (inp) inp.value = s.codes;
    const my = ++seq; killCharts();
    const el = out(); if (!el) return;
    paint(el, `${skCards(codes.length)}<div class="note mt2 center">抓 ${codes.length} 檔歷史資料中，約 5–15 秒…</div>`);
    let data;
    try { data = await get(`/api/backtest?codes=${encodeURIComponent(codes.join(','))}&months=${months}`, { ttl: 300000, timeout: 60000 }); }
    catch (e) { if (alive && my === seq) paint(out(), failCard(e)); return; }
    if (!alive || my !== seq) return;
    draw(data, codes, months);
  }
  const off = listen(view, {
    click: (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'months') { s.months = Number(segPick(b)); store.set('v2.tools.bt', s); }
      else if (a === 'run') run();
      else if (a === 'fill') { const inp = view.querySelector('#b-codes'); if (inp) inp.value = mine.join(','); run(); }
    },
    keydown: (e) => { if (e.key === 'Enter' && e.target.id === 'b-codes') { e.preventDefault(); e.target.blur(); run(); } },
  });
  if (rest[0]) run();   // #/tools/backtest/2330,2317 → 直接跑
  return () => { alive = false; off(); killCharts(); };
}

// ── 📅 除權息日曆（/api/dividend） ──
// 依日期分組（升冪）、每 30 檔分頁；「我的」= API watched（server watchlist）或本機持股。
const PAGE = 30;
const TYPE_KIND = { '權息': ['除權息', 'purple'], '權': ['除權', 'info'], '息': ['除息', 'gold'] };
function typeChip(type) {
  const t = String(type || '').trim();
  const hit = TYPE_KIND[t] || (t.includes('權') && t.includes('息') ? TYPE_KIND['權息'] : t.includes('權') ? TYPE_KIND['權'] : t.includes('息') ? TYPE_KIND['息'] : null);
  return hit ? chip(hit[0], hit[1]) : (t ? chip(esc(t)) : '');
}
function renderDividend(view) {
  const st = { mine: !!(store.get('v2.tools.div', {}) || {}).mine, limit: PAGE };
  let alive = true, all;   // undefined = 載入中, null = 抓不到, [] = 無資料
  const myCodes = new Set(holdings.stocks().map(x => normCode(x && x.code)).filter(Boolean));
  paint(view, `${backbar(TOOLS.dividend)}
    <div class="row between mb3"><span class="sm dim" id="v-count">近 3 個月</span>${segHtml('filter', [['all', '全部'], ['mine', '只看我的']], st.mine ? 'mine' : 'all')}</div>
    <div id="v-out">${skCards(3)}</div>
    ${disclaimer('資料來源 TWSE 除權息預告（上市公司），不構成投資建議')}`);

  const row = (x) => stockRow({ code: x.code, name: x.name }, { right: `${x.mine ? chip('★ 我的', 'gold') + ' ' : ''}${typeChip(x.type)}` });
  function head(g) {
    if (!g.d) return sectionHead(String(g.date || '—'), { sub: `${g.rows.length} 檔` });
    const diff = g.rows[0].diff;
    const rel = diff === 0 ? '今天' : diff === 1 ? '明天' : diff > 1 ? `${diff} 天後` : diff < 0 ? `${-diff} 天前` : '';
    return sectionHead(`${g.d.getMonth() + 1}/${g.d.getDate()}（週${'日一二三四五六'[g.d.getDay()]}）`, { sub: `${rel ? rel + ' · ' : ''}${g.rows.length} 檔` });
  }
  function draw() {
    const el = view.querySelector('#v-out'), cnt = view.querySelector('#v-count'); if (!el) return;
    if (all === undefined) { paint(el, skCards(3)); return; }
    if (all === null) { paint(el, `<div class="card">${emptyState('😵', '除權息資料暫時抓不到', '<button type="button" class="btn sm" data-act="retry">重試</button>')}</div>`); return; }
    const mineN = all.filter(x => x.mine).length;
    if (cnt) cnt.textContent = `近 3 個月 ${all.length} 檔 · 我的 ${mineN} 檔`;
    const rows = st.mine ? all.filter(x => x.mine) : all;
    if (!rows.length) {
      paint(el, `<div class="card">${st.mine
        ? emptyState('★', all.length ? '你的持股／關注近 3 個月沒有除權息' : '近 3 個月沒有除權息資料', '<a class="btn sm" href="#/portfolio">管理持股 ›</a>')
        : emptyState('📅', '近 3 個月沒有除權息資料')}</div>`);
      return;
    }
    const shown = rows.slice(0, st.limit);
    const groups = [];   // 已排序 → 相鄰同日即同組
    for (const x of shown) {
      const key = x.d ? x.d.toDateString() : String(x.date);
      const g = groups[groups.length - 1];
      if (g && g.key === key) g.rows.push(x); else groups.push({ key, d: x.d, date: x.date, rows: [x] });
    }
    paint(el, groups.map(g => `<div class="section">${head(g)}<div class="card"><div class="list">${g.rows.map(row).join('')}</div></div></div>`).join('')
      + (rows.length > shown.length ? `<button type="button" class="btn block mt3" data-act="more">顯示更多（還有 ${rows.length - shown.length} 檔）</button>` : ''));
  }
  async function load() {
    let list;
    try { list = await get('/api/dividend', { ttl: 600000, timeout: 20000 }); } catch { list = null; }
    if (!alive) return;
    if (!Array.isArray(list)) { all = list === null ? null : []; draw(); return; }   // {error:…} 或非陣列 → 視為無資料
    const today = twNow(); today.setHours(0, 0, 0, 0);
    all = list.filter(x => x && x.code).map(x => {
      const code = normCode(x.code), d = parseDay(x.date);
      return { ...x, code, d, diff: d ? Math.round((d - today) / 86400000) : null, mine: myCodes.has(code) };   // 不用後端 watched（Vercel 上是預設 4 檔清單）
    }).sort((a, b) => (a.d && b.d) ? a.d - b.d : a.d ? -1 : b.d ? 1 : String(a.date).localeCompare(String(b.date)));
    draw();
  }
  const off = listen(view, {
    click: (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const a = b.dataset.act;
      if (a === 'filter') { st.mine = segPick(b) === 'mine'; st.limit = PAGE; store.set('v2.tools.div', { mine: st.mine }); draw(); }
      else if (a === 'more') { st.limit += PAGE; draw(); }
      else if (a === 'retry') { all = undefined; draw(); load(); }
    },
  });
  load();
  return () => { alive = false; off(); };
}
