// 台股小牛 v2 — shared UI utilities (no framework, no build).
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function render(target, html) {
  const el = typeof target === 'string' ? $(target) : target;
  if (el) el.innerHTML = html;
  return el;
}

// ── number formatting (台股 紅漲綠跌) ──
export const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? null : Number(v);
export function cls(v) { const n = num(v); return n === null ? 'flat' : n > 0 ? 'up' : n < 0 ? 'down' : 'flat'; }
export function signPct(v, d = 2) { const n = num(v); return n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(d)}%`; }
export function fmtPrice(v) {
  const n = num(v); if (n === null) return '—';
  if (n >= 1000) return n.toLocaleString('zh-TW', { maximumFractionDigits: 1 });
  return n.toLocaleString('zh-TW', { maximumFractionDigits: 2 });
}
export function fmtInt(v) { const n = num(v); return n === null ? '—' : Math.round(n).toLocaleString('zh-TW'); }
export function pctPill(v) { const c = cls(v); return `<span class="pill-num num ${c}">${signPct(v, 2)}</span>`; }
export function arrow(v) { const c = cls(v); return c === 'up' ? '▲' : c === 'down' ? '▼' : '─'; }

export function timeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return String(iso);
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return '剛剛'; if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`; if (s < 7 * 86400) return `${Math.floor(s / 86400)} 天前`;
  return d.toLocaleDateString('zh-TW');
}
export function twNow() { return new Date(Date.now() + (new Date().getTimezoneOffset() + 480) * 60000); }
export function marketOpen() {
  const t = twNow(); const m = t.getHours() * 60 + t.getMinutes();
  return t.getDay() >= 1 && t.getDay() <= 5 && m >= 9 * 60 && m <= 13 * 60 + 30;
}

// ── skeletons ──
export const skLines = (n = 3) => Array.from({ length: n }, (_, i) => `<div class="sk sk-line" style="width:${[92, 70, 82, 60][i % 4]}%">.</div>`).join('');
export const skCards = (n = 3) => Array.from({ length: n }, () => `<div class="card"><div class="sk sk-line" style="width:45%">.</div><div class="sk sk-line" style="width:85%">.</div><div class="sk sk-line" style="width:65%">.</div></div>`).join('');

// ── toast ──
let toastT = null;
export function toast(msg, type = '') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.className = `toast show ${type}`;
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2400);
}

// ── bottom sheet ──
export function openSheet(html) {
  let bd = $('#backdrop'), sh = $('#sheet');
  if (!bd) { bd = document.createElement('div'); bd.id = 'backdrop'; bd.className = 'backdrop'; bd.onclick = closeSheet; document.body.appendChild(bd); }
  if (!sh) { sh = document.createElement('div'); sh.id = 'sheet'; sh.className = 'sheet'; document.body.appendChild(sh); }
  sh.innerHTML = `<div class="grab"></div>${html}`;
  bd.style.display = 'block'; sh.style.display = 'block';
  requestAnimationFrame(() => { bd.classList.add('show'); sh.classList.add('show'); });
  document.body.style.overflow = 'hidden';
  return sh;
}
export function closeSheet() {
  const bd = $('#backdrop'), sh = $('#sheet'); if (!bd || !sh) return;
  bd.classList.remove('show'); sh.classList.remove('show'); document.body.style.overflow = '';
  setTimeout(() => { bd.style.display = 'none'; sh.style.display = 'none'; }, 260);
}

// ── progress bar ──
let progT = null;
export function progress(on) {
  let p = $('#progress');
  if (!p) { p = document.createElement('div'); p.id = 'progress'; p.className = 'progress'; document.body.appendChild(p); }
  clearTimeout(progT);
  if (on) { p.classList.add('on'); p.style.width = '30%'; progT = setTimeout(() => p.style.width = '80%', 600); }
  else { p.style.width = '100%'; progT = setTimeout(() => { p.classList.remove('on'); p.style.width = '0'; }, 250); }
}

// ── theme ──
export function initTheme() {
  let saved = null; try { saved = localStorage.getItem('theme'); } catch {}
  if (saved) document.documentElement.dataset.theme = saved;
  syncThemeColor();
}
export function toggleTheme() {
  const cur = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next; try { localStorage.setItem('theme', next); } catch {} syncThemeColor();
  return next;
}
export function isLight() { return document.documentElement.dataset.theme === 'light'; }
function syncThemeColor() {
  const m = $('meta[name="theme-color"]'); if (m) m.content = isLight() ? '#F4F5FB' : '#0B1226';   // = tokens --bg
}
export function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// ── pull to refresh (touch only) ──
export function pullToRefresh(onRefresh) {
  const ind = $('#ptr'); if (!ind) return;
  let y0 = null, armed = false;
  // 不在 sheet／圖表內、頁面在最上方時才啟動（sheet 內下拉、K 線拖曳不該觸發整頁刷新）
  window.addEventListener('touchstart', e => { const inside = e.target && e.target.closest && e.target.closest('#sheet, .kchart, .eqchart'); y0 = (!inside && window.scrollY <= 0) ? e.touches[0].clientY : null; }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (y0 === null) return;
    const dy = e.touches[0].clientY - y0;
    if (dy > 70 && !armed) { armed = true; ind.textContent = '↻ 放開刷新'; ind.classList.add('arm'); }
    else if (dy <= 70 && armed) { armed = false; ind.textContent = '↓ 下拉刷新'; }
  }, { passive: true });
  window.addEventListener('touchend', () => { if (armed) { armed = false; ind.classList.remove('arm'); onRefresh(); } y0 = null; }, { passive: true });
}

// ── persistence helpers ──
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
