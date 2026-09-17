// 台股小牛 v2 — 更多：🧰 工具 → 📊 戰績 → ⚙️ 設定 → ℹ️ 關於 → 單一免責。
// 每張卡各自 fetch、各自 skeleton；所有非同步填充在 teardown 後一律略過。
// 顏色規則：報酬／損益用 cls()（紅漲綠跌），判斷一律用 judge() 徽章，不替裸數字上判斷色。
import { render as paint, esc, num, cls, signPct, fmtInt, skLines, skCards, openSheet, closeSheet, toast, isLight } from '../ui.js';
import { API, get } from '../api.js';
import { sectionHead, chip, judge, tiles, emptyState, calibrationCard, holdings, syncPortfolio } from '../components.js';

// ── private helpers ──
const APP_URL = `${location.origin}/v2/`;
const QR_SRC = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(APP_URL)}`;
const card = (inner, k = '') => `<div class="card${k ? ' ' + k : ''}">${inner}</div>`;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
/** HTTP-200 error bodies ({error:…}) and non-objects → null（視為空狀態，不當成資料） */
const okObj = (d) => (d && typeof d === 'object' && !Array.isArray(d) && !d.error) ? d : null;
/** 設定列：左側標題＋說明，右側控制項（.li 保證 ≥56px 觸控高度） */
const row = (title, sub, right = '', id = '') => `<div class="li"${id ? ` id="${id}"` : ''}><div class="grow"><div class="b">${title}</div>${sub ? `<div class="xs dim mt1">${sub}</div>` : ''}</div>${right ? `<div class="right">${right}</div>` : ''}</div>`;

const TOOLS = [
  ['🧮', '試算', '#/tools/calc'], ['📊', '定期定額', '#/tools/dca'], ['📈', '多股回測', '#/tools/backtest'],
  ['📅', '除權息', '#/tools/dividend'], ['🎙', '股癌觀點', '#/market/news'], ['⚡', '盤中異動', '#/market/rank'],
];

/** 深淺色：優先走 app shell 的 __toggleTheme（會同步 header 圖示與 theme-color） */
function setTheme(want) {
  const cur = isLight() ? 'light' : 'dark';
  if (want === cur) return;
  if (typeof window.__toggleTheme === 'function') window.__toggleTheme();
  else { document.documentElement.dataset.theme = want; try { localStorage.setItem('theme', want); } catch {} }
}
const themeSeg = () => {
  const cur = isLight() ? 'light' : 'dark';
  return `<div class="seg" role="group" aria-label="深淺色">${[['dark', '🌙 深色'], ['light', '☀️ 淺色']].map(([v, l]) => `<button class="${cur === v ? 'on' : ''}" data-act="theme" data-val="${v}">${l}</button>`).join('')}</div>`;
};
const unitSeg = () => {
  const u = holdings.unit();
  return `<div class="seg" role="group" aria-label="持股單位">${[['stock', '股'], ['lot', '張']].map(([v, l]) => `<button class="${u === v ? 'on' : ''}" data-act="unit" data-val="${v}">${l}</button>`).join('')}</div>`;
};

/** LINE 連線狀態。d: undefined=載入中, {_err}=讀取失敗, {ok:false}=未設定, {ok:true}=連線 */
function lineHtml(d) {
  if (d === undefined) return skLines(2);
  if (d && d._err) return `${judge('狀態讀取失敗', 'neutral', '➖')} <button class="btn sm" data-act="retry-line">重試</button>`;
  if (!d || !d.ok) return `${judge('未設定', 'neutral', '➖')}<div class="xs dim mt1">${esc((d && d.reason) || '後端未設定 LINE_CHANNEL_TOKEN')}，到價與推薦推播不會送出。</div>`;
  const bot = d.bot && d.bot.displayName
    ? `<b>${esc(d.bot.displayName)}</b>${d.bot.basicId ? ` <span class="xs dim">${esc(d.bot.basicId)}</span>` : ''}`
    : '<span class="dim">機器人資訊讀取失敗</span>';
  const q = d.quota || {}, c = d.consumption || {};
  const used = num(c.totalUsage), cap = num(q.value);
  let quota;
  if (q.type === 'limited' && used !== null && cap !== null && cap > 0) {
    const remain = num(d.free_quota_remaining) ?? (cap - used);
    quota = `<div class="row between xs mt2"><span class="dim">本月推播額度</span><span class="num">${fmtInt(used)} / ${fmtInt(cap)} · 剩 ${fmtInt(Math.max(0, remain))}</span></div>
      <div class="bar mt1"><i style="width:${Math.min(100, used / cap * 100).toFixed(1)}%"></i></div>
      ${d.quota_exhausted ? `<div class="mt2">${judge('本月額度已用完，推播送不出去', 'bad', '🛑')}</div>` : ''}`;
  } else if (q.type === 'none') quota = `<div class="xs dim mt2">推播額度：無上限方案</div>`;
  else quota = `<div class="xs dim mt2">額度資訊暫時讀不到</div>`;
  const direct = d.has_line_to
    ? `<div class="mt2">${judge('直推已啟用', 'ok', '✅')} <span class="xs dim">每則推播只扣 1 額度</span></div>`
    : `<div class="hint mt2">未設直推：每則推播扣 ×好友數 額度。設定 Webhook + LINE_CHANNEL_SECRET + LINE_TO 可改善並開啟雙向查股</div>`;
  return `<div class="row between"><span>${bot}</span>${judge('已連線', 'ok', '🟢')}</div>${quota}${direct}`;
}

/** 通知權限：只在使用者點擊時才 requestPermission */
function notifyHtml() {
  if (!('Notification' in window)) return `<div class="xs dim">此瀏覽器不支援網頁通知（iOS 需先加入主畫面）。到價提醒以 LINE 推播為主。</div>`;
  const p = Notification.permission;
  if (p === 'granted') return judge('已允許', 'ok', '✅');
  if (p === 'denied') return `${judge('已封鎖', 'bad', '🚫')}<div class="xs dim mt1">請到瀏覽器的網站設定解除封鎖</div>`;
  return `<button class="btn sm" data-act="notify">開啟通知</button>`;
}
/** 安裝到主畫面：已安裝 → Android 原生 prompt → iOS 指引 → 其他瀏覽器指引 */
function installHtml() {
  if (isStandalone()) return `${judge('已安裝', 'ok', '✅')} <span class="xs dim">正以 App 模式執行</span>`;
  if (window.__installPrompt) return `<button class="btn sm primary" data-act="install">📲 安裝</button>`;
  if (isIOS()) return `<div class="xs dim">Safari 點 <b>分享</b> → <b>加入主畫面</b></div>`;
  return `<div class="xs dim">瀏覽器選單 → 安裝應用程式</div>`;
}

/** 勝率回測 sheet 內容（公式與文案沿用舊版；判斷用徽章，報酬用方向色） */
function btHtml(d, months) {
  const mo = `<div class="subtabs" role="group" aria-label="回測期間">${[6, 12, 24].map(m => `<button class="${m === months ? 'on' : ''}" data-bt-mo="${m}">${m} 個月</button>`).join('')}</div>`;
  if (!d || num(d.trades) === null || d.trades <= 0) return `${mo}${emptyState('📉', '資料不足，無法回測')}`;
  const c = d.confirmed || {}, b = d.base_only || {};
  const useC = (num(c.trades) || 0) >= 20;                       // 多訊號確認組樣本夠才當主角
  const head = useC ? c : d, headLabel = useC ? '綜合推薦（多訊號確認）' : '技術進場核心';
  const n = num(head.trades) || 0, exp = num(head.expectancy), posExp = exp !== null && exp >= 0;
  const cn = num(c.trades) || 0, bn = num(b.trades) || 0, cw = num(c.win_rate) ?? 0, bw = num(b.win_rate) ?? 0;
  const lift = (cn >= 20 && bn >= 20) ? cw - bw : null;
  const stat = tiles([
    { k: '進場次數', v: fmtInt(n) },
    { k: '勝率', v: `${head.win_rate ?? '—'}%` },
    { k: '每筆期望', v: signPct(exp), cls: cls(exp) },
    { k: '平均賺', v: signPct(head.avg_win), cls: cls(head.avg_win) },
    { k: '平均賠', v: signPct(head.avg_loss), cls: cls(head.avg_loss) },
    { k: '平均持有', v: `${head.avg_hold_days ?? '—'} 天` },
  ]);
  const calRow = (label, wr, k, hl) => `<div class="r"><span class="${hl ? 'gold b' : 'dim'}">${label}</span><div class="bars"><div class="bar"><i class="${hl ? 'act' : 'pred'}" style="width:${Math.min(100, wr)}%"></i></div></div><span class="num"><b>${wr}%</b><br><span class="dim">${fmtInt(k)} 筆</span></span></div>`;
  const cmp = lift === null
    ? `<div class="note mt2">兩組樣本不足（各需 ≥20 筆），暫不比較確認效果。</div>`
    : lift > 0
      ? `<div class="mt2">${judge(`多訊號一致組勝率高 ${Math.abs(lift).toFixed(1)} 個百分點`, 'ok', '✅')}<div class="xs dim mt1">${cw}%（${cn} 筆） vs ${bw}%（${bn} 筆），與「多方訊號同時命中排前面」的邏輯一致。樣本內結果，非保證。</div></div>`
      : `<div class="mt2">${judge('確認效果不明顯', 'neutral', '➖')}<div class="xs dim mt1">${cw}%（${cn} 筆） vs ${bw}%（${bn} 筆），兩組勝率接近。</div></div>`;
  const verdict = posExp
    ? `<div class="mt3">${judge('歷史期望值為正', 'ok', '📈')}<div class="sm mt1" style="color:var(--text-2)">每筆平均 <b class="num">${signPct(exp)}</b>、勝率約 <b class="num">${head.win_rate}%</b>（${fmtInt(n)} 筆），${Math.abs(num(head.avg_win) ?? 0) > Math.abs(num(head.avg_loss) ?? 0) ? `賺的（<span class="num ${cls(head.avg_win)}">${signPct(head.avg_win)}</span>）比賠的（<span class="num ${cls(head.avg_loss)}">${signPct(head.avg_loss)}</span>）多` : `單筆平均賺（<span class="num ${cls(head.avg_win)}">${signPct(head.avg_win)}</span>）小於平均賠（<span class="num ${cls(head.avg_loss)}">${signPct(head.avg_loss)}</span>），是靠勝率撐起期望值`}；關鍵在紀律執行停損停利。樣本內結果，不代表未來。</div></div>`
    : `<div class="mt3">${judge('歷史期望值偏弱', 'warn', '⚠️')}<div class="sm mt1" style="color:var(--text-2)">每筆平均 <b class="num">${signPct(exp)}</b>：建議提高訊號門檻或謹慎使用。</div></div>`;
  return `${mo}
    <div class="prob">📊 <b>${esc(headLabel)}</b>　模擬熱門股近 <b>${d.months ?? months}</b> 個月、<span class="num">${fmtInt(d.stocks)}</span> 檔：每次出現技術進場訊號就買，到停損／目標價／到期出場，共 <b class="num">${fmtInt(n)}</b> 次進場。</div>
    <div class="mt3">${stat}</div>
    ${n < 40 ? `<div class="note mt2">⚠️ 樣本僅 ${fmtInt(n)} 筆，統計誤差較大。</div>` : ''}
    <div class="xs dim mt3 mb2">多訊號一致性比較（勝率）</div>
    <div class="cal">${calRow('多訊號確認', cw, cn, true)}${calRow('單一技術', bw, bn, false)}</div>
    ${cmp}${verdict}
    <div class="chips mt3">${chip(`✅ 賺 ${fmtInt(head.win_count)} 次`)}${chip(`❌ 賠 ${fmtInt(head.loss_count)} 次`)}${chip(`最佳 <span class="num ${cls(head.best)}">${signPct(head.best, 1)}</span>`)}${chip(`最差 <span class="num ${cls(head.worst)}">${signPct(head.worst, 1)}</span>`)}</div>
    ${d.note ? `<div class="note mt3">※ ${esc(d.note)}</div>` : ''}`;
}

export async function render(view) {
  let alive = true;
  const slot = (id) => (alive ? view.querySelector('#' + id) : null);
  let line;                       // undefined=載入中
  let sheetEl = null, sheetBound = false, mySheet = false, btReq = 0;

  // ── 0. shell：靜態區塊直接畫，慢資料先放 skeleton ──
  paint(view, `
    <section class="section">${sectionHead('🧰 工具')}
      <div class="drawer-grid">${TOOLS.map(([ic, t, h]) => `<button data-act="go" data-href="${h}"><span class="ic">${ic}</span>${t}</button>`).join('')}</div>
    </section>
    <section class="section">${sectionHead('📊 戰績')}
      <div id="m-cal">${skCards(1)}</div>
      <button class="btn block mt3" data-act="bt">📊 這套推薦準不準？（勝率回測）</button>
    </section>
    <section class="section">${sectionHead('⚙️ 設定')}
      ${card(`<div class="list">
        ${row('🌗 深淺色', '深色為預設，淺色適合白天戶外', themeSeg(), 'm-theme')}
        ${row('📦 持股單位', '持股頁的數量以股或張顯示（1 張 = 1,000 股）', unitSeg(), 'm-unit')}
        <div class="li"><div class="grow"><div class="b">💬 LINE 推播</div><div class="xs dim mt1 mb2">到價提醒與每日推薦的主要推播管道</div><div id="m-line">${lineHtml(undefined)}</div></div></div>
        <div class="li"><div class="grow"><div class="b">🔔 瀏覽器通知</div><div class="xs dim mt1">輔助管道；只在你點擊時才會詢問權限</div></div><div class="right" id="m-notify">${notifyHtml()}</div></div>
        <div class="li"><div class="grow"><div class="b">📲 安裝到主畫面</div><div class="xs dim mt1">像 App 一樣開啟，離線也能看最後資料</div></div><div class="right" id="m-install">${installHtml()}</div></div>
        <div class="li"><div class="grow"><div class="b">👨‍👩‍👧 分享給家人</div><div class="xs dim mt1">掃 QR 或複製連結，家人也能用同一份推薦與持股健診</div>
          <div class="row mt2"><img src="${QR_SRC}" width="140" height="140" alt="分享連結 QR code" loading="lazy">
            <div class="col grow"><button class="btn sm block" data-act="copy">📋 複製連結</button>${navigator.share ? `<button class="btn sm block" data-act="share">📤 分享</button>` : ''}</div></div>
          <div class="xs dim num ellipsis mt2">${esc(APP_URL)}</div></div></div>
      </div>`)}
    </section>
    <section class="section">${sectionHead('ℹ️ 關於')}
      ${card(`<div class="xs dim mb2">資料來源</div>
        <div class="chips">${chip('TWSE 證交所')}${chip('TPEx 櫃買中心')}${chip('Yahoo Finance')}${chip('Google News')}</div>
        <div class="row between mt3"><div class="chips" id="m-ver">${chip('前端 v2')}<span class="sk sk-line" style="width:64px">.</span></div><a class="btn sm" href="/">舊版介面 ›</a></div>`)}
    </section>
    <div class="disclaimer">資料來源 TWSE／TPEx／Yahoo Finance／Google News · 僅供參考，不構成投資建議 · 紙上模擬不含手續費／滑價</div>`);

  // ── 1. 戰績：預測自評 + 紙上戰績（同一張卡，兩個快端點各自 settle 後畫） ──
  async function fillCal() {
    let rep = null, pnl = null;
    await Promise.allSettled([
      API.predictionReport().then(d => { rep = okObj(d); }),
      API.pnlStats().then(d => { pnl = okObj(d); }),
    ]);
    const el = slot('m-cal'); if (!el) return;
    const off = (!rep || rep.enabled === false) && (!pnl || pnl.enabled === false);
    paint(el, calibrationCard(rep, pnl) + (off ? `<div class="note mt2">戰績儲存（PNL_VAL_URL）未設定，預測自評與紙上戰績暫不可用；勝率回測不受影響。</div>` : ''));
  }

  // ── 2. LINE 狀態（10 分鐘 TTL；讀取失敗 ≠ 未設定） ──
  async function fillLine() {
    line = undefined; const el0 = slot('m-line'); if (el0) paint(el0, lineHtml(line));
    try { const d = await API.lineStatus(); line = (d && typeof d === 'object') ? d : { _err: true }; }
    catch { line = { _err: true }; }
    const el = slot('m-line'); if (el) paint(el, lineHtml(line));
  }

  // ── 3. 版本 ──
  get('/api/version', { ttl: 3600000, timeout: 10000 }).then(d => {
    const el = slot('m-ver'); if (!el) return;
    const v = okObj(d);
    paint(el, chip('前端 v2') + (v && v.version ? chip(`後端 ${esc(v.version)}`, 'gold') : chip('後端 —')) + (v && num(v.names_count) ? chip(`股名庫 <span class="num">${fmtInt(v.names_count)}</span> 檔`) : ''));
  }).catch(() => { const el = slot('m-ver'); if (el) paint(el, chip('前端 v2') + chip('後端 —')); });

  // ── 4. 勝率回測 sheet（topbuys_backtest 6h 快取：首次 30–50 秒，之後秒回） ──
  function onSheetClick(e) {
    const mo = e.target.closest('[data-bt-mo]');
    if (mo) { loadBacktest(+mo.dataset.btMo); return; }
    if (e.target.closest('[data-bt-close]')) closeMySheet();
  }
  function closeMySheet() { if (mySheet) { mySheet = false; closeSheet(); } }
  function openBacktest(months) {
    sheetEl = openSheet(`<div class="stitle"><h2>📊 這套推薦準不準？</h2><button class="btn sm ghost" data-bt-close aria-label="關閉">✕ 關閉</button></div><div id="bt-body"></div>`);
    if (!sheetBound) { sheetEl.addEventListener('click', onSheetClick); sheetBound = true; }
    mySheet = true;
    loadBacktest(months);
  }
  async function loadBacktest(months) {
    const req = ++btReq;
    const body = () => (alive && sheetEl ? sheetEl.querySelector('#bt-body') : null);
    let el = body(); if (!el) return;
    paint(el, `${skLines(4)}<div class="note mt2">回測這套推薦過去 ${months} 個月的每次進場（首次約 30–50 秒，之後秒回）…</div>`);
    let d = null, err = false;
    try { d = okObj(await API.topbuysBacktest(months)); } catch { err = true; }
    if (req !== btReq) return;                                   // 使用者已切換期間，丟棄舊結果
    el = body(); if (!el) return;
    paint(el, err ? emptyState('😵', '回測服務暫時無回應', `<button class="btn sm" data-bt-mo="${months}">重試</button>`) : btHtml(d, months));
  }

  // ── 5. 設定動作 ──
  async function requestNotify() {
    try {
      const r = Notification.requestPermission(() => repaintNotify());   // 舊版 Safari 走 callback
      if (r && typeof r.then === 'function') await r;
    } catch {}
    repaintNotify();
  }
  function repaintNotify() { const el = slot('m-notify'); if (el) paint(el, notifyHtml()); }
  async function doInstall() {
    const ev = window.__installPrompt; if (!ev) return;
    try {
      await ev.prompt();
      const ch = await ev.userChoice;
      if (ch && ch.outcome === 'accepted') toast('已加入主畫面', 'ok');
    } catch {}
    window.__installPrompt = null;                               // 同一個 prompt 事件只能用一次
    const el = slot('m-install'); if (el) paint(el, installHtml());
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(APP_URL); toast('已複製連結', 'ok'); }
    catch { toast('無法自動複製，請長按連結選取', 'err'); }
  }
  async function shareLink() {
    try { await navigator.share({ title: '台股小牛助理', text: '台股推薦、預測與持股健診，每個建議都說為什麼', url: APP_URL }); } catch { /* 使用者取消 */ }
  }

  // ── events (delegated) ──
  function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (act === 'go') location.hash = b.dataset.href;
    else if (act === 'bt') openBacktest(12);
    else if (act === 'theme') { setTheme(b.dataset.val); const el = slot('m-theme'); if (el) el.querySelector('.right').innerHTML = themeSeg(); }
    else if (act === 'unit') { holdings.setUnit(b.dataset.val); syncPortfolio(); const el = slot('m-unit'); if (el) el.querySelector('.right').innerHTML = unitSeg(); toast(`持股單位改為「${b.dataset.val === 'lot' ? '張' : '股'}」`, 'ok'); }
    else if (act === 'notify') requestNotify();
    else if (act === 'install') doInstall();
    else if (act === 'copy') copyLink();
    else if (act === 'share') shareLink();
    else if (act === 'retry-line') fillLine();
  }
  view.addEventListener('click', onClick);

  // ── kick off — nothing awaited, first paint is the shell above ──
  fillCal(); fillLine();

  return () => {
    alive = false;
    view.removeEventListener('click', onClick);
    if (sheetEl && sheetBound) sheetEl.removeEventListener('click', onSheetClick);
    closeMySheet();
  };
}
