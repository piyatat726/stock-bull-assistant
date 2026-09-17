// 台股小牛 v2 — 選股：所有「該買什麼／該賣什麼」的清單合成一份排行。
// 版型（reference look）：.eyebrow PICKS ＋ .h-display 問句 ＋ 一行說明「目前切面的資料來源」＋
// 「這套推薦準不準？」連結（開回測 sheet）；sticky 分段控制切九個切面：
// 綜合 | 技術 | 價值 | 基本面 | 科技 | 動能 | 新聞 | 賣出 | ETF。
// 每個切面各自 fetch、各自 skeleton，互不阻塞；慢端點（綜合／技術／動能）先畫上次結果再背景更新。
// 綜合走 pickCard；其他切面走同一套解剖（身分 · 價格紅漲綠跌 · 來源 chip · 為什麼 ≤2 · 機率附 n · 停損—現價—目標）。
// 判斷一律 judge() 徽章；數字只用方向色（法人買超紅／賣超綠）。免責只在最底一則。
// 路由：#/picks/<key>（key 也接受中文標籤）；目前切面存 localStorage 'picks_seg'。
import { render as paint, esc, num, cls, signPct, fmtPrice, fmtInt, skCards, skLines, openSheet, closeSheet, store, timeAgo } from '../ui.js';
import { API, get, invalidate } from '../api.js';
import { chip, judge, emptyState, stockRow, pickCard, ident, priceBox, probLine, planBar, tiles, stockHref } from '../components.js';

// ── segments ──
const SEGS = [['all', '綜合'], ['tech', '技術'], ['value', '價值'], ['fund', '基本面'], ['ai', '科技'], ['mom', '動能'], ['news', '新聞'], ['sell', '賣出'], ['etf', 'ETF']];
const KEYS = new Set(SEGS.map(s => s[0]));
const BY_LABEL = Object.fromEntries(SEGS.map(([k, l]) => [l.toLowerCase(), k]));
// title = 切面標題；src = 頁首一行來源說明；srcTag = 卡片來源 chip（沿用 components.js SRC_KIND 配色）；
// eta 只給慢端點；path = invalidate() 前綴（重試用）；note = 切面補充（不是免責）；empty = 空狀態
const META = {
  all:   { title: '⭐ 綜合推薦', src: '融合技術進場、利多新聞、科技動能、估值便宜四個來源的最新訊號，同時命中越多排越前。', eta: '10–20 秒', path: '/api/top_buys', note: '●＝命中的來源數；機率附回測樣本數，樣本少時參考價值也低。', empty: ['🔍', '今天沒有符合條件的綜合推薦'] },
  tech:  { title: '📡 技術進場', src: '熱門股技術訊號自動掃描（RSI／KD／MACD／均線支撐），依訊號強度排序。', eta: '約 15 秒', path: '/api/entry_signals', srcTag: ['技術進場', 'info'], note: '進場／停損／目標依 ATR 推算，是參考價位，不是預測。', empty: ['📡', '目前沒有偵測到明確的進場訊號'] },
  value: { title: '🎩 價值選股', src: '估值雷達（低於合理價 8% 以上）排前面，其後是巴菲特式價值評分；合理價為簡易估算。', path: '/api/value_', srcTag: ['估值便宜', 'down'], note: '價值投資看的是長期持有與安全邊際，不是短線訊號。', empty: ['🎩', '目前沒有好公司跌進便宜區'] },
  fund:  { title: '📊 基本面', src: '營收年增、殖利率、本益比與法人動向的綜合評分。', path: '/api/recommend', srcTag: ['基本面', ''], empty: ['📊', '目前沒有基本面達標的推薦'] },
  ai:    { title: '🤖 科技動能', src: 'AI／半導體供應鏈：法人買超、營收年增、ROE 加上技術動能。', path: '/api/tech_picks', srcTag: ['科技動能', 'purple'], empty: ['🤖', '目前沒有科技動能達標的股票'] },
  mom:   { title: '🚀 動能', src: '約 60 檔熱門股的均線與量價動能掃描 · 較慢，約 15 秒。', eta: '約 15 秒', path: '/api/momentum', srcTag: ['動能', 'gold'], empty: ['🚀', '目前沒有明顯的動能股'] },
  news:  { title: '📰 新聞選股', src: '近期新聞反覆提及的個股；被提及不等於利多，點開新聞自己判斷。', path: '/api/news_picks', srcTag: ['利多新聞', 'gold'], empty: ['📰', '近期沒有被反覆提及的個股'] },
  sell:  { title: '⚠️ 賣出觀察', src: '基本面轉弱或法人賣超的「持有者留意」清單。', path: '/api/recommend_sell', srcTag: ['賣出觀察', 'warn'], note: '賣出觀察 ≠ 做空建議：這是提醒持有者留意，不是放空訊號。', empty: ['✅', '目前沒有需要留意的賣出觀察'] },
  etf:   { title: '🏆 熱門 ETF', src: '8 檔熱門 ETF 即時報價（TWSE），點進去看完整分析。', path: '/api/etf', empty: ['🏆', 'ETF 報價暫時無法取得'] },
};
function resolveSeg(p) {
  const s = String(p || '').trim().toLowerCase();
  if (KEYS.has(s)) return s;
  if (Object.prototype.hasOwnProperty.call(BY_LABEL, s)) return BY_LABEL[s];
  let saved = null; try { saved = localStorage.getItem('picks_seg'); } catch {}
  return KEYS.has(saved) ? saved : 'all';
}

// ── private helpers ──
const card = (inner, k = '') => `<div class="card${k ? ' ' + k : ''}">${inner}</div>`;
const safeUrl = (u) => /^https?:\/\//i.test(String(u || '')) ? esc(u) : '#';
const cleanNum = (v) => num(String(v ?? '').replace(/,/g, ''));
const c = (text, kind = '') => chip(esc(text), kind);   // chip() 不跳脫文字 → 一律經 esc
const srcChip = (key) => { const t = META[key].srcTag; return t ? c(t[0], t[1]) : ''; };
const valuePicks = () => get('/api/value_picks', { ttl: 300000, timeout: 60000 });   // api.js 沒有 valuePicks
/** HTTP-200 error body（{error:…}）→ 視為空資料，不當成崩潰 */
const isErr = (d) => !!(d && typeof d === 'object' && !Array.isArray(d) && d.error);

// 慢端點最後一次成功結果存 localStorage：冷啟動先畫「上次結果」，不留白頁
const SNAP_TTL = 24 * 3600000;
const readSnap = (k) => { const s = store.get(`picks_snap_${k}`); return s && Array.isArray(s.data) && s.data.length && s.t && Date.now() - s.t < SNAP_TTL ? s : null; };
const writeSnap = (k, data) => { if (Array.isArray(data) && data.length) store.set(`picks_snap_${k}`, { t: Date.now(), data: data.slice(0, 20) }); };

// judgement 徽章種類：verdict_icon / 賣出分類 → kind（圖示語意 🟢=好 🔴=差，與價格色無關；emoji 照後端給的）
const VERDICT_KIND = { '🎩': 'ok', '🟢': 'ok', '🟡': 'warn', '🟠': 'warn', '🔴': 'bad', '⚪': 'neutral' };
const SELL_KIND = { '基本面惡化': 'bad', '法人倒貨': 'warn', '營收衰退': 'warn', '高估值風險': 'warn', '綜合警示': 'warn' };

// 數字 chip（缺值就不出）
const peChip = (v) => { const n = num(v); return n === null ? '' : c(`PE ${n.toFixed(1)}`); };
const yieldChip = (v) => { const n = num(v); return n === null ? '' : c(`殖利率 ${n.toFixed(1)}%`); };
const yoyChip = (v) => { const n = num(v); return n === null ? '' : c(`營收年增 ${signPct(n, 1)}`); };
const roeChip = (v) => { const n = num(v); return n === null ? '' : c(`ROE ${n.toFixed(1)}%`); };
/** 外資買賣超（張）：買超紅／賣超綠 = 方向色，不是判斷色 */
const netChip = (v) => { const n = num(v); return n === null ? '' : c(`外資${n > 0 ? '買超' : n < 0 ? '賣超' : '持平'} ${fmtInt(Math.abs(n))} 張`, cls(n)); };
/** entry_signals.total_weight → 強度徽章（門檻沿用舊版：滿分 20，≥14 強、≥8 中） */
const strength = (w) => { const n = num(w); if (n === null) return ''; const [lv, k] = n >= 14 ? ['強', 'ok'] : n >= 8 ? ['中', 'warn'] : ['弱', 'neutral']; return judge(`強度 ${n} · ${lv}`, k, '📶'); };
const freshTxt = (h) => { const n = num(h); if (n === null) return ''; return n < 24 ? `${Math.max(1, Math.round(n))} 小時內` : `${Math.round(n / 24)} 天內`; };
/** 技術訊號 → 為什麼（權重最高的前兩條 desc） */
const sigReasons = (sigs) => (Array.isArray(sigs) ? [...sigs] : []).filter(s => s && s.desc).sort((a, b) => (num(b.weight) || 0) - (num(a.weight) || 0)).slice(0, 2).map(s => String(s.desc));

/**
 * 切面卡：與 pickCard 同一套解剖，只多一列 chip（來源 + 切面指標；pickCard 沒有 chip 插槽）。
 * p 已是 pickCard shape（code,name,market,price,change_pct,reasons,entry,stop_loss,target,risk_reward,win_prob…），
 * 缺的區塊自動省略（probLine/planBar 自帶 guard）。news 給陣列時整卡不是 <a>（a 不能包 a），標題列才連個股。
 */
function facetCard(p, { rank = null, chips = [], reasons = [], news = null } = {}) {
  const top = `${rank !== null ? `<span class="rank">${rank}</span>` : ''}<div class="grow">${ident(p)}</div>${priceBox(p)}`;
  const cs = chips.filter(Boolean);
  const why = (Array.isArray(reasons) ? reasons : []).filter(Boolean).slice(0, 2);
  const nz = (Array.isArray(news) ? news : []).filter(n => n && n.title).slice(0, 2);
  const body = (cs.length ? `<div class="chips mt2">${cs.join('')}</div>` : '')
    + (why.length ? `<ul class="why"><span class="lbl">為什麼</span>${why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '')
    + (nz.length ? `<ul class="why"><span class="lbl">相關新聞</span>${nz.map(n => `<li><a href="${safeUrl(n.link)}" target="_blank" rel="noopener">${esc(n.title)} ↗</a><span class="xs dim"> · ${esc(n.source || '新聞')}${n.date ? ` · ${esc(timeAgo(n.date))}` : ''}</span></li>`).join('')}</ul>` : '')
    + probLine(p) + planBar(p);
  return news
    ? `<div class="card"><a class="row between" href="${stockHref(p.code)}">${top}</a>${body}</div>`
    : `<a class="card tap" href="${stockHref(p.code)}"><div class="row between">${top}</div>${body}</a>`;
}

// 每個切面 → 卡片（後端 row 本身就是 pickCard shape 的超集：code,name,market,price,change_pct…；欄位缺就省略）
const CARD = {
  all:   (p, i) => pickCard(p, { rank: i + 1 }),
  tech:  (s, i) => facetCard(s, { rank: i + 1, reasons: sigReasons(s.signals),
           chips: [srcChip('tech'), strength(s.total_weight), num(s.rsi) !== null ? c(`RSI ${Math.round(num(s.rsi))}`) : ''] }),
  value: (s, i) => { const mos = num(s.margin_of_safety); return facetCard(s, { rank: i + 1, reasons: s.pros, chips: [
           srcChip('value'),
           s.verdict ? judge(s.verdict, VERDICT_KIND[s.verdict_icon] || 'neutral', esc(s.verdict_icon || '')) : '',
           mos === null ? '' : mos >= 0 ? judge(`低估 ${signPct(mos, 1)}`, 'ok', '💰') : judge(`偏貴 ${signPct(mos, 1)}`, 'warn', '💸'),
           num(s.fair_price) !== null ? c(`合理價 ${fmtPrice(s.fair_price)}`) : '',
           s._radar ? c('🎯 估值雷達', 'gold') : '',
         ] }); },
  fund:  (s, i) => facetCard(s, { rank: i + 1, reasons: s.reasons,
           chips: [srcChip('fund'), s.category ? judge(s.category, 'ok', esc(s.cat_icon || '⭐')) : '', peChip(s.pe), yieldChip(s.dividend_yield), yoyChip(s.rev_yoy)] }),
  ai:    (s, i) => facetCard(s, { rank: i + 1, reasons: s.reasons,
           chips: [srcChip('ai'), num(s.score) !== null ? c(`強度 ${s.score}`, 'purple') : '', netChip(s.foreign_net), yoyChip(s.rev_yoy), roeChip(s.roe)] }),
  mom:   (s, i) => facetCard(s, { rank: i + 1, reasons: (Array.isArray(s.signals) ? s.signals : []).map(x => String(x)),
           chips: [srcChip('mom'), num(s.score) !== null ? c(`動能分數 ${s.score}`, 'gold') : ''] }),
  news:  (s, i) => { const f = freshTxt(s.fresh_hours); return facetCard(s, { rank: i + 1, news: Array.isArray(s.news) ? s.news : [],
           chips: [srcChip('news'), num(s.score) !== null ? c(`提及 ${fmtInt(s.score)} 次`) : '', f ? c(`🕐 ${f}`) : '', num(s.hot) !== null ? c(`🔥 熱度 ${num(s.hot).toFixed(1)}`) : ''] }); },   // hot 是分數（新聞數＋漲幅＋新鮮度），不是布林
  sell:  (s, i) => facetCard(s, { rank: i + 1, reasons: s.reasons,
           chips: [srcChip('sell'), s.category ? judge(s.category, SELL_KIND[s.category] || 'warn', esc(s.cat_icon || '🔻')) : '', peChip(s.pe), yieldChip(s.dividend_yield), yoyChip(s.rev_yoy)] }),
};
/** ETF 列副標：成交量（realtime volume 是字串、單位張）＋ 試撮／昨收標記 */
function etfSub(s) {
  const parts = []; const v = cleanNum(s.volume);
  if (v !== null) parts.push(`量 ${fmtInt(v)} 張`);
  if (s.traded === false) parts.push('試撮／昨收');
  return parts.join(' · ');
}

// ── 這套推薦準不準？（/api/topbuys_backtest 近 12 個月；6h 快取，冷啟動 30–50 秒）──
let sheetHandler = null;
function backtestHtml(d) {
  if (!d || typeof d !== 'object' || d.error) return emptyState('😵', '回測服務暫時無回應，請稍後再試');
  if (!num(d.trades)) return emptyState('📉', '樣本不足，暫時無法回測');
  const conf = d.confirmed || {}, base = d.base_only || {};
  const useC = (num(conf.trades) || 0) >= 20;          // 多訊號確認 cohort 夠多才用，否則退回全部
  const h = useC ? conf : d;
  const label = useC ? '綜合推薦（多訊號確認）' : '技術進場核心';
  const exp = num(h.expectancy), win = num(h.avg_win), loss = num(h.avg_loss), wr = num(h.win_rate), trades = num(h.trades) || 0;
  const winV = win === null ? '—' : signPct(Math.abs(win), 2), lossV = loss === null ? '—' : signPct(-Math.abs(loss), 2);
  const stat = tiles([
    { k: '進場次數', v: fmtInt(trades) },
    { k: '勝率', v: wr === null ? '—' : `${wr}%` },
    { k: '每筆期望', v: exp === null ? '—' : signPct(exp, 2), cls: cls(exp) },
    { k: '平均賺', v: winV, cls: win === null ? '' : 'up' },
    { k: '平均賠', v: lossV, cls: loss === null ? '' : 'down' },
    { k: '平均持有', v: num(h.avg_hold_days) === null ? '—' : `${h.avg_hold_days} 天` },
  ]);
  // 多訊號確認 vs 單一技術：兩邊都 ≥20 筆才比
  const cn = num(conf.trades) || 0, bn = num(base.trades) || 0, cw = num(conf.win_rate), bw = num(base.win_rate);
  const lift = cn >= 20 && bn >= 20 && cw !== null && bw !== null ? cw - bw : null;
  const bar = (lab, w, n, hl) => `<div class="r"><span>${lab}</span><div class="bars"><div class="bar"><i class="${hl ? 'act' : 'pred'}" style="width:${Math.max(0, Math.min(100, w ?? 0))}%"></i></div></div><span class="num"><b>${w === null ? '—' : w + '%'}</b><br><span class="dim">${fmtInt(n)} 筆</span></span></div>`;
  const cmpLine = lift === null
    ? `<span class="note">兩組樣本不足（各需 ≥20 筆），暫不比較確認效果。</span>`
    : lift > 0 ? judge(`多訊號確認勝率高 ${lift.toFixed(1)} 個百分點（${cw}% vs ${bw}%）`, 'ok', '✅')
    : judge(`兩組勝率接近（${cw}% vs ${bw}%），確認效果不明顯`, 'neutral', '➖');
  const verdict = exp === null ? '' : `<div class="hint mt3">${exp >= 0
    ? `📈 <b>${esc(label)}</b>：歷史回測期望值為正，每筆平均 ${signPct(exp, 2)}、勝率約 ${wr ?? '—'}%${win !== null && loss !== null && Math.abs(win) > Math.abs(loss) ? `，賺的（${winV}）比賠的（${lossV}）多` : ''}。關鍵在紀律執行停損停利；樣本內結果，不代表未來。`
    : `⚠️ <b>${esc(label)}</b>：歷史回測期望值偏弱（每筆平均 ${signPct(exp, 2)}），建議提高訊號門檻或謹慎使用。`}</div>`;
  const extra = [num(h.win_count) !== null ? `✅ 賺 ${fmtInt(h.win_count)} 次` : '', num(h.loss_count) !== null ? `❌ 賠 ${fmtInt(h.loss_count)} 次` : '',
    num(h.best) !== null ? `最佳 ${signPct(h.best, 1)}` : '', num(h.worst) !== null ? `最差 ${signPct(h.worst, 1)}` : ''].filter(Boolean).join(' · ');
  return `<div class="note mb2">模擬熱門股近 ${fmtInt(d.months ?? 12)} 個月${num(d.stocks) !== null ? `、${fmtInt(d.stocks)} 檔` : ''}：每次出現技術進場訊號就買，到停損／目標價／到期出場。新聞／法人／估值無法回溯，未納入。</div>
    <div class="xs gold b mb2">${esc(label)}</div>${stat}
    ${trades < 40 ? `<div class="mt2">${judge(`樣本僅 ${fmtInt(trades)} 筆，統計誤差較大`, 'warn', '⚠️')}</div>` : ''}
    <div class="xs dim mt3 mb2">📊 多訊號確認 vs 單一技術（勝率）</div><div class="cal">${bar('多訊號確認', cw, cn, true)}${bar('單一技術', bw, bn, false)}</div>
    <div class="mt2">${cmpLine}</div>${extra ? `<div class="xs dim center mt3 num">${extra}</div>` : ''}${verdict}
    ${d.note ? `<div class="note mt3">${esc(d.note)}</div>` : ''}`;
}
async function openBacktest() {
  const sh = openSheet(`<div class="stitle"><h2>📊 這套推薦準不準？</h2><span class="sub">近 12 個月回測</span></div>
    <div id="bt-body">${skLines(4)}<div class="note mt2">回測過去 12 個月每一次進場（首次約 30–50 秒，之後秒回）…</div></div>
    <button type="button" class="btn block mt3" data-act="bt-close">關閉</button>`);
  if (sheetHandler) sh.removeEventListener('click', sheetHandler);   // sheet 元素共用，避免累積監聽
  sheetHandler = (e) => { if (e.target.closest('[data-act="bt-close"]')) closeSheet(); };
  sh.addEventListener('click', sheetHandler);
  let d = null;
  try { d = await API.topbuysBacktest(12); } catch { d = null; }
  const el = sh.querySelector('#bt-body'); if (el) paint(el, backtestHtml(d));   // sheet 已換成別的內容就略過
}

export async function render(view, params = []) {
  let alive = true, seq = 0, cur = 'all';
  const ok = (my) => alive && my === seq;          // teardown 或已切到別的切面 → 丟棄
  const body = () => (alive ? view.querySelector('#pk-body') : null);

  // ── shell：編輯風頁首（eyebrow + 問句 + 來源一行 + 回測連結）→ sticky 分段 → 內容 → 唯一免責 ──
  paint(view, `
    <header class="mt4 mb3">
      <div class="eyebrow">PICKS</div>
      <div class="h-display">今天，值得看哪些股票？</div>
      <div class="stitle"><div id="pk-sub" class="sm dim grow"></div><button type="button" class="link" data-act="backtest">這套推薦準不準？ ›</button></div>
    </header>
    <div class="segbar"><div class="seg" role="tablist" aria-label="選股切面">${SEGS.map(([k, l]) => `<button type="button" role="tab" aria-selected="false" data-act="seg" data-seg="${k}">${l}</button>`).join('')}</div></div>
    <section id="pk-body" class="section" aria-live="polite"></section>
    <div class="disclaimer">資料來源 TWSE／TPEx／Yahoo · 推薦皆為模型與歷史回測結果，僅供參考，不構成投資建議</div>`);

  // ── paint helpers ──
  const paintSub = (key) => { const el = alive ? view.querySelector('#pk-sub') : null; if (el) paint(el, esc(META[key].src)); };
  const segHead = (key, { n = null, stale = false } = {}) => {
    const m = META[key];
    const right = stale ? chip('⟳ 上次結果 · 更新中') : `<span class="sub">${n === null ? '掃描中' : `共 ${n} 檔`}</span>`;
    return `<div class="stitle"><h2>${m.title}</h2>${right}</div>${m.note ? `<div class="note mb3">${esc(m.note)}</div>` : ''}`;
  };
  const paintSk = (key) => { const el = body(); if (!el) return; const m = META[key]; paint(el, segHead(key) + skCards(3) + (m.eta ? `<div class="note mt2 center">掃描中，約 ${m.eta}；有上次結果會先顯示。</div>` : '')); };
  const paintFail = (key, text = '暫時無法載入') => { const el = body(); if (!el) return; paint(el, segHead(key, { n: 0 }) + card(emptyState('😵', text, `<button type="button" class="btn sm" data-act="retry">重試</button>`))); };
  function paintSeg(key, data, { stale = false, error = false, ts = null, pending = false } = {}) {
    const el = body(); if (!el) return;
    if (isErr(data)) return paintFail(key, '資料來源暫時無回應');   // HTTP-200 error body → 空狀態
    const list = Array.isArray(data) ? data.filter(x => x && x.code) : [];
    const m = META[key];
    const inner = key === 'etf'
      ? card(list.length ? `<div class="list">${list.map(s => stockRow(s, { sub: etfSub(s) })).join('')}</div>` : emptyState(m.empty[0], m.empty[1]))
      : (list.length ? list.map((x, i) => CARD[key](x, i)).join('') : card(emptyState(m.empty[0], m.empty[1])));
    let foot = '';
    if (stale) foot = `<div class="note mt2 center">${error ? '重新掃描失敗，顯示上次結果' : '顯示上次結果，背景重新掃描中'}${ts ? `（${timeAgo(ts)}）` : ''}${!error && m.eta ? `，約 ${m.eta}` : ''}。</div>`;
    else if (pending) foot = `<div class="note mt2 center">更多價值股載入中…</div>`;
    paint(el, segHead(key, { n: list.length, stale }) + inner + foot);
  }

  // ── loaders（每個切面獨立；慢端點 snapshot-first）──
  async function loadAll(my) {   // API.topBuys = SWR：記憶體快取先畫（stale pill），再畫新結果
    const snap = readSnap('all'); let painted = false;
    if (snap) paintSeg('all', snap.data, { stale: true, ts: snap.t }); else paintSk('all');
    try {
      await API.topBuys((data, { stale = false, error = null } = {}) => {
        if (!ok(my)) return; painted = true;
        paintSeg('all', data, { stale, error: !!error });
        if (!stale && Array.isArray(data)) writeSnap('all', data);
      });
    } catch {
      if (!ok(my) || painted) return;
      if (snap) paintSeg('all', snap.data, { stale: true, error: true, ts: snap.t }); else paintFail('all');
    }
  }
  async function loadSlow(key, my, fn) {
    const snap = readSnap(key);
    if (snap) paintSeg(key, snap.data, { stale: true, ts: snap.t }); else paintSk(key);
    let d;
    try { d = await fn(); }
    catch { if (!ok(my)) return; if (snap) paintSeg(key, snap.data, { stale: true, error: true, ts: snap.t }); else paintFail(key); return; }
    if (!ok(my)) return;
    paintSeg(key, d); if (Array.isArray(d)) writeSnap(key, d);
  }
  async function loadSimple(key, my, fn) {
    paintSk(key);
    let d;
    try { d = await fn(); } catch { if (ok(my)) paintFail(key); return; }
    if (ok(my)) paintSeg(key, d);
  }
  function loadValue(my) {   // 估值雷達 + 巴菲特價值：雷達先到就先畫，合併去重（雷達優先）
    paintSk('value');
    const st = { alerts: undefined, picks: undefined };   // undefined = 未到，null = 失敗
    const norm = (d) => Array.isArray(d) ? d : (isErr(d) ? null : []);
    const draw = () => {
      if (!ok(my)) return;
      const pending = st.alerts === undefined || st.picks === undefined;
      if (pending && !(Array.isArray(st.alerts) && st.alerts.length)) return;   // 還沒東西可畫 → 留 skeleton
      if (st.alerts === null && st.picks === null) return paintFail('value', '資料來源暫時無回應');
      const seen = new Set(); const merged = [];
      for (const [radar, arr] of [[true, st.alerts], [false, st.picks]]) {
        for (const x of (Array.isArray(arr) ? arr : [])) {
          if (!x || !x.code || seen.has(String(x.code))) continue;
          seen.add(String(x.code)); merged.push({ ...x, _radar: radar });
        }
      }
      paintSeg('value', merged, { pending });
    };
    API.valueAlerts().then(d => { st.alerts = norm(d); }).catch(() => { st.alerts = null; }).finally(draw);
    valuePicks().then(d => { st.picks = norm(d); }).catch(() => { st.picks = null; }).finally(draw);
  }
  const LOAD = {
    all:   loadAll,
    tech:  (my) => loadSlow('tech', my, () => get('/api/entry_signals', { ttl: 600000, timeout: 90000 })),
    value: loadValue,
    fund:  (my) => loadSimple('fund', my, () => get('/api/recommend', { ttl: 600000, timeout: 60000 })),
    ai:    (my) => loadSimple('ai', my, API.techPicks),
    mom:   (my) => loadSlow('mom', my, () => get('/api/momentum', { ttl: 600000, timeout: 90000 })),
    news:  (my) => loadSimple('news', my, API.newsPicks),
    sell:  (my) => loadSimple('sell', my, () => get('/api/recommend_sell', { ttl: 600000, timeout: 60000 })),
    etf:   (my) => loadSimple('etf', my, () => get('/api/etf', { ttl: 30000, timeout: 20000 })),
  };

  // ── segment switch：更新 seg 按鈕、來源一行、localStorage、網址（replaceState 不觸發 hashchange，不重畫整頁）──
  function show(key, { sync = true } = {}) {
    cur = key; const my = ++seq;
    try { localStorage.setItem('picks_seg', key); } catch {}
    view.querySelectorAll('[data-act="seg"]').forEach(b => {
      const on = b.dataset.seg === key;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
    paintSub(key);
    if (sync) { try { history.replaceState(null, '', `#/picks/${key}`); } catch {} }
    LOAD[key](my);
  }

  // ── events (delegated on view) ──
  function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b || !view.contains(b)) return;
    const act = b.dataset.act;
    if (act === 'seg') { if (b.dataset.seg !== cur) show(b.dataset.seg); }
    else if (act === 'backtest') openBacktest();
    else if (act === 'retry') { invalidate(META[cur].path); show(cur, { sync: false }); }
  }
  view.addEventListener('click', onClick);

  show(resolveSeg(params[0]));

  return () => { alive = false; view.removeEventListener('click', onClick); };
}
