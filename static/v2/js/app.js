// 台股小牛 v2 — app shell: hash router, tab bar, header ticker, theme, PWA.
import { $, $$, render, toast, initTheme, toggleTheme, isLight, pullToRefresh, progress, twNow, marketOpen, fmtInt, signPct, cls } from './ui.js';
import { API, invalidate } from './api.js';
import { openSearchSheet, restorePortfolio } from './components.js';

const VIEWS = {
  home:      () => import('./views/home.js'),
  picks:     () => import('./views/picks.js'),
  market:    () => import('./views/market.js'),
  portfolio: () => import('./views/portfolio.js'),
  more:      () => import('./views/more.js'),
  stock:     () => import('./views/stock.js'),
  tools:     () => import('./views/tools.js'),
};
// which bottom tab lights up for each route
const TAB_OF = { home: 'home', picks: 'picks', market: 'market', portfolio: 'portfolio', more: 'more', stock: null, tools: 'more' };
const NO_TABBAR = new Set(['stock']);   // pushed screens use a back header

let current = { name: null, params: null, teardown: null };
const scrollPos = {};
let navSeq = 0;   // 連續快速切換：只有最後一次 navigate 的結果算數，中途完成的 view 立刻拆掉

function parseHash() {
  const h = (location.hash || '#/home').replace(/^#\/?/, '');
  const [name, ...rest] = h.split('/');
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };   // 壞掉的 %xx 不能讓 router 掛掉
  return { name: Object.prototype.hasOwnProperty.call(VIEWS, name) ? name : 'home', params: rest.map(dec) };
}

export async function navigate() {
  const { name, params } = parseHash();
  if (current.name) scrollPos[current.name] = window.scrollY;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === TAB_OF[name]));
  document.body.classList.toggle('no-tabbar', NO_TABBAR.has(name));
  if (current.teardown) { try { current.teardown(); } catch {} }
  const view = $('#view');
  view.classList.remove('page'); void view.offsetWidth; view.classList.add('page');
  progress(true);
  const my = ++navSeq;
  current = { name, params, teardown: null };
  try {
    const mod = await VIEWS[name]();
    if (my !== navSeq) return;   // 已被更新的 navigate 取代（它會自己畫）
    const teardown = await mod.render(view, params);
    if (my !== navSeq) { try { if (teardown) teardown(); } catch {} return; }   // 畫完時已過時 → 立刻拆掉，不留 listener／interval
    current = { name, params, teardown };
    window.scrollTo({ top: NO_TABBAR.has(name) ? 0 : (scrollPos[name] || 0) });
  } catch (e) {
    if (my !== navSeq) return;
    console.error(e);
    render(view, `<div class="empty"><div class="big">😵</div>這一頁載入失敗<br><button class="btn sm mt3" onclick="location.reload()">重新載入</button></div>`);
  } finally { progress(false); }
}

function greeting() {
  const t = twNow(); const h = t.getHours(); const wd = t.getDay();
  const day = ['日', '一', '二', '三', '四', '五', '六'][wd];
  const date = `${t.getMonth() + 1}/${t.getDate()}（週${day}）`;
  if (wd === 0 || wd === 6) return `${date} · 週末休市`;
  if (marketOpen()) return `${date} · 🟢 盤中`;
  if (h < 9) return `${date} · 盤前`;
  return `${date} · 已收盤`;
}
async function ticker() {
  const el = $('#hdr-index'); if (!el) return;
  try {
    const d = await API.marketSummary();
    const t = d.tse;
    if (t && t.price) { const c = cls(t.change_pct); el.innerHTML = `<div class="dim xs">加權</div><div class="b ${c}">${fmtInt(t.price)} <span class="xs">${signPct(t.change_pct, 2)}</span></div>`; }
  } catch {}
}

function bindChrome() {
  $('#brand-sub').textContent = greeting();
  $('#btn-theme').textContent = isLight() ? '🌙' : '☀️';
  $('#btn-theme').onclick = () => { toggleTheme(); $('#btn-theme').textContent = isLight() ? '🌙' : '☀️'; navigate(); };
  $('#btn-search').onclick = openSearchSheet;
  pullToRefresh(async () => { invalidate('/api/'); await navigate(); ticker(); toast('已更新', 'ok'); });
  window.addEventListener('hashchange', navigate);
  window.addEventListener('online', () => { $('#offline').hidden = true; navigate(); });
  window.addEventListener('offline', () => { $('#offline').hidden = false; });
  if (!navigator.onLine) $('#offline').hidden = false;
  setInterval(() => { $('#brand-sub').textContent = greeting(); if (marketOpen() && !document.hidden) ticker(); }, 30000);
  // '/' shortcut → search (desktop nicety)
  window.addEventListener('keydown', e => { if (e.key === '/' && !/input|textarea/i.test(e.target.tagName)) { e.preventDefault(); openSearchSheet(); } });
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/v2/sw.js', { scope: '/v2/' }).catch(() => {});
}

// Capture Android's install prompt early so 更多›設定 can offer a real install button.
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); window.__installPrompt = e; });
window.__toggleTheme = () => { toggleTheme(); $('#btn-theme').textContent = isLight() ? '🌙' : '☀️'; };

initTheme();
bindChrome();
ticker();
restorePortfolio().finally(navigate);
registerSW();
window.__go = (hash) => { location.hash = hash; };
