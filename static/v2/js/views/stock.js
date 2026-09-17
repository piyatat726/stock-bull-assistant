// 台股小牛 v2 — 個股詳情 #/stock/:code[/tab]（唯一的個股頁；取代舊版 查詢／訊號／K線 三個渲染器）。
// 結構：返回列 → 即時報價 → 子分頁 總覽｜K線｜籌碼｜新聞｜預測。
// 總覽採「股票觀察」參考版面：插畫 hero → 為什麼關注／證據是什麼／需要注意／下一個觀察點
//   → 一顆主要 CTA（加入持股）→ 把判斷依據攤開的詳細卡（綜合判斷、技術訊號、巴菲特、存股、基本面、AI 體檢）。
// 原則：stock_signal（慢，10–30 秒）只打一次、各分頁共用；報價／預測／新聞／籌碼各自載入、各自 skeleton、互不阻塞；
//   K 線只在切到該分頁才掛載，離開分頁或 teardown 一律 destroy。
// 顏色：價格／漲跌／買賣超 = 紅漲綠跌（cls）；判斷（進場／觀望／好公司）= judge() 徽章或 hero tag，不用漲跌色。
import { render as paint, esc, num, cls, signPct, fmtPrice, fmtInt, skLines, skCards, timeAgo, marketOpen, store, toast } from '../ui.js';
import { API, get, ApiError } from '../api.js';
import { chip, judge, emptyState, planBar, tiles, stockHref, mkTag, addHolding, openAlertSheet, holdings, stockHero, observeRows } from '../components.js';
import { normalizeCandles, mountKLine } from '../chart.js';

// ── constants ──
const TABS = [['overview', '總覽'], ['kline', 'K線'], ['chip', '籌碼'], ['news', '新聞'], ['predict', '預測']];
const TAB_KEYS = new Set(TABS.map(t => t[0]));
const TAB_ALIAS = { signals: 'overview', chart: 'kline', chips: 'chip', k: 'kline' };   // observeRows() 連結用 /signals /chart /predict
const PERIODS = [['1M', 1], ['3M', 3], ['6M', 6], ['1Y', 12]];
// 判斷 → 徽章種類（判斷永遠用 icon+文字徽章，不用漲跌色）
const VERDICT_KIND = { '強力進場': 'ok', '建議進場': 'ok', '觀望為主': 'warn', '暫不進場': 'bad', '建議迴避': 'bad' };
// hero 白話標籤：[文字, 顏色種類]（'' = 進場觀察 mint；warn = 金）
const VERDICT_TAG = { '強力進場': ['進場觀察', 'ok', '🎯'], '建議進場': ['進場觀察', 'ok', '🎯'], '觀望為主': ['觀望', 'warn', '🟡'], '暫不進場': ['暫不進場', 'bad', '🟠'], '建議迴避': ['建議迴避', 'bad', '🔴'] };   // 判斷徽章＝icon＋文字，不用漲跌色
const ICON_KIND = { '🎩': 'ok', '🟢': 'ok', '🏆': 'ok', '💰': 'ok', '🟡': 'warn', '📉': 'warn', '🟠': 'bad', '🔴': 'bad', '⚠️': 'bad', '📅': 'neutral', '⚪': 'neutral' };
const CHIP_STATUS_KIND = { green: 'ok', gold: 'ok', gray: 'neutral', orange: 'warn', red: 'bad' };
const TREND_TXT = { growing: '📈 股利成長', shrinking: '📉 股利縮水', stable: '➡️ 配息平穩' };
const HIST_OPTS = { ttl: 300000, timeout: 30000 };

// ── private helpers ──
const card = (inner, k = '') => `<div class="card${k ? ' ' + k : ''}">${inner}</div>`;
const cleanNum = (v) => num(String(v ?? '').replace(/,/g, ''));
const safeUrl = (u) => /^https?:\/\//i.test(String(u || '')) ? esc(u) : '';
const kindOf = (icon, fallback = 'neutral') => ICON_KIND[icon] || fallback;
/** 帶正負號的整數（買超紅／賣超綠 = 方向色） */
const signed = (v, unit = '') => { const n = num(v); return n === null ? '<span class="num flat">—</span>' : `<span class="num ${cls(n)}">${n > 0 ? '+' : ''}${fmtInt(n)}${unit}</span>`; };
const pct1 = (v) => { const n = num(v); return n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`; };
/** 產業插畫（純示意）：依代碼區間＋名稱關鍵字猜產業，只影響 hero 的 emoji，不影響任何數據 */
function sectorArt(code, name = '') {
  const c = String(code || ''), n = String(name || '');
  if (/^(28|58)\d{2}$/.test(c) || /金控|銀行|保險|人壽|證券|票券/.test(n)) return '🏦';
  if (/^26\d{2}$/.test(c) || /航運|海運|航空|長榮|陽明|萬海|裕民|慧洋|華航/.test(n)) return '🚢';
  if (/半導體|積電|聯電|聯發|聯詠|瑞昱|矽|晶|封測|日月光|世芯|創意|力旺|穩懋|南亞科|旺宏|華邦|光罩|京元/.test(n)) return '🔲';
  if (/^41\d{2}$/.test(c) || /生技|生醫|製藥|醫|藥|生物|健康/.test(n)) return '🧬';
  if (/^(23|24|3[0-6]|6[1-9]|80)\d{2}$/.test(c) || /電|科|光|鴻海|廣達|緯|英業達|仁寶|和碩|網|通|訊|微|智/.test(n)) return '💻';
  return '📈';
}
/** lightweight-charts 由 index.html 以 defer 載入，可能比本模組晚到 → 最多等 6 秒 */
function waitForLW(ms = 6000) {
  return new Promise(res => {
    const t0 = Date.now();
    (function tick() { if (window.LightweightCharts) return res(true); if (Date.now() - t0 > ms) return res(false); setTimeout(tick, 120); })();
  });
}
/** 訊號列：icon · 類型／說明 · 權重 chip（多方 up／空方 down） */
function signalRows(list, emptyText) {
  const rows = (Array.isArray(list) ? list : []).filter(s => s && (s.type || s.desc));
  if (!rows.length) return `<div class="note">${emptyText}</div>`;
  return `<div class="list">${rows.map(s => {
    const w = num(s.weight); const bull = s.bullish !== false;
    return `<div class="li"><span class="lg">${esc(s.icon || '')}</span><div class="grow"><div class="sm b">${esc(s.type || '')}</div><div class="xs dim">${esc(s.desc || '')}</div></div><div class="right">${w !== null ? chip(`${w > 0 ? '+' : ''}${w}`, bull ? 'up' : 'down') : ''}</div></div>`;
  }).join('')}</div>`;
}
/** 每日法人買賣超（張）：日期 · mbar · 合計；次行 外資／投信。rows 需為新→舊。 */
function dailyRows(rows) {
  const max = Math.max(1, ...rows.map(r => Math.abs(num(r.total) || 0)));
  return `<div class="list mt2">${rows.map(r => {
    const t = num(r.total) || 0; const w = Math.min(100, Math.abs(t) / max * 100);
    return `<div class="li"><span class="xs dim num">${esc(r.date || '')}</span><div class="grow"><div class="mbar"><i class="${t > 0 ? 'up' : 'down'}" style="width:${w.toFixed(0)}%"></i></div><div class="xs dim mt1">外資 ${signed(r.foreign)} · 投信 ${signed(r.trust)}</div></div><div class="right b">${signed(t)}</div></div>`;
  }).join('')}</div>`;
}
function planNotes(s) {
  const parts = [];
  if (s.entry_note) parts.push(`進場：${esc(s.entry_note)}`);
  if (s.stop_note) parts.push(`停損：${esc(s.stop_note)}${num(s.stop_pct) !== null ? `（−${s.stop_pct}%）` : ''}`);
  if (s.target_note) parts.push(`目標：${esc(s.target_note)}${num(s.target_pct) !== null ? `（+${s.target_pct}%）` : ''}`);
  return parts.length ? `<div class="note mt2">${parts.join(' · ')}</div>` : '';
}
function indLine(s) {
  const p = [];
  if (num(s.rsi) !== null) p.push(`RSI ${s.rsi}`);
  if (num(s.k) !== null) p.push(`K ${s.k} D ${s.d ?? '—'}`);
  if (num(s.macd_hist) !== null) p.push(`MACD柱 ${num(s.macd_hist) > 0 ? '+' : ''}${s.macd_hist}`);
  return p.length ? `<span class="xs dim num">${p.join(' · ')}</span>` : '';
}
function maLine(s) {
  const ma = s.ma && typeof s.ma === 'object' ? Object.entries(s.ma).filter(([, v]) => num(v) !== null) : [];
  if (!ma.length) return '';
  const price = num(s.price);
  return `<div class="chips mt3">${ma.map(([k, v]) => chip(`${esc(k.toUpperCase())} <b class="num">${fmtPrice(v)}</b>${price !== null ? (price >= v ? ' ▲' : ' ▼') : ''}`)).join('')}</div><div class="note mt1">▲ 現價在均線上方 ▼ 在下方</div>`;
}
function buffettCard(b, s) {
  if (!b || !b.available) return '';
  const chips = [];
  if (num(b.roe) !== null) chips.push(chip(`ROE ${b.roe}%${b.roe_est ? '（年化估）' : ''}`));
  if (num(s.pe) !== null) chips.push(chip(`PE ${s.pe}`));
  if (num(s.pb) !== null) chips.push(chip(`PB ${s.pb}`));
  if (num(s.dividend_yield) !== null) chips.push(chip(`殖利率 ${s.dividend_yield}%`));
  const mos = num(b.margin_of_safety);
  const fair = num(b.fair_price) !== null
    ? `<div class="row between mt3"><div><div class="xs dim">參考合理價</div><div class="lg b num">${fmtPrice(b.fair_price)}</div></div><div class="xs dim">vs 現價 <b class="num">${fmtPrice(s.price)}</b></div>${mos !== null ? judge(mos >= 0 ? `低估 ${mos}%` : `偏貴 ${Math.abs(mos)}%`, mos >= 0 ? 'ok' : 'warn', mos >= 0 ? '💎' : '💸') : ''}</div>` : '';
  const pros = (b.pros || []).map(p => `<li>✅ ${esc(p)}</li>`).join('');
  const cons = (b.cons || []).map(p => `<li>⚠️ ${esc(p)}</li>`).join('');
  return card(`<div class="stitle"><h2>🎩 巴菲特觀點 <span class="sub">長期價值</span></h2>${num(b.score) !== null ? `<span class="num b">${b.score}<span class="xs dim">/100</span></span>` : ''}</div>
    <div class="chips">${judge(b.verdict || '—', kindOf(b.verdict_icon), b.verdict_icon || '')}${b.limited ? chip('財報資料有限') : ''}</div>
    ${b.verdict_desc ? `<div class="why mt2">${esc(b.verdict_desc)}</div>` : ''}
    ${chips.length ? `<div class="chips mt2">${chips.join('')}</div>` : ''}
    ${fair}
    ${pros || cons ? `<ul class="why">${pros}${cons}</ul>` : ''}
    <div class="note mt2">合理價為簡易估算；價值投資看重長期持有與安全邊際，不是短線進出依據。</div>`);
}
function dividendCard(q) {
  if (!q || !q.verdict) return '';
  const chips = [chip(`連續配息 ${q.consec_capped ? '≥' : ''}${q.consecutive_years ?? '—'} 年`)];
  if (num(q.yield) !== null) chips.push(chip(`殖利率 ${q.yield}%`));
  if (num(q.payout_ratio) !== null) chips.push(chip(`配息率 ${q.payout_ratio}%`));
  if (num(q.ttm_dividend) !== null) chips.push(chip(`近一年配 ${q.ttm_dividend} 元`));
  if (TREND_TXT[q.trend]) chips.push(chip(TREND_TXT[q.trend]));
  const notes = (q.notes || []).map(n => `<li>${esc(n)}</li>`).join('');
  return card(`<div class="stitle"><h2>💰 存股評估 <span class="sub">配息領息角度</span></h2>${num(q.score) !== null ? `<span class="num b">${q.score}<span class="xs dim">/100</span></span>` : ''}</div>
    <div class="chips">${judge(q.verdict, kindOf(q.verdict_icon), q.verdict_icon || '')}${chips.join('')}</div>
    ${q.verdict_desc ? `<div class="why mt2">${esc(q.verdict_desc)}</div>` : ''}
    ${notes ? `<ul class="why">${notes}</ul>` : ''}`);
}
function fundCard(s) {
  const chips = [];
  if (num(s.pe) !== null) chips.push(chip(`PE ${s.pe}`));
  if (num(s.pb) !== null) chips.push(chip(`PB ${s.pb}`));
  if (num(s.dividend_yield) !== null) chips.push(chip(`殖利率 ${s.dividend_yield}%`));
  if (num(s.rev_yoy) !== null) chips.push(chip(`營收年增 <span class="num ${cls(s.rev_yoy)}">${pct1(s.rev_yoy)}</span>`));
  if (num(s.rev_mom) !== null) chips.push(chip(`月增 <span class="num ${cls(s.rev_mom)}">${pct1(s.rev_mom)}</span>`));
  const roe = s.buffett ? num(s.buffett.roe) : null;
  if (roe !== null) chips.push(chip(`ROE ${s.buffett.roe}%`));
  const sigs = Array.isArray(s.fundamental) ? s.fundamental : [];
  if (!chips.length && !sigs.length) return '';
  return card(`<div class="stitle"><h2>📊 基本面</h2>${num(s.fund_score) !== null ? `<span class="xs dim">基本面分 <b class="num">${s.fund_score}</b></span>` : ''}</div>
    ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}
    <div class="mt2">${signalRows(sigs, '無明顯基本面訊號')}</div>`);
}
function chipFullCard(d) {
  const daily = Array.isArray(d.daily) ? [...d.daily].reverse() : [];   // API 舊→新，畫面統一新→舊
  const m = d.margin && typeof d.margin === 'object' && Object.keys(d.margin).length ? d.margin : null;
  const streak = num(d.consecutive_buy) > 0 ? chip(`連 ${d.consecutive_buy} 日買超`, 'gold') : num(d.consecutive_sell) > 0 ? chip(`連 ${d.consecutive_sell} 日賣超`) : '';
  const totals = tiles([{ k: '外資累計', v: signed(d.total_foreign) }, { k: '投信累計', v: signed(d.total_trust) }, { k: '法人合計', v: signed(d.total_net) }]);
  const marginT = m ? `<div class="xs dim mt3 mb2">融資券（張）</div>` + tiles([
    { k: '融資餘額', v: `${fmtInt(m.margin_balance)}<div class="xs">${signed(m.margin_change)}</div>` },
    { k: '融券餘額', v: `${fmtInt(m.short_balance)}<div class="xs">${signed(m.short_change)}</div>` },
  ]) : '';
  const ins = (Array.isArray(d.insights) ? d.insights : []).map(i => `<li>${esc(i)}</li>`).join('');
  return card(`<div class="stitle"><h2>🔍 完整籌碼分析 <span class="sub">近 ${daily.length} 日 · 張</span></h2><span class="xs dim">集中度 <b class="num">${num(d.chip_score) !== null ? d.chip_score : '—'}</b></span></div>
    <div class="chips">${judge(d.status || '—', CHIP_STATUS_KIND[d.status_color] || kindOf(d.status_icon), d.status_icon || '')}${streak}</div>
    <div class="mt3">${totals}</div>
    ${daily.length ? dailyRows(daily) : `<div class="note mt2">近 10 日無法人買賣超資料（上櫃股不在證交所 T86 名單內）。</div>`}
    ${marginT}
    ${ins ? `<ul class="why">${ins}</ul>` : ''}`, 'mt3');
}

export async function render(view, params = []) {
  const code = String(params[0] || '').trim().toUpperCase();
  if (!code || !/^[0-9A-Z]{4,7}$/.test(code)) { paint(view, emptyState('🔍', code ? `「${esc(code.slice(0, 12))}」不是有效的股票代碼` : '沒有指定股票代碼', `<a class="btn" href="#/home">回首頁</a>`)); return null; }

  // ── state ──
  let alive = true, timer = null;
  let market = 'tse';                                   // 先猜上市；realtime／historical 空值就退回上櫃
  const meta = { name: '', market: '' };
  let quote = { status: 'loading', data: null };        // /api/realtime 列
  let sig = { status: 'loading', data: null, msg: '' }; // /api/stock_signal（一次，各分頁共用）
  let pred = { status: 'idle', data: null };            // /api/predict（總覽／K線／預測分頁載）
  let weather = { status: 'idle', data: null };         // /api/market_weather（補 n 與此格局勝率）
  let news = { status: 'idle', data: [], fallback: false };
  let chain = { status: 'idle', data: null };
  let chipFull = { status: 'idle', data: null };
  let ai = { status: 'idle', html: '' };
  const resolveTab = (t) => { const k = TAB_ALIAS[t] || t; return TAB_KEYS.has(k) ? k : null; };
  let tab = resolveTab(params[1]) || resolveTab(store.get('stock_tab', 'overview')) || 'overview';
  let pendingScroll = params[1] === 'signals' ? 'sig-card' : null;   // 深連結到訊號卡 → 分析載完再捲過去
  let months = Number(store.get('stock_kperiod', 6)); if (!PERIODS.some(p => p[1] === months)) months = 6;
  let chart = null, chartToken = 0;
  const chartCache = new Map();                         // months → candles
  const slot = (id) => (alive ? view.querySelector('#' + id) : null);
  const prevTitle = document.title;

  // ── header: 返回列 + 報價 ──
  // 名稱未知時只顯示代碼一次（避免「9999 9999」）
  const titleHtml = () => meta.name ? `${esc(meta.name)} <span class="xs dim">${esc(code)}${meta.market ? ` · ${mkTag(meta.market)}` : ''}</span>` : `${esc(code)}${meta.market ? ` <span class="xs dim">${mkTag(meta.market)}</span>` : ''}`;
  const holdLabel = () => holdings.has(code) ? '✓ 已持股' : '💼 加持股';
  function priceHtml() {
    const s = sig.data;
    const q = quote.data || (s && num(s.price) !== null ? { price: s.price, change: s.change, change_pct: s.change_pct, fromSignal: true } : null);
    if (!q) {
      if (quote.status === 'loading') return `<div class="row between"><div class="grow">${skLines(2)}</div><div class="sk sk-line" style="width:96px;height:40px">.</div></div>`;
      return `<div class="note">即時報價暫時無法取得${sig.status === 'loading' ? '，分析完成後會補上分析時價格' : ''}。</div>`;
    }
    const c = cls(q.change_pct), ch = num(q.change);
    const status = q.fromSignal ? chip('分析時價格') : q.traded === false ? chip('試撮／昨收', 'warn') : marketOpen() ? `<span class="live" aria-hidden="true"></span> 即時` : '收盤';
    const when = q.time ? esc(String(q.time).slice(0, 5)) : q.date ? esc(String(q.date)) : '';
    const ohlc = q.fromSignal ? '' : `<div class="xs dim mt2 num">開 <b>${fmtPrice(q.open)}</b> · 高 <b>${fmtPrice(q.high)}</b> · 低 <b>${fmtPrice(q.low)}</b> · 昨收 <b>${fmtPrice(q.yesterday)}</b> · 量 <b>${fmtInt(cleanNum(q.volume))}</b> 張</div>`;
    return `<div class="row between"><div class="grow"><div class="xs dim">${status}${when ? ` · ${when}` : ''}</div>${ohlc}</div>
      <div class="pricebox num"><div class="x2 b ${c}">${fmtPrice(q.price)}</div><div class="ch ${c}">${ch !== null ? `${ch > 0 ? '+' : ''}${fmtPrice(ch)} ` : ''}${signPct(q.change_pct)}</div></div></div>`;
  }
  function paintHead() {
    const t = slot('st-title'); if (t) paint(t, titleHtml());
    const p = slot('st-price'); if (p) paint(p, priceHtml());
    const h = slot('st-hold'); if (h) h.textContent = holdLabel();
    document.title = `${meta.name ? `${meta.name} ${code}` : code} · 台股小牛`;
  }
  async function loadQuote(first) {
    try {
      let rows = await API.realtime([code], [market]);
      let q = Array.isArray(rows) ? rows.find(r => r && String(r.code).toUpperCase() === code) || rows[0] : null;
      if (!q && market === 'tse') {   // 上市查無 → 上櫃再試一次（fetch_stocks 也會自癒）
        rows = await API.realtime([code], ['otc']);
        q = Array.isArray(rows) ? rows[0] : null;
        if (q) market = 'otc';
      }
      if (!alive) return;
      if (q && num(q.price) !== null) {
        quote = { status: 'ok', data: q };
        if (q.name) meta.name = q.name;
        if (q.market === 'tse' || q.market === 'otc') market = q.market;
        meta.market = market;
      } else if (first) quote = { status: 'none', data: null };
    } catch { if (alive && first) quote = { status: 'none', data: null }; }
    if (!alive) return;
    paintHead();
    paintOv('ov-hero', heroHtml());
  }

  // ── stock_signal（一次；各分頁共用） ──
  function loadSignal() {
    sig = { status: 'loading', data: null, msg: '' };
    if (tab === 'overview' || tab === 'chip') paintPane();
    API.signal(code).then(s => {
      if (!alive) return;
      if (!s || typeof s !== 'object' || s.error) {   // HTTP-200 錯誤體（insufficient_data）→ 空狀態
        sig = { status: s && s.error === 'insufficient_data' ? 'insufficient' : 'error', data: null, msg: (s && (s.message || s.error)) || '' };
      } else {
        sig = { status: 'ok', data: s };
        if (!meta.name && s.name) meta.name = s.name;
        if (!meta.market && (s.market === 'tse' || s.market === 'otc')) { market = s.market; meta.market = market; }
      }
    }).catch(() => { if (alive) sig = { status: 'error', data: null, msg: '' }; })
      .finally(() => {
        if (!alive) return;
        paintHead();
        if (tab === 'overview') {
          paintOv('ov-hero', heroHtml()); paintOv('ov-rows', rowsHtml()); paintOv('ov-detail', detailHtml());
          if (pendingScroll) { scrollToId(pendingScroll); pendingScroll = null; }
        } else if (tab === 'chip') paintPane();
        else if (tab === 'kline') { if (chart && sig.data) mountChart(); else { const n = slot('k-note'); if (n) paint(n, overlayNote()); } }
      });
  }

  // ── 總覽（參考版面：hero → 觀察四列 → CTA → 詳細證據） ──
  /** hero 用的報價：優先即時，其次分析時價格；都沒有 → null */
  const heroQuote = () => {
    const q = quote.data, s = sig.data;
    if (q && num(q.price) !== null) return { code, name: q.name || meta.name || code, market: q.market || meta.market || '', price: q.price, change_pct: q.change_pct };
    if (s && num(s.price) !== null) return { code, name: s.name || meta.name || code, market: s.market || meta.market || '', price: s.price, change_pct: s.change_pct };
    return null;
  };
  /** 沒有 verdict_desc 時的一句即時摘要（皆為真實報價欄位） */
  function quoteLead() {
    const r = quote.data;
    if (r && r.traded === false) return '目前為試撮／昨收參考價，開盤成交後更新';
    if (r && num(r.open) !== null) return `今日開 <b class="num">${fmtPrice(r.open)}</b>・高 <b class="num">${fmtPrice(r.high)}</b>・低 <b class="num">${fmtPrice(r.low)}</b>，成交 <b class="num">${fmtInt(cleanNum(r.volume))}</b> 張`;
    return sig.status === 'loading' ? '綜合分析計算中，約需 10–30 秒' : '';
  }
  function heroHtml() {
    const q = heroQuote();
    if (!q) return quote.status === 'loading' ? `<div class="shero">${skLines(3)}</div>` : `<div class="shero"><div class="nm">${esc(meta.name || code)}${meta.name ? `<span class="dim sm"> ${esc(code)}</span>` : ''}</div><div class="lead">即時報價暫時無法取得</div></div>`;
    const s = sig.data;
    const [tag, tagKind, tagIcon] = s && Object.prototype.hasOwnProperty.call(VERDICT_TAG, s.verdict) ? VERDICT_TAG[s.verdict] : ['', '', ''];   // 分析未完成 → 不貼標籤
    const lead = s && s.verdict_desc ? esc(s.verdict_desc) : quoteLead();
    return stockHero(q, { tag, tagKind, tagIcon, lead, art: sectorArt(code, q.name) });
  }
  const rowSk = (ic, k) => `<div class="xrow"><div class="ic">${ic}</div><div class="grow"><div class="k">${k}</div><div class="sk sk-line" style="width:72%">.</div></div></div>`;
  function rowsHtml() {
    if (sig.status === 'loading') return rowSk('🎯', '為什麼關注') + rowSk('🧾', '證據是什麼') + rowSk('⚠️', '需要注意') + rowSk('🧭', '下一個觀察點');
    const s = sig.data || { error: sig.status === 'insufficient' ? 'insufficient_data' : 'unavailable' };   // observeRows 會顯示「資料不足」，不編造
    return observeRows(s, pred.data, heroQuote(), { code });
  }
  function ctaHtml() {
    if (holdings.has(code)) return `<button class="cta" disabled aria-disabled="true">✓ 已在持股中</button>
      <button class="btn block mt2" data-act="alert">🔔 設到價提醒</button>
      <div class="note center mt2">到 <a href="#/portfolio"><b>持股</b></a> 填成本與數量，小牛每天幫你健診</div>`;
    return `<button class="cta" data-act="hold">＋ 加入持股</button>`;
  }
  function detailHtml() {
    if (sig.status === 'loading') return card(skLines(5)) + `<div class="note mt2 center">全面分析中（技術＋基本面＋籌碼＋新聞），約需 10–30 秒。</div>`;
    if (sig.status === 'insufficient') return card(emptyState('📉', esc(sig.msg || '歷史資料不足，無法計算技術指標')));
    if (sig.status === 'error') return card(emptyState('😵', '個股分析暫時無法載入', `<button class="btn sm" data-act="retry-sig">重試</button>`));
    const s = sig.data;
    const kind = VERDICT_KIND[s.verdict] || kindOf(s.verdict_icon, 'warn');
    const bw = num(s.bullish_weight), rw = num(s.bearish_weight);
    const verdict = card(`<div class="stitle"><h2>🧭 綜合判斷</h2>${s.latest_date ? `<span class="sub">資料至 ${esc(s.latest_date)}</span>` : ''}</div>
      <div class="chips">${judge(s.verdict || '—', kind, s.verdict_icon || '')}${bw !== null ? chip(`多方 +${bw}`, 'up') : ''}${rw !== null ? chip(`空方 −${rw}`, 'down') : ''}${num(s.signal_count) !== null ? chip(`${s.signal_count} 個訊號`) : ''}</div>
      ${s.verdict_desc ? `<div class="why mt2">${esc(s.verdict_desc)}</div>` : ''}
      ${planBar({ entry: s.entry, stop_loss: s.stop_loss, target: s.target, risk_reward: s.risk_reward, price: num(quote.data && quote.data.price) ?? s.price })}
      ${planNotes(s)}`);
    const tech = `<div class="card" id="sig-card"><div class="stitle"><h2>📈 技術訊號</h2>${indLine(s)}</div>${signalRows(s.signals, '無明顯技術面訊號')}${maLine(s)}</div>`;
    return verdict + tech + buffettCard(s.buffett, s) + dividendCard(s.dividend_quality) + fundCard(s) + `<div class="card" id="ai-card">${aiInner()}</div>`;
  }
  function overviewPane() {
    return `<div id="ov-hero">${heroHtml()}</div>
      <div class="eyebrow mt4">WHY WATCH</div><div class="h-display">這檔，現在值得關注嗎？</div>
      <div id="ov-rows">${rowsHtml()}</div>
      <div id="ov-cta" class="mt4">${ctaHtml()}</div>
      <div class="eyebrow mt4">EVIDENCE</div><div class="h-display">判斷的依據，攤開來看</div>
      <div id="ov-detail">${detailHtml()}</div>`;
  }
  /** 只重繪總覽的某一格（避免整頁閃爍、保留 AI 結果與捲動位置） */
  function paintOv(id, html) { if (tab !== 'overview') return; const el = slot(id); if (el) paint(el, html); }

  // ── AI 體檢 ──
  function aiSummary(s) {
    const q = quote.data || {};
    const parts = [`現價 ${fmtPrice(num(q.price) ?? s.price)}（${signPct(num(q.change_pct) ?? s.change_pct)}）`];
    if (s.verdict) parts.push(`綜合評等：${s.verdict_icon || ''}${s.verdict}（多方 ${s.bullish_weight ?? 0} / 空方 ${s.bearish_weight ?? 0}）`);
    const f = [];
    if (num(s.pe) !== null) f.push(`PE ${s.pe}`);
    if (num(s.pb) !== null) f.push(`PB ${s.pb}`);
    if (num(s.dividend_yield) !== null) f.push(`殖利率 ${s.dividend_yield}%`);
    if (num(s.rev_yoy) !== null) f.push(`營收年增 ${s.rev_yoy}%`);
    if (f.length) parts.push('基本面：' + f.join('、'));
    const b = s.buffett;
    if (b && b.available) {
      const bb = [String(b.verdict || '')];
      if (num(b.roe) !== null) bb.push(`ROE ${b.roe}%`);
      if (num(b.fair_price) !== null) bb.push(`合理價 ${b.fair_price}${num(b.margin_of_safety) !== null ? `（${b.margin_of_safety >= 0 ? '低估' : '偏貴'} ${Math.abs(b.margin_of_safety)}%）` : ''}`);
      parts.push('巴菲特觀點：' + bb.filter(Boolean).join('、'));
    }
    const techs = (s.signals || []).map(x => x && x.type).filter(Boolean).slice(0, 6);
    if (techs.length) parts.push('技術訊號：' + techs.join('、'));
    const chips = (s.chip || []).map(x => x && x.type).filter(Boolean).slice(0, 3);
    if (chips.length) parts.push('籌碼訊號：' + chips.join('、'));
    parts.push(`評分 技術/基本/籌碼/散戶：${s.tech_score ?? 0}/${s.fund_score ?? 0}/${s.chip_score ?? 0}/${s.sent_score ?? 0}`);
    if (num(s.entry) !== null) parts.push(`建議進場 ${s.entry}｜停損 ${s.stop_loss}｜目標 ${s.target}（風報比 1:${s.risk_reward ?? '—'}）`);
    if (s.dividend_quality) parts.push(`存股：連配 ${s.dividend_quality.consec_capped ? '≥' : ''}${s.dividend_quality.consecutive_years} 年、${s.dividend_quality.verdict}`);
    const p = pred.data;
    if (p && Array.isArray(p.range5)) parts.push(`5 日統計區間 ${p.range5[0]}–${p.range5[1]}${num(p.stock_prob) !== null ? `、同類訊號回測勝率 ${p.stock_prob}%（${p.stock_n} 次）` : ''}`);
    return parts.join('\n');
  }
  function aiInner() {
    const busy = ai.status === 'loading';
    const label = busy ? '分析中（讀數據＋最新新聞，最長約 45 秒）…' : ai.html ? '🔄 再問一次' : '🤖 AI 體檢：這檔現在的狀況？';
    return `<div class="stitle"><h2>🤖 AI 體檢</h2><span class="sub">用本頁數據＋最新新聞</span></div>${ai.html ? `<div class="mb3">${ai.html}</div>` : ''}<button class="btn block" data-act="ai" ${busy ? 'disabled' : ''}>${label}</button>`;
  }
  const paintAI = () => { const el = slot('ai-card'); if (el) paint(el, aiInner()); };
  async function askAI() {
    const s = sig.data; if (!s) { toast('個股分析尚未完成，稍等一下再問'); return; }
    if (ai.status === 'loading') return;
    ai = { status: 'loading', html: ai.html }; paintAI();
    try {
      const d = await API.aiAnalysis(code, meta.name || s.name || code, aiSummary(s));
      if (!alive) return;
      if (!d || !d.ok) {
        ai = { status: 'done', html: d && d.need_key
          ? `<div class="hint">🔑 尚未設定 AI 金鑰：到 Vercel 設 ANTHROPIC_API_KEY 或 OPENAI_API_KEY 即可啟用</div>`
          : `<div class="note">${esc((d && d.msg) || 'AI 暫時無法使用')}</div>` };
      } else {
        const text = String(d.analysis || '').trim();
        ai = { status: 'done', html: text.startsWith('(')   // ok:true 但內容是 '(Claude API 錯誤…' 之類 → 當錯誤列
          ? `<div class="note">⚠️ ${esc(text)}</div>`
          : `<div class="why">${esc(text).replace(/\n/g, '<br>')}</div><div class="xs dim mt2">參考 ${fmtInt(d.news_used || 0)} 則最新新聞 · AI 整理的觀察，不是預測</div>` };
      }
    } catch { if (alive) ai = { status: 'done', html: `<div class="note">AI 分析失敗（可能逾時），請稍後再試。</div>` }; }
    paintAI();
  }

  // ── K線 ──
  const overlays = () => {
    const s = sig.data || {};
    const stop = num(s.stop_loss);
    const o = { entry: num(s.entry), stop, stop_loss: stop, target: num(s.target) };   // chart.js 讀 stop；stop_loss 一併給
    if (pred.data && Array.isArray(pred.data.range5) && pred.data.range5.length === 2) o.range5 = pred.data.range5;
    return o;
  };
  function overlayNote() {
    const s = sig.data, p = pred.data;
    const parts = [];
    if (s && num(s.entry) !== null) parts.push(`進場 <b class="num">${fmtPrice(s.entry)}</b> · 停損 <b class="num">${fmtPrice(s.stop_loss)}</b> · 目標 <b class="num">${fmtPrice(s.target)}</b>`);
    else if (sig.status === 'loading') parts.push('進場／停損／目標線等分析完成後疊上');
    if (p && Array.isArray(p.range5)) parts.push(`5 日 ±1σ 區間 <b class="num">${fmtPrice(p.range5[0])}–${fmtPrice(p.range5[1])}</b>（依日波動 ×√5 推估${num(p.band_coverage) !== null ? `；1 日帶實測覆蓋 ${p.band_coverage}%` : ''}）`);
    else if (pred.status === 'loading') parts.push('5 日區間計算中');
    parts.push('紅漲綠跌 · 量（張） · 不足 60 根時不畫均線');
    return parts.join(' · ');
  }
  function klinePane() {
    return card(`<div class="row between"><span class="sm b">📈 日 K 線</span><div class="seg" role="group" aria-label="期間">${PERIODS.map(([l, m]) => `<button data-months="${m}" class="${m === months ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="kchart mt3" id="k-chart">${skLines(4)}</div>
      <div class="legend"><span><i style="background:#5B8CFF"></i>MA20</span><span><i style="background:#A78BFA"></i>MA60</span><span><i style="background:var(--gold)"></i>進場</span><span><i style="background:var(--down)"></i>停損</span><span><i style="background:var(--up)"></i>目標</span><span><i style="background:var(--gold);opacity:.6"></i>5日區間（虛線）</span></div>
      <div class="note mt2" id="k-note">${overlayNote()}</div>`);
  }
  function destroyChart() { if (chart) { try { chart.destroy(); } catch {} chart = null; } }
  async function fetchCandles() {
    const url = (m) => `/api/historical?code=${encodeURIComponent(code)}&market=${m}&months=${months}`;
    let rows = await get(url(market), HIST_OPTS);
    if ((!Array.isArray(rows) || !rows.length) && market === 'tse') {   // 上市無資料 → 上櫃
      rows = await get(url('otc'), HIST_OPTS);
      if (Array.isArray(rows) && rows.length) { market = 'otc'; if (!meta.market && alive) { meta.market = 'otc'; paintHead(); } }
    }
    // 後端對上櫃／Yahoo 路徑固定回 6 個月，不會依 months 裁切 → 前端自己裁到要求的期間，1M／3M 才會不同
    const since = new Date(); since.setMonth(since.getMonth() - months); const sinceKey = since.toISOString().slice(0, 10);
    const inWin = (Array.isArray(rows) ? rows : []).filter(r => r && String(r.date || '').slice(0, 10) >= sinceKey);
    // /api/historical 的 volume 是「股」，畫面與報價統一用「張」
    return normalizeCandles(inWin).map(c => ({ ...c, volume: Math.round(c.volume / 1000) }));
  }
  async function mountChart() {
    if (!slot('k-chart')) return;
    destroyChart();
    const token = ++chartToken;
    let candles = chartCache.get(months);
    if (!candles) {
      paint(slot('k-chart'), skLines(4));
      try { candles = await fetchCandles(); chartCache.set(months, candles); } catch { candles = null; }
    }
    if (!alive || token !== chartToken || !slot('k-chart')) return;
    if (!candles) { paint(slot('k-chart'), emptyState('😵', 'K 線資料暫時無法載入', `<button class="btn sm" data-act="retry-chart">重試</button>`)); return; }
    if (!candles.length) { paint(slot('k-chart'), emptyState('📉', '沒有這段期間的歷史資料')); return; }
    const ok = await waitForLW();
    if (!alive || token !== chartToken || !slot('k-chart')) return;
    if (!ok) { paint(slot('k-chart'), emptyState('📈', '圖表元件載入失敗，請重新整理')); return; }
    chart = mountKLine(slot('k-chart'), candles, overlays());
    const n = slot('k-note'); if (n) paint(n, overlayNote());
  }

  // ── 籌碼 ──
  function chipFromSignal(s) {
    const cd = s.chip_data && typeof s.chip_data === 'object' ? s.chip_data : {};
    const daily = Array.isArray(cd.daily) ? cd.daily.filter(r => r && r.date) : [];   // 已是新→舊
    const inst = s.institutional && typeof s.institutional === 'object' ? s.institutional : null;
    const head = `<div class="stitle"><h2>🏛️ 法人動向 <span class="sub">近 ${daily.length || '—'} 日 · 張</span></h2>${num(s.chip_score) !== null ? `<span class="xs dim">籌碼分 <b class="num">${s.chip_score}</b></span>` : ''}</div>`;
    const latest = inst && num(inst.total) !== null
      ? `<div class="chips">${chip(`外資 ${signed(inst.foreign)}`)}${chip(`投信 ${signed(inst.trust)}`)}${chip(`合計 ${signed(inst.total)}`)}${num(cd.consecutive_buy) > 0 ? chip(`連 ${cd.consecutive_buy} 日買超`, 'gold') : ''}</div>`
      : `<div class="note">最近交易日無法人買賣超資料（上櫃股不在證交所 T86 名單內）。</div>`;
    const margin = s.margin && num(s.margin.balance) !== null
      ? card(`<div class="stitle"><h2>💳 散戶動向</h2><span class="sub">融資</span></div><div class="chips">${chip(`融資餘額 <b class="num">${fmtInt(s.margin.balance)}</b> 張`)}${chip(`今日 ${signed(s.margin.change, ' 張')}`)}</div><div class="mt2">${signalRows(s.margin_signals, '無明顯融資券訊號')}</div>`)
      : '';
    return card(head + latest + (daily.length ? dailyRows(daily) : '') + `<div class="mt3">${signalRows(s.chip, '無明顯籌碼訊號')}</div>`) + margin;
  }
  function chipPane() {
    const base = sig.status === 'loading' ? card(skLines(4) + `<div class="note mt2">法人 5 日資料隨個股分析一起載入（約 10–30 秒）…</div>`)
      : sig.data ? chipFromSignal(sig.data)
      : card(`<div class="note">${sig.status === 'insufficient' ? '這檔歷史資料不足，個股分析沒有法人 5 日資料' : '個股分析未完成，暫無法人 5 日資料'}；可直接載入完整籌碼分析。</div>`);
    const full = chipFull.status === 'idle' ? `<button class="btn block mt3" data-act="chip-full">🔍 載入完整籌碼分析（近 10 日法人＋融資券，約 20–60 秒）</button>`
      : chipFull.status === 'loading' ? card(skLines(4) + `<div class="note mt2">完整籌碼分析計算中（逐日抓取交易所資料，冷啟動較久）…</div>`, 'mt3')
      : chipFull.status === 'error' ? card(emptyState('😵', '完整籌碼分析暫時無法載入', `<button class="btn sm" data-act="chip-full">重試</button>`), 'mt3')
      : chipFullCard(chipFull.data);
    return base + full;
  }
  async function loadChipFull() {
    if (chipFull.status === 'loading') return;
    chipFull = { status: 'loading', data: null }; if (tab === 'chip') paintPane();
    try {
      const d = await get(`/api/chip_analysis?code=${encodeURIComponent(code)}`, { ttl: 600000, timeout: 90000 });
      if (!alive) return;
      chipFull = d && typeof d === 'object' && !d.error ? { status: 'ok', data: d } : { status: 'error', data: null };
    } catch { if (alive) chipFull = { status: 'error', data: null }; }
    if (tab === 'chip') paintPane();
  }

  // ── 新聞 + 供應鏈 ──
  function newsRow(x) {
    const u = safeUrl(x.link);
    const inner = `<div class="grow"><div class="sm b">${esc(x.title)}</div><div class="xs dim mt1">${esc(x.source || '')}${x.date ? ` · ${esc(timeAgo(x.date))}` : ''}</div></div>`;
    return u ? `<a class="li" href="${u}" target="_blank" rel="noopener">${inner}<span class="dim">↗</span></a>` : `<div class="li">${inner}</div>`;
  }
  const chainRow = (label, list) => (Array.isArray(list) && list.length)
    ? `<div class="xs dim mt2 mb2">${label}</div><div class="chips">${list.filter(x => x && x.code).map(x => `<a class="btn sm" href="${stockHref(x.code)}">${esc(x.name || x.code)} <span class="xs dim">${esc(x.role || '')}</span></a>`).join('')}</div>` : '';
  function newsPane() {
    const n = news, c = chain;
    const newsCard = n.status === 'loading' || n.status === 'idle' ? card(skLines(4))
      : n.status === 'error' ? card(emptyState('😵', '新聞暫時無法載入', `<button class="btn sm" data-act="retry-news">重試</button>`))
      : card(`<div class="stitle"><h2>📰 相關新聞</h2><span class="sub">${n.fallback ? '分析快照' : 'Google 新聞'}</span></div>` + (n.data.length ? `<div class="list">${n.data.map(newsRow).join('')}</div>` : emptyState('📰', '近期沒有這檔的新聞')));
    const d = c.data;
    const chainCard = c.status === 'loading' ? card(skLines(2))
      : d && d.has_chain ? card(`<div class="stitle"><h2>🔗 供應鏈</h2>${d.role ? `<span class="sub">${esc(d.role)}</span>` : ''}</div>${chainRow('上游', d.upstream)}${chainRow('下游', d.downstream)}`)
      : '';
    return newsCard + chainCard;
  }
  function loadNews() {
    if (news.status === 'idle' || news.status === 'error') {
      news = { status: 'loading', data: [], fallback: false };
      get(`/api/stock_news?code=${encodeURIComponent(code)}`, { ttl: 300000, timeout: 30000 })
        .then(d => { if (alive) news = { status: 'ok', data: Array.isArray(d) ? d.filter(x => x && x.title) : [], fallback: false }; })
        .catch(() => {   // 退回 stock_signal 內附的新聞快照（無連結）
          if (!alive) return;
          const fb = sig.data && Array.isArray(sig.data.news) ? sig.data.news.filter(x => x && x.title) : [];
          news = fb.length ? { status: 'ok', data: fb.map(x => ({ ...x, link: '' })), fallback: true } : { status: 'error', data: [], fallback: false };
        })
        .finally(() => { if (alive && tab === 'news') paintPane(); });
    }
    if (chain.status === 'idle' || chain.status === 'error') {
      chain = { status: 'loading', data: null };
      get(`/api/supply_chain?code=${encodeURIComponent(code)}`, { ttl: 3600000, timeout: 15000 })
        .then(d => { if (alive) chain = { status: 'ok', data: d && typeof d === 'object' && !d.error ? d : null }; })
        .catch(() => { if (alive) chain = { status: 'error', data: null }; })
        .finally(() => { if (alive && tab === 'news') paintPane(); });
    }
  }

  // ── 預測 ──
  function regimeLine(d) {
    if (!d || !d.regime_label) return '🌦 大盤格局統計暖機中…';
    const w = weather.data || {};
    const parts = [`${esc(d.regime_icon || '')} 大盤<b>${esc(d.regime_label)}</b>格局`];
    const up = num(d.regime_fwd5_up);
    if (up !== null) parts.push(`歷史同格局 5 日後上漲機率 <b>${up}%</b>${num(w.n_hist) !== null ? ` <span class="n">（${fmtInt(w.n_hist)} 次）</span>` : ' <span class="n">（樣本數載入中）</span>'}`);
    const cp = num(d.class_regime_prob) ?? num(w.class_win_rate_here);   // predict 只讀快取；market_weather 暖機後補上
    const cn = num(d.class_regime_n) ?? num(w.class_n_here);
    if (cp !== null) parts.push(`此格局進場訊號勝率 <b>${cp}%</b>${cn !== null ? ` <span class="n">（${fmtInt(cn)} 筆）</span>` : ''}`);
    else parts.push(weather.status === 'error' ? '<span class="n">此格局訊號勝率暫時無法取得</span>' : '<span class="n">此格局訊號勝率統計暖機中…</span>');
    return parts.join('　·　');
  }
  function predictPane() {
    if (pred.status === 'loading' || pred.status === 'idle') return card(skLines(4) + `<div class="note mt2">以近 60 日波動推算區間、回測同類訊號機率中…</div>`);
    if (pred.status === 'nodata') return card(emptyState('🔮', '資料不足，暫無預測'));
    if (pred.status === 'error') return card(emptyState('😵', '預測暫時無法載入', `<button class="btn sm" data-act="retry-pred">重試</button>`));
    const d = pred.data;
    const rng = (r) => Array.isArray(r) && r.length === 2 ? `${fmtPrice(r[0])}–${fmtPrice(r[1])}` : '—';
    const t1 = tiles([{ k: '明日區間', v: `<span class="lg">${rng(d.range1)}</span>` }, { k: '5 日區間', v: `<span class="lg">${rng(d.range5)}</span>` }]);
    const t2 = tiles([{ k: '日波動', v: num(d.daily_vol_pct) !== null ? `${d.daily_vol_pct}%` : '—' }, { k: '日帶實測涵蓋', v: num(d.band_coverage) !== null ? `${d.band_coverage}%` : '—' }]);
    const sp = num(d.stock_prob);
    const prob = sp !== null
      ? `<div class="prob ${sp < 40 ? 'bad' : ''}">🎯 <b>這檔回測近一年同類訊號</b> <span class="n">${fmtInt(d.stock_n)} 次</span>　勝率約 <b>${sp}%</b>${num(d.horizon) !== null ? `，平均持有約 ${d.horizon} 天` : ''}</div>`
      : `<div class="note mt2">這檔近一年同類訊號少於 8 次，樣本太小，不顯示個股勝率（避免把雜訊當機率）。</div>`;
    return card(`<div class="stitle"><h2>🔮 統計預測</h2><span class="sub">基準價 <b class="num">${fmtPrice(d.price)}</b></span></div>
      ${t1}<div class="mt2">${t2}</div>
      ${prob}
      <div class="prob" id="pd-regime">${regimeLine(d)}</div>
      ${d.note ? `<div class="note mt2">${esc(d.note)}</div>` : ''}`);
  }
  function warmWeather() {   // 補 n_hist 與此格局訊號勝率（首頁載過就是快取，冷啟動可能 10–30 秒）
    if (weather.status !== 'idle') return;
    weather = { status: 'loading', data: null };
    API.weather().then(w => { if (alive) weather = { status: 'ok', data: w && w.label ? w : null }; })
      .catch(() => { if (alive) weather = { status: 'error', data: null }; })
      .finally(() => { const el = slot('pd-regime'); if (el && pred.data) paint(el, regimeLine(pred.data)); });
  }
  function loadPredict() {
    if (pred.status !== 'idle' && pred.status !== 'error') return;
    pred = { status: 'loading', data: null };
    if (tab === 'predict') paintPane();
    API.predict(code).then(d => {
      if (!alive) return;
      if (!d || typeof d !== 'object' || d.error || !Array.isArray(d.range1)) pred = { status: 'nodata', data: null };
      else { pred = { status: 'ok', data: d }; warmWeather(); }
    }).catch(e => { if (alive) pred = { status: e instanceof ApiError && e.status === 404 ? 'nodata' : 'error', data: null }; })
      .finally(() => {
        if (!alive) return;
        if (tab === 'predict') paintPane();
        else if (tab === 'overview') paintOv('ov-rows', rowsHtml());          // 下一個觀察點補上 5 日區間
        else if (tab === 'kline' && chart && pred.data) mountChart();         // 補上 5 日區間虛線
      });
  }

  // ── tabs ──
  function paintPane() {
    const el = slot('st-pane'); if (!el) return;
    paint(el, tab === 'overview' ? overviewPane() : tab === 'kline' ? klinePane() : tab === 'chip' ? chipPane() : tab === 'news' ? newsPane() : predictPane());
    if (tab === 'kline') mountChart();
  }
  function ensureLoaded() {
    if (tab === 'overview' || tab === 'kline' || tab === 'predict') loadPredict();
    if (tab === 'news') loadNews();
  }
  function scrollToId(id) {
    const el = slot(id);
    if (!el) { if (id === 'sig-card' && sig.status === 'loading') pendingScroll = id; return; }
    setTimeout(() => { if (alive) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 80);   // 讓 router 的 scrollTo(0) 先跑完
  }
  function setTab(t, { scrollTo = null } = {}) {
    t = TAB_ALIAS[t] || t;
    if (!TAB_KEYS.has(t)) return;
    if (t !== tab) {
      if (tab === 'kline') destroyChart();
      tab = t; store.set('stock_tab', t);
      view.querySelectorAll('#st-tabs [data-tab]').forEach(b => { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
      try { history.replaceState(null, '', `#/stock/${encodeURIComponent(code)}/${t}`); } catch {}   // 可分享、不觸發 hashchange
      paintPane(); ensureLoaded();
    }
    if (scrollTo) scrollToId(scrollTo);
  }

  // ── events (delegated) ──
  function onClick(e) {
    const tb = e.target.closest('#st-tabs [data-tab]');
    if (tb) { setTab(tb.dataset.tab); return; }
    const pb = e.target.closest('[data-months]');
    if (pb) {
      const m = Number(pb.dataset.months);
      if (m && m !== months) { months = m; store.set('stock_kperiod', m); view.querySelectorAll('[data-months]').forEach(b => b.classList.toggle('on', Number(b.dataset.months) === m)); mountChart(); }
      return;
    }
    const a = e.target.closest('a[href]');
    if (a) {   // 觀察四列連到本頁其他分頁（/signals /chart /predict）→ 直接切分頁，不重載整頁
      const m = String(a.getAttribute('href') || '').match(/^#\/stock\/([^/]+)\/([a-z]+)$/i);
      if (m && decodeURIComponent(m[1]).toUpperCase() === code && resolveTab(m[2])) {
        e.preventDefault();
        setTab(m[2], { scrollTo: m[2] === 'signals' ? 'sig-card' : 'st-tabs' });
      }
      return;
    }
    const b = e.target.closest('[data-act]'); if (!b) return;
    switch (b.dataset.act) {
      case 'back': if (history.length > 1) history.back(); else location.hash = '#/home'; break;
      case 'hold': addHolding(code, meta.name || code, market); paintHead(); paintOv('ov-cta', ctaHtml()); break;
      case 'alert': openAlertSheet(code, meta.name || code, num(quote.data && quote.data.price) ?? (sig.data ? sig.data.price : null)); break;
      case 'ai': askAI(); break;
      case 'chip-full': loadChipFull(); break;
      case 'retry-sig': loadSignal(); break;
      case 'retry-pred': loadPredict(); break;
      case 'retry-news': loadNews(); break;
      case 'retry-chart': mountChart(); break;
    }
  }
  const onVis = () => { if (!document.hidden && marketOpen()) loadQuote(false); };

  // ── shell: first paint is skeleton; every block fills independently ──
  paint(view, `
    <div class="backbar">
      <button class="btn" data-act="back" aria-label="返回">←</button>
      <div class="title ellipsis" id="st-title">${titleHtml()}</div>
      <button class="btn sm" data-act="hold" id="st-hold">${holdLabel()}</button>
      <button class="btn sm" data-act="alert">🔔 提醒</button>
    </div>
    <div class="card" id="st-price">${priceHtml()}</div>
    <div class="subtabs" id="st-tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" data-tab="${k}" class="${k === tab ? 'on' : ''}" aria-selected="${k === tab}">${l}</button>`).join('')}</div>
    <div id="st-pane">${skCards(2)}</div>
    <div class="disclaimer">資料來源 TWSE／TPEx／Yahoo · 訊號、機率與區間皆為歷史統計推估，僅供參考，不構成投資建議 · 產業插畫為示意</div>`);
  view.addEventListener('click', onClick);
  document.addEventListener('visibilitychange', onVis);

  loadQuote(true);
  loadSignal();
  paintPane(); ensureLoaded();
  timer = setInterval(() => { if (!document.hidden && marketOpen()) loadQuote(false); }, 30000);   // 盤中 30 秒刷新報價

  return () => {
    alive = false;
    clearInterval(timer);
    destroyChart();
    view.removeEventListener('click', onClick);
    document.removeEventListener('visibilitychange', onVis);
    document.title = prevTitle;
  };
}
