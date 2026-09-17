// 台股小牛 v2 — charts on top of lightweight-charts (loaded globally from CDN).
// K-line with MA20/MA60, volume, and OVERLAYS: entry / stop / target price lines
// and the 🔮 5-day prediction band (dashed lo/hi). 台股 colours: 紅漲綠跌.
import { cssVar, isLight } from './ui.js';

const LW = () => window.LightweightCharts;

function theme() {
  return {
    bg: 'transparent', text: cssVar('--dim') || '#7F8899', grid: isLight() ? '#EEF1F6' : '#1B2333',
    up: cssVar('--up') || '#FF4D6A', down: cssVar('--down') || '#00D68F', gold: cssVar('--gold') || '#F5B731',
    ma20: '#5B8CFF', ma60: '#A78BFA',
  };
}

/** Normalize any backend candle shape to {time:'YYYY-MM-DD', open, high, low, close, volume}. */
export function normalizeCandles(rows) {
  return (rows || []).map(r => {
    const t = r.time || r.date || r.d || '';
    const time = /^\d{8}$/.test(String(t)) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : String(t).slice(0, 10).replace(/\//g, '-');
    const close = Number(r.close ?? r.c);
    return { time, open: Number(r.open ?? r.o ?? close), high: Number(r.high ?? r.h ?? close), low: Number(r.low ?? r.l ?? close), close, volume: Number(r.volume ?? r.v ?? 0) };
  }).filter(c => c.time && Number.isFinite(c.close) && c.close > 0);
}

function sma(candles, p) {
  const out = []; let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close; if (i >= p) sum -= candles[i - p].close;
    if (i >= p - 1) out.push({ time: candles[i].time, value: +(sum / p).toFixed(2) });
  }
  return out;
}

/**
 * mountKLine(el, candles, overlays)
 * overlays: { entry, stop, target, range5:[lo,hi], range1:[lo,hi], showMA:true }
 * returns { chart, destroy }
 */
export function mountKLine(el, candles, overlays = {}) {
  const L = LW(); if (!L) { el.innerHTML = '<div class="empty">圖表元件載入中…</div>'; return null; }
  const c = theme();
  el.innerHTML = '';
  const chart = L.createChart(el, {
    layout: { background: { type: 'solid', color: c.bg }, textColor: c.text, fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.22 } },
    timeScale: { borderVisible: false, timeVisible: false, rightOffset: 4 },
    crosshair: { mode: 1 },
    handleScroll: { pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { pinch: true, mouseWheel: true, axisPressedMouseMove: true },
    autoSize: true,
  });
  const candle = chart.addCandlestickSeries({
    upColor: c.up, downColor: c.down, borderUpColor: c.up, borderDownColor: c.down, wickUpColor: c.up, wickDownColor: c.down,
    priceLineVisible: true, lastValueVisible: true,
  });
  candle.setData(candles);
  const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  vol.setData(candles.map(k => ({ time: k.time, value: k.volume, color: k.close >= k.open ? c.up + '66' : c.down + '66' })));
  if (overlays.showMA !== false && candles.length > 60) {
    chart.addLineSeries({ color: c.ma20, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(sma(candles, 20));
    chart.addLineSeries({ color: c.ma60, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(sma(candles, 60));
  }
  const line = (price, color, title, style = 0) => price && candle.createPriceLine({ price: Number(price), color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
  line(overlays.entry, c.gold, '進場');
  line(overlays.stop, c.down, '停損');
  line(overlays.target, c.up, '目標');
  if (overlays.range5 && overlays.range5.length === 2) {
    line(overlays.range5[1], c.gold + 'AA', '5日區間上緣', 2);
    line(overlays.range5[0], c.gold + 'AA', '5日區間下緣', 2);
  }
  chart.timeScale().fitContent();
  if (candles.length > 90) chart.timeScale().setVisibleLogicalRange({ from: candles.length - 90, to: candles.length + 3 });
  return { chart, destroy: () => chart.remove() };
}

/** Equity curve for 累計戰績: points [{date:'YYYY-MM-DD', cum:number}] */
export function mountEquity(el, points) {
  const L = LW(); if (!L || !points || points.length < 2) { el.innerHTML = '<div class="empty sm">需要至少 2 筆已平倉交易才會畫曲線</div>'; return null; }
  const c = theme();
  el.innerHTML = '';
  const chart = L.createChart(el, {
    layout: { background: { type: 'solid', color: c.bg }, textColor: c.text },
    grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
    handleScroll: false, handleScale: false, autoSize: true,
  });
  const last = points[points.length - 1].cum;
  const col = last >= 0 ? c.up : c.down;
  const s = chart.addAreaSeries({ lineColor: col, topColor: col + '55', bottomColor: col + '05', lineWidth: 2, priceLineVisible: false });
  // dedupe same-date points (lightweight-charts requires ascending unique times)
  const seen = new Map();
  for (const p of points) { const t = String(p.date).slice(0, 10); if (t) seen.set(t, { time: t, value: Number(p.cum) }); }
  s.setData([...seen.values()].sort((a, b) => a.time < b.time ? -1 : 1));
  s.createPriceLine({ price: 0, color: c.text, lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  chart.timeScale().fitContent();
  return { chart, destroy: () => chart.remove() };
}
