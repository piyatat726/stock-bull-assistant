#!/usr/bin/env python3
import json, datetime, time, threading, requests, os, subprocess, re
import urllib.parse, email.utils
import xml.etree.ElementTree as ET
from flask import Flask, jsonify, send_from_directory, request

app = Flask(__name__, static_folder='static')
APP_VERSION = 'v3'  # deploy check marker

WATCHLIST_FILE = 'watchlist.json'
TUNNEL_URL_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tunnel_url.txt')
DEFAULT_WATCHLIST = [
    {"code": "2330", "name": "台積電", "market": "tse"},
    {"code": "3450", "name": "聯鈞", "market": "tse"},
    {"code": "1723", "name": "中碳", "market": "tse"},
    {"code": "6788", "name": "華景電", "market": "otc"},
]

HEADERS = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}
API_BASE = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp'

cache = {}
CACHE_TTL = 15

SECTORS = [
    ('t00','加權指數'),('t14','電子'),('t21','半導體'),('t22','電腦週邊'),
    ('t23','光電'),('t24','通信網路'),('t25','電子零組件'),('t18','金融'),
    ('t01','水泥'),('t03','塑膠'),('t11','鋼鐵'),('t16','航運'),
    ('t08','生技醫療'),('t15','建材營造'),('t17','觀光'),('t20','油電燃氣'),
]

POPULAR_TSE = ['2330','2317','2454','2308','2882','2881','2891','3711','2303','2002',
               '1301','1303','2412','3008','2886','6505','1326','2357','5880','2892',
               '3034','2327','4938','3231','6669','2345','3037','2474','1723','3450',
               '2382','2395','3443','2603','2609','2615','4904','2105','1216','2207']
POPULAR_OTC = ['6788','3105','6547','5765','4966','3293','6510','8069','6679','5904',
               '6426','3529','6180','8044','4763','6770','5289','6592','3707','6781']
POPULAR_ETF = [('0050','tse'),('0056','tse'),('00878','tse'),('00919','tse'),
               ('00929','tse'),('006208','tse'),('00713','tse'),('00940','tse')]
# AI / 科技股 universe for 科技股精選 (semiconductors, AI servers, networking, components)
TECH_AI = [
    # 半導體 / IC 設計
    ('2330','tse'),('2454','tse'),('2303','tse'),('3711','tse'),('2379','tse'),
    ('3034','tse'),('3443','tse'),('3661','tse'),('5269','tse'),('6415','tse'),
    ('2408','tse'),('2344','tse'),('3035','tse'),('8299','otc'),('4966','otc'),
    ('5347','otc'),('5274','otc'),('6531','otc'),('6770','otc'),
    # AI 伺服器 / 代工 / 散熱
    ('2317','tse'),('2382','tse'),('3231','tse'),('6669','tse'),('2356','tse'),
    ('4938','tse'),('2376','tse'),('2357','tse'),('3017','tse'),('3324','tse'),
    ('2301','tse'),
    # 網通 / PCB / 光學
    ('2345','tse'),('3037','tse'),('8046','tse'),('3008','tse'),
]

# Chinese name mapping — loaded from stock_names.json (11K+ stocks)
# Falls back to hardcoded popular stocks if file is missing
_FALLBACK_NAMES = {
    '2330':'台積電','2317':'鴻海','2454':'聯發科','2308':'台達電',
    '2882':'國泰金','2881':'富邦金','2891':'中信金','3711':'日月光投控',
    '2303':'聯電','2002':'中鋼','1301':'台塑','1303':'南亞',
    '2412':'中華電','3008':'大立光','2886':'兆豐金','6505':'台塑化',
    '1326':'台化','2357':'華碩','5880':'合庫金','2892':'第一金',
    '3034':'聯詠','4938':'和碩','3231':'緯創','2345':'智邦','3037':'欣興',
    '1723':'中碳','3450':'聯鈞','2382':'廣達','3443':'創意',
    '2603':'長榮','2609':'陽明','2615':'萬海','4904':'遠傳','1216':'統一',
    '6788':'華景電','3105':'穩懋','8069':'元太','6770':'力積電',
    '3293':'鈊象','0050':'元大台灣50','0056':'元大高股息',
    '00878':'國泰永續高股息','00929':'復華台灣科技優息',
}
try:
    _names_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'stock_names.json')
    with open(_names_path, 'r', encoding='utf-8') as f:
        STOCK_NAMES = json.load(f)
    print(f'[INFO] Loaded {len(STOCK_NAMES)} stock names from stock_names.json')
except Exception:
    STOCK_NAMES = _FALLBACK_NAMES
    print(f'[WARN] stock_names.json not found, using {len(STOCK_NAMES)} fallback names')
_name_cache = {}  # dynamic cache from TWSE responses

def cached_get(url, ttl=CACHE_TTL, timeout=15):
    now = time.time()
    if url in cache and now - cache[url]['t'] < ttl:
        return cache[url]['data']
    try:
        r = requests.get(url, headers=HEADERS, timeout=timeout)
        data = r.json()
        cache[url] = {'data': data, 't': now}
        return data
    except Exception:
        return cache.get(url, {}).get('data', {})

# ── News fetching (robust Google News RSS) ──────────────────────────────
# Junk-feed markers: when Google rate-limits, it returns a generic lifestyle
# feed instead of the queried results. We detect & reject these.
_NEWS_JUNK_KW = ['郊遊', '夜市', '湯圓', '炒麵', '臭豆腐', '劇集', '閨密', '星座', '食譜', '旅遊景點']
# Low-value portal / homepage entries (no real headline) — drop these
_NEWS_PORTAL_KW = ['基智網', 'FundDJ', 'Anue鉅亨網', 'Yahoo奇摩股市首頁']
_news_cache = {}  # query -> {'items': [...], 't': ts}  (last KNOWN-GOOD results)

def _parse_pubdate(s):
    if not s:
        return None
    try:
        return email.utils.parsedate_to_datetime(s)
    except Exception:
        return None

def _looks_like_junk(items):
    """Detect Google's generic fallback feed (returned when rate-limited)."""
    if not items:
        return True
    junk = sum(1 for n in items if any(kw in n['title'] for kw in _NEWS_JUNK_KW))
    return junk >= max(2, len(items) // 3)

def fetch_google_news(query, limit=30, ttl=180, min_items=2):
    """Fetch news from Google RSS: properly URL-encoded, newest-first, cached,
    with a quality guard that serves last-good results if Google returns junk."""
    now = time.time()
    ck = query.strip()
    cached = _news_cache.get(ck)
    if cached and now - cached['t'] < ttl:
        return cached['items'][:limit]

    items = []
    try:
        q = urllib.parse.quote(query.strip())
        url = f'https://news.google.com/rss/search?q={q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant'
        r = requests.get(url, headers=HEADERS, timeout=8)
        root = ET.fromstring(r.content)
        for item in root.findall('.//item'):
            t = item.find('title')
            l = item.find('link')
            p = item.find('pubDate')
            s = item.find('source')
            if t is not None and t.text:
                if any(kw in t.text for kw in _NEWS_PORTAL_KW):
                    continue  # skip portal/homepage non-articles
                items.append({
                    'title': t.text,
                    'link': l.text if l is not None else '',
                    'date': p.text if p is not None else '',
                    'source': s.text if s is not None else '',
                    '_ts': _parse_pubdate(p.text if p is not None else ''),
                })
    except Exception:
        items = []

    # Reject junk / too-few results → serve last known-good cache instead
    if _looks_like_junk(items) or len(items) < min_items:
        if cached:
            return cached['items'][:limit]
        return [] if _looks_like_junk(items) else _finalize_news(items)[:limit]

    items = _finalize_news(items)
    _news_cache[ck] = {'items': items, 't': now}
    return items[:limit]

def _finalize_news(items):
    """Sort newest-first and strip internal fields."""
    _MIN = datetime.datetime.min.replace(tzinfo=datetime.timezone.utc)
    items.sort(key=lambda x: x.get('_ts') or _MIN, reverse=True)
    for it in items:
        it.pop('_ts', None)
    return items

def load_watchlist():
    try:
        with open(WATCHLIST_FILE, 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        save_watchlist(DEFAULT_WATCHLIST)
        return DEFAULT_WATCHLIST

def save_watchlist(data):
    with open(WATCHLIST_FILE, 'w') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def parse_stock(item):
    try:
        yesterday = float(item.get('y', '0')) if item.get('y', '-') != '-' else 0
        z_val = item.get('z', '-')
        traded = bool(z_val and z_val != '-')
        if traded:
            current = float(z_val)
            change = current - yesterday
            change_pct = (change / yesterday * 100) if yesterday else 0
        else:
            # No real trade tick yet (pre-market / post-close). Show previous
            # close flat — never fabricate a gain/loss from the bid quote.
            bid_str = item.get('b', '').split('_')[0]
            current = float(bid_str) if (bid_str and bid_str != '-' and yesterday == 0) else yesterday
            change = 0
            change_pct = 0
        if current == 0 and yesterday == 0:
            return None
        buy_prices = [float(p) for p in item.get('b', '').split('_') if p and p != '-']
        sell_prices = [float(p) for p in item.get('a', '').split('_') if p and p != '-']
        op = item.get('o', '-')
        hi = item.get('h', '-')
        lo = item.get('l', '-')
        if op == '-' and current > 0:
            op = str(current)
        if hi == '-' and current > 0:
            hi = str(current)
        if lo == '-' and current > 0:
            lo = str(current)
        code = item.get('c', '')
        name = item.get('n', '')
        if code and name:
            _name_cache[code] = name
        return {
            'code': code, 'name': name,
            'price': current, 'yesterday': yesterday,
            'change': round(change, 2), 'change_pct': round(change_pct, 2),
            'open': op, 'high': hi, 'low': lo,
            'volume': item.get('v', '-'),
            'time': item.get('t', ''), 'market': item.get('ex', 'tse'),
            'limit_up': item.get('u', '-'), 'limit_down': item.get('w', '-'),
            'best_bid': buy_prices[0] if buy_prices else '-',
            'best_ask': sell_prices[0] if sell_prices else '-',
        }
    except (ValueError, TypeError):
        return None

def _fetch_yahoo_single(code, suffix, market):
    """Fetch a single stock from Yahoo Finance with given suffix"""
    sym = f'{code}{suffix}'
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=5d'
    data = cached_get(url, ttl=30)
    result = data.get('chart', {}).get('result')
    if not result:
        return None
    result = result[0]
    meta = result.get('meta', {})
    price = meta.get('regularMarketPrice')
    prev = meta.get('chartPreviousClose') or meta.get('previousClose')
    if not price:
        return None
    price, prev = float(price), float(prev) if prev else float(price)
    change = round(price - prev, 2)
    change_pct = round((change / prev * 100), 2) if prev else 0
    indicators = result.get('indicators', {}).get('quote', [{}])[0]
    volumes = indicators.get('volume', [])
    opens = indicators.get('open', [])
    highs = indicators.get('high', [])
    lows = indicators.get('low', [])
    vol = volumes[-1] if volumes and volumes[-1] else 0
    op = opens[-1] if opens and opens[-1] else price
    hi = highs[-1] if highs and highs[-1] else price
    lo = lows[-1] if lows and lows[-1] else price
    name = STOCK_NAMES.get(code) or _name_cache.get(code) or meta.get('shortName', meta.get('symbol', code))
    if name: name = name.replace('.TW', '').replace('.TWO', '').strip()
    actual_market = 'otc' if suffix == '.TWO' else 'tse'
    return {
        'code': code, 'name': name,
        'price': price, 'yesterday': prev,
        'change': change, 'change_pct': change_pct,
        'open': str(round(op, 2)), 'high': str(round(hi, 2)), 'low': str(round(lo, 2)),
        'volume': str(int(vol / 1000)) if vol else '-',
        'time': '', 'market': actual_market,
        'limit_up': '-', 'limit_down': '-',
        'best_bid': '-', 'best_ask': '-',
    }

def fetch_stock_yahoo(code, market='tse'):
    """Yahoo Finance fallback for when TWSE API is blocked (e.g. cloud deploy outside Taiwan)"""
    suffix = '.TW' if market == 'tse' else '.TWO'
    try:
        result = _fetch_yahoo_single(code, suffix, market)
        if result:
            return result
        # Try opposite market as fallback (some stocks are TSE/OTC misclassified)
        alt_suffix = '.TWO' if suffix == '.TW' else '.TW'
        return _fetch_yahoo_single(code, alt_suffix, market)
    except Exception:
        return None

def fetch_stocks(code_market_pairs):
    if not code_market_pairs:
        return []
    # Try TWSE MIS realtime API first — but with a SHORT timeout: outside
    # Taiwan (or when MIS is throttled) it can hang ~15s, and we have a fast
    # Yahoo fallback. In Taiwan MIS answers in <1s so there's no penalty.
    ex_ch = '|'.join([f'{m}_{c}.tw' for c, m in code_market_pairs])
    data = cached_get(f'{API_BASE}?ex_ch={ex_ch}', timeout=5)
    results = []
    for item in data.get('msgArray', []):
        s = parse_stock(item)
        if s and s['code']:
            results.append(s)
    # Fallback to Yahoo Finance if TWSE returned nothing (cloud deploy outside Taiwan)
    if not results and code_market_pairs:
        for code, market in code_market_pairs:
            s = fetch_stock_yahoo(code, market)
            if s:
                results.append(s)
    # Always apply Chinese name mapping (ensures cloud version shows Chinese)
    for r in results:
        cn = STOCK_NAMES.get(r['code']) or _name_cache.get(r['code'])
        if cn:
            r['name'] = cn
    return results

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/api/version')
def version():
    test_code = request.args.get('test', '2317')
    return jsonify({
        'version': APP_VERSION,
        'names_count': len(STOCK_NAMES),
        'test_lookup': STOCK_NAMES.get(test_code, 'NOT_FOUND'),
        'cache_lookup': _name_cache.get(test_code, 'NOT_IN_CACHE'),
        'stock_names_keys_sample': list(STOCK_NAMES.keys())[:10],
    })

@app.route('/api/watchlist', methods=['GET'])
def get_watchlist():
    wl = load_watchlist()
    for w in wl:
        if w.get('code') and w.get('name'):
            _name_cache[w['code']] = w['name']
    return jsonify(wl)

@app.route('/api/watchlist/add', methods=['POST'])
def add_to_watchlist():
    item = request.get_json()
    if not item or 'code' not in item:
        return jsonify({'error': 'need code'}), 400
    wl = load_watchlist()
    if any(w['code'] == item['code'] for w in wl):
        return jsonify({'error': 'already exists'}), 400
    for market in ['tse', 'otc']:
        results = fetch_stocks([(item['code'], market)])
        if results and results[0].get('name'):
            wl.append({'code': item['code'], 'name': results[0]['name'], 'market': market})
            save_watchlist(wl)
            return jsonify({'ok': True, 'item': wl[-1]})
    return jsonify({'error': 'stock not found'}), 404

@app.route('/api/watchlist/remove', methods=['POST'])
def remove_from_watchlist():
    item = request.get_json()
    if not item or 'code' not in item:
        return jsonify({'error': 'need code'}), 400
    wl = load_watchlist()
    wl = [w for w in wl if w['code'] != item['code']]
    save_watchlist(wl)
    return jsonify({'ok': True})

@app.route('/api/realtime')
def get_realtime():
    codes = request.args.get('codes', '')
    markets = request.args.get('markets', '')
    if not codes:
        return jsonify([])
    code_list = codes.split(',')
    market_list = markets.split(',') if markets else ['tse'] * len(code_list)
    return jsonify(fetch_stocks(list(zip(code_list, market_list))))

@app.route('/api/market_summary')
def market_summary():
    data = cached_get(f'{API_BASE}?ex_ch=tse_t00.tw|otc_o00.tw')
    result = {}
    for item in data.get('msgArray', []):
        s = parse_stock(item)
        if not s:
            continue
        if item.get('c') == 't00':
            result['tse'] = s
        elif item.get('c') == 'o00':
            result['otc'] = s
    # Yahoo Finance fallback for indices
    if 'tse' not in result or 'otc' not in result:
        for sym, key, name in [('%5ETWII', 'tse', '加權指數'), ('%5ETWO', 'otc', '櫃買指數')]:
            if key in result:
                continue
            try:
                url = f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=5d'
                d = cached_get(url, ttl=30)
                meta = d.get('chart', {}).get('result', [{}])[0].get('meta', {})
                price = meta.get('regularMarketPrice')
                prev = meta.get('chartPreviousClose') or meta.get('previousClose')
                if price and prev:
                    price, prev = float(price), float(prev)
                    chg = round(price - prev, 2)
                    pct = round((chg / prev * 100), 2) if prev else 0
                    result[key] = {
                        'code': 't00' if key == 'tse' else 'o00', 'name': name,
                        'price': price, 'yesterday': prev,
                        'change': chg, 'change_pct': pct,
                        'open': '-', 'high': '-', 'low': '-', 'volume': '-',
                        'time': '', 'market': key,
                        'limit_up': '-', 'limit_down': '-',
                        'best_bid': '-', 'best_ask': '-',
                    }
            except Exception:
                pass
    return jsonify(result)

@app.route('/api/top_movers')
def top_movers():
    pairs = [(c, 'tse') for c in POPULAR_TSE] + [(c, 'otc') for c in POPULAR_OTC]
    results = fetch_stocks(pairs)
    valid = [r for r in results if r['change'] != 0]
    gainers = sorted([r for r in valid if r['change'] > 0], key=lambda x: x['change_pct'], reverse=True)[:8]
    losers = sorted([r for r in valid if r['change'] < 0], key=lambda x: x['change_pct'])[:8]
    return jsonify({'gainers': gainers, 'losers': losers})

@app.route('/api/search')
def search_stock():
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify([])
    # 1. If query is a stock code (digits), search directly
    if query.isdigit() or query.startswith('00'):
        for market in ['tse', 'otc']:
            results = fetch_stocks([(query, market)])
            if results and results[0].get('name'):
                return jsonify(results)
    # 2. If query is a Chinese name, look up code from NAME_TO_CODE or STOCK_NAMES
    code = NAME_TO_CODE.get(query)
    if code:
        for market in ['tse', 'otc']:
            results = fetch_stocks([(code, market)])
            if results and results[0].get('name'):
                return jsonify(results)
    # 3. Partial name match — search through STOCK_NAMES and _name_cache
    matches = []
    all_names = {**STOCK_NAMES, **{v: k for k, v in _name_cache.items() if k not in STOCK_NAMES}}
    for code, name in STOCK_NAMES.items():
        if query in name or query in code:
            matches.append((code, name))
    for code, name in _name_cache.items():
        if code not in STOCK_NAMES and (query in name or query in code):
            matches.append((code, name))
    if matches:
        # Fetch real-time data for first 5 matches
        pairs = []
        for code, name in matches[:5]:
            market = 'otc' if code in [c for c in POPULAR_OTC] else 'tse'
            pairs.append((code, market))
        results = []
        for code, market in pairs:
            r = fetch_stocks([(code, market)])
            if r:
                results.extend(r)
        if results:
            return jsonify(results)
    # 4. Fallback: try as stock code on both markets
    for market in ['tse', 'otc']:
        results = fetch_stocks([(query, market)])
        if results and results[0].get('name'):
            return jsonify(results)
    return jsonify([])

@app.route('/api/stock_analysis')
def stock_analysis():
    """Analyze a single stock and give buy/sell/hold recommendation with commentary"""
    code = request.args.get('code', '').strip()
    if not code:
        return jsonify({'error': 'need code'}), 400

    fund_map = _fetch_pe_pb_yield()
    rev_map = _fetch_revenue_growth()
    inst_map = _fetch_institutional()

    fund = fund_map.get(code, {})
    rev = rev_map.get(code, {})
    inst = inst_map.get(code)

    pe = fund.get('pe')
    dy = fund.get('yield')
    pb = fund.get('pb')
    yoy = rev.get('yoy')
    mom = rev.get('mom')
    rev_amount = rev.get('revenue', 0)

    # Build scores for both directions
    buy_score = 0
    sell_score = 0
    buy_reasons = []
    sell_reasons = []

    # ── PE ratio ──
    if pe is not None:
        if pe < 0:
            sell_score += 4
            sell_reasons.append(f'本益比為負 ({pe:.1f})，公司處於虧損狀態')
        elif pe <= 12:
            buy_score += 4
            buy_reasons.append(f'本益比僅 {pe:.1f}，估值極低，具投資價值')
        elif pe <= 18:
            buy_score += 3
            buy_reasons.append(f'本益比 {pe:.1f}，估值合理偏低')
        elif pe <= 25:
            buy_score += 1
        elif pe <= 40:
            sell_score += 1
        elif pe > 60:
            sell_score += 3
            sell_reasons.append(f'本益比高達 {pe:.1f}，估值偏貴，需留意回檔風險')
        elif pe > 40:
            sell_score += 2
            sell_reasons.append(f'本益比 {pe:.1f}，估值偏高')

    # ── Dividend yield ──
    if dy is not None:
        if dy >= 6:
            buy_score += 4
            buy_reasons.append(f'殖利率高達 {dy:.1f}%，適合存股族')
        elif dy >= 4:
            buy_score += 3
            buy_reasons.append(f'殖利率 {dy:.1f}%，配息穩定')
        elif dy >= 2:
            buy_score += 1
        elif dy == 0 and pe is not None and pe > 30:
            sell_score += 2
            sell_reasons.append('不配息且本益比偏高')

    # ── PB ratio ──
    if pb is not None:
        if pb < 1:
            buy_score += 3
            buy_reasons.append(f'股價淨值比 {pb:.2f}，低於淨值，股價可能被低估')
        elif pb < 1.5:
            buy_score += 2
            buy_reasons.append(f'股價淨值比 {pb:.2f}，估值偏低')
        elif pb > 10:
            sell_score += 3
            sell_reasons.append(f'淨值比 {pb:.2f}，市場給予極高溢價，風險大')
        elif pb > 5:
            sell_score += 2
            sell_reasons.append(f'淨值比 {pb:.2f}，估值偏高')

    # ── Revenue YoY growth ──
    if yoy is not None:
        if yoy >= 50:
            buy_score += 5
            buy_reasons.append(f'營收年增 {yoy:+.1f}%，成長力道強勁')
        elif yoy >= 20:
            buy_score += 3
            buy_reasons.append(f'營收年增 {yoy:+.1f}%，穩健成長')
        elif yoy >= 5:
            buy_score += 1
        elif yoy <= -30:
            sell_score += 5
            sell_reasons.append(f'營收年減 {yoy:.1f}%，基本面嚴重惡化')
        elif yoy <= -10:
            sell_score += 3
            sell_reasons.append(f'營收年減 {yoy:.1f}%，成長動能轉弱')
        elif yoy < 0:
            sell_score += 1

    # ── Revenue MoM growth ──
    if mom is not None:
        if mom >= 20:
            buy_score += 2
            buy_reasons.append(f'月營收月增 {mom:+.1f}%，近期動能佳')
        elif mom <= -25:
            sell_score += 2
            sell_reasons.append(f'月營收月減 {mom:.1f}%，近期表現疲弱')

    # ── Institutional buying ──
    if inst:
        total_lots = inst['total'] // 1000
        foreign_lots = inst['foreign'] // 1000
        trust_lots = inst['trust'] // 1000
        if total_lots > 1000:
            buy_score += 4
            buy_reasons.append(f'三大法人大幅買超 {total_lots:,}張，籌碼面佳')
        elif total_lots > 300:
            buy_score += 2
            buy_reasons.append(f'法人買超 {total_lots:,}張')
        elif total_lots < -1000:
            sell_score += 4
            sell_reasons.append(f'三大法人大幅賣超 {abs(total_lots):,}張，籌碼鬆動')
        elif total_lots < -300:
            sell_score += 2
            sell_reasons.append(f'法人賣超 {abs(total_lots):,}張')

        if inst['foreign'] > 0 and inst['trust'] > 0:
            buy_score += 1
            buy_reasons.append('外資投信同步看多')
        elif inst['foreign'] < 0 and inst['trust'] < 0:
            sell_score += 1
            sell_reasons.append('外資投信同步看空')

    # ── Determine recommendation ──
    diff = buy_score - sell_score
    if diff >= 6:
        action = 'strong_buy'
        action_text = '強力買進'
        action_icon = '🟢'
    elif diff >= 3:
        action = 'buy'
        action_text = '建議買進'
        action_icon = '🟢'
    elif diff >= 1:
        action = 'hold'
        action_text = '偏多持有'
        action_icon = '🟡'
    elif diff >= -1:
        action = 'hold'
        action_text = '中性觀望'
        action_icon = '🟡'
    elif diff >= -3:
        action = 'reduce'
        action_text = '建議減碼'
        action_icon = '🟠'
    else:
        action = 'sell'
        action_text = '建議賣出'
        action_icon = '🔴'

    # ── Generate commentary ──
    commentary = []
    name = STOCK_NAMES.get(code, code)

    # Overall assessment
    if action in ('strong_buy', 'buy'):
        if buy_reasons:
            commentary.append(f'{name}目前基本面表現良好。')
    elif action == 'hold':
        commentary.append(f'{name}目前基本面尚可，建議觀察後續變化再做決定。')
    elif action in ('reduce', 'sell'):
        commentary.append(f'{name}目前出現較多警訊，建議留意風險。')

    # Top reasons as commentary
    for r in buy_reasons[:2]:
        commentary.append('✅ ' + r + '。')
    for r in sell_reasons[:2]:
        commentary.append('⚠️ ' + r + '。')

    # Yield insight
    if dy is not None and dy >= 4 and action in ('reduce', 'sell'):
        commentary.append(f'💡 但殖利率仍有 {dy:.1f}%，若為存股策略可考慮續抱。')

    # Revenue trend
    if yoy is not None and mom is not None:
        if yoy > 0 and mom < -10:
            commentary.append('📌 注意月營收出現下滑，需觀察是否為季節性因素。')
        elif yoy < 0 and mom > 10:
            commentary.append('📌 月營收回溫中，可能正在築底反轉。')

    has_data = pe is not None or dy is not None or yoy is not None
    return jsonify({
        'code': code,
        'name': name,
        'has_data': has_data,
        'action': action,
        'action_text': action_text,
        'action_icon': action_icon,
        'buy_score': buy_score,
        'sell_score': sell_score,
        'commentary': ''.join(commentary) if commentary else f'目前無法取得{name}的基本面資料，建議搭配其他資訊判斷。',
        'pe': round(pe, 1) if pe else None,
        'pb': round(pb, 2) if pb else None,
        'dividend_yield': round(dy, 2) if dy else None,
        'rev_yoy': round(yoy, 1) if yoy else None,
        'rev_mom': round(mom, 1) if mom else None,
        'institutional': {
            'foreign': inst['foreign'] // 1000 if inst else None,
            'trust': inst['trust'] // 1000 if inst else None,
            'total': inst['total'] // 1000 if inst else None,
        } if inst else None,
        'buy_reasons': buy_reasons,
        'sell_reasons': sell_reasons,
    })

@app.route('/api/stock_list')
def stock_list():
    """Return all known stocks for autocomplete/browsing"""
    stocks = []
    for code, name in STOCK_NAMES.items():
        market = 'otc' if code in POPULAR_OTC else 'tse'
        stocks.append({'code': code, 'name': name, 'market': market})
    for code, name in _name_cache.items():
        if code not in STOCK_NAMES:
            stocks.append({'code': code, 'name': name, 'market': 'tse'})
    return jsonify(stocks)

@app.route('/api/historical')
def historical():
    code = request.args.get('code', '').strip()
    market = request.args.get('market', 'tse')
    months = int(request.args.get('months', '3'))
    if not code:
        return jsonify([])

    # Unified fetcher handles TSE (STOCK_DAY) + OTC (Yahoo) + fallback, sorted & deduped
    return jsonify(fetch_daily_history(code, market, months=max(months, 1)))

@app.route('/api/institutional')
def institutional():
    today = datetime.date.today()
    for days_back in range(7):
        d = today - datetime.timedelta(days=days_back)
        if d.weekday() >= 5:
            continue
        date_str = d.strftime('%Y%m%d')
        try:
            url = f'https://www.twse.com.tw/fund/T86?response=json&date={date_str}&selectType=ALLBUT0999'
            data = cached_get(url, ttl=1800)
            if data.get('stat') != 'OK' or not data.get('data'):
                continue
            results = []
            for row in data['data']:
                try:
                    results.append({
                        'code': row[0].strip(), 'name': row[1].strip(),
                        'foreign_net': int(row[4].replace(',', '')),
                        'trust_net': int(row[10].replace(',', '')),
                        'dealer_net': int(row[11].replace(',', '')),
                        'total_net': int(row[18].replace(',', '')),
                    })
                except (ValueError, IndexError):
                    continue
            top_buy = sorted(results, key=lambda x: x['total_net'], reverse=True)[:15]
            top_sell = sorted(results, key=lambda x: x['total_net'])[:15]
            return jsonify({'date': d.strftime('%Y/%m/%d'), 'top_buy': top_buy, 'top_sell': top_sell})
        except Exception:
            continue
    return jsonify({'date': '', 'top_buy': [], 'top_sell': []})

@app.route('/api/sectors')
def sectors():
    ex_ch = '|'.join([f'tse_{code}.tw' for code, _ in SECTORS])
    data = cached_get(f'{API_BASE}?ex_ch={ex_ch}')
    results = []
    sector_map = {code: name for code, name in SECTORS}
    for item in data.get('msgArray', []):
        s = parse_stock(item)
        if s:
            s['name'] = sector_map.get(s['code'], s['name'])
            results.append(s)
    return jsonify(results)

@app.route('/api/dividend')
def dividend():
    today = datetime.date.today()
    start = today.strftime('%Y%m%d')
    end = (today + datetime.timedelta(days=90)).strftime('%Y%m%d')
    try:
        url = f'https://www.twse.com.tw/exchangeReport/TWT49U?response=json&strDate={start}&endDate={end}'
        data = cached_get(url, ttl=3600)
        results = []
        wl_codes = [w['code'] for w in load_watchlist()]
        for row in data.get('data', []):
            try:
                results.append({
                    'date': row[0], 'code': row[1].strip(),
                    'name': row[2].strip(), 'type': row[6].strip(),
                    'watched': row[1].strip() in wl_codes,
                })
            except (IndexError, AttributeError):
                continue
        return jsonify(results)
    except Exception:
        return jsonify([])

def _safe_int(v, default=0):
    """Parse possibly-comma-formatted volume strings without crashing."""
    try:
        return int(str(v).replace(',', '').split('.')[0])
    except (ValueError, TypeError):
        return default

def _wilder_rsi(closes, period=14):
    """RSI(14) with Wilder's exponential smoothing — the method brokerage
    charting software uses, so values match what users see in their app."""
    if len(closes) < period + 1:
        return None
    gains, losses = [], []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gains.append(max(diff, 0.0))
        losses.append(max(-diff, 0.0))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 1)

def fetch_daily_history(code, market, months=6):
    """Unified daily OHLCV history fetcher.

    TSE → TWSE STOCK_DAY (monthly). OTC → Yahoo directly, because the legacy
    TPEX `st43_result.php` endpoint is DEAD (returns a 404 HTML page). Yahoo is
    also the universal fallback when TWSE comes up short. Returns a sorted,
    deduped list of {date, open, high, low, close, volume}. Volume in shares.
    """
    records = []
    today = datetime.date.today()
    if market == 'tse':
        for m in range(months):
            d = today.replace(day=1) - datetime.timedelta(days=m * 28)
            url = f'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={d.strftime("%Y%m01")}&stockNo={code}'
            try:
                data = cached_get(url, ttl=3600)
                for row in data.get('data', []):
                    try:
                        parts = row[0].split('/')
                        y = int(parts[0]) + 1911
                        dt = f'{y}-{int(parts[1]):02d}-{int(parts[2]):02d}'
                        records.append({
                            'date': dt,
                            'open': float(row[3].replace(',', '')),
                            'high': float(row[4].replace(',', '')),
                            'low': float(row[5].replace(',', '')),
                            'close': float(row[6].replace(',', '')),
                            'volume': _safe_int(row[1]),
                        })
                    except (ValueError, IndexError):
                        continue
            except Exception:
                continue
    # OTC primary source, or universal fallback when TWSE returned too little
    if market != 'tse' or len(records) < 20:
        rng = ('6mo' if months <= 6 else '1y' if months <= 12 else
               '2y' if months <= 24 else '5y' if months <= 60 else '10y')
        order = ['.TWO', '.TW'] if market != 'tse' else ['.TW', '.TWO']
        for suffix in order:
            try:
                url = f'https://query1.finance.yahoo.com/v8/finance/chart/{code}{suffix}?interval=1d&range={rng}'
                d = cached_get(url, ttl=3600)
                cr = d.get('chart', {}).get('result')
                if not cr:
                    continue
                ts = cr[0].get('timestamp', [])
                q = cr[0].get('indicators', {}).get('quote', [{}])[0]
                ya = []
                for i, t in enumerate(ts):
                    try:
                        c = q.get('close', [])[i]
                        if c is None:
                            continue
                        o = q.get('open', [])[i] or c
                        h = q.get('high', [])[i] or c
                        lo = q.get('low', [])[i] or c
                        v = q.get('volume', [])[i]
                        ya.append({
                            'date': datetime.datetime.fromtimestamp(t).strftime('%Y-%m-%d'),
                            'open': round(float(o), 2), 'high': round(float(h), 2),
                            'low': round(float(lo), 2), 'close': round(float(c), 2),
                            'volume': int(v) if v else 0,
                        })
                    except (IndexError, TypeError):
                        continue
                if len(ya) >= 20:
                    if market != 'tse' or len(records) < 20:
                        records = ya
                    break
            except Exception:
                continue
    # dedup + sort ascending by date
    seen = set()
    uniq = []
    for r in sorted(records, key=lambda x: x['date']):
        if r['date'] not in seen:
            seen.add(r['date'])
            uniq.append(r)
    return uniq

@app.route('/api/volume_rank')
def volume_rank():
    pairs = [(c, 'tse') for c in POPULAR_TSE] + [(c, 'otc') for c in POPULAR_OTC]
    results = fetch_stocks(pairs)
    ranked = sorted([r for r in results if r['volume'] != '-'],
                    key=lambda x: _safe_int(x['volume']), reverse=True)[:10]
    return jsonify(ranked)

@app.route('/api/etf')
def etf_data():
    results = fetch_stocks(POPULAR_ETF)
    return jsonify(results)

@app.route('/api/global')
def global_market():
    result = {'usd_twd': None, 'sp500_futures': None}
    for sym, key in [('USDTWD%3DX', 'usd_twd'), ('ES%3DF', 'sp500_futures')]:
        try:
            url = f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=5d'
            data = cached_get(url, ttl=60)
            meta = data.get('chart', {}).get('result', [{}])[0].get('meta', {})
            price = meta.get('regularMarketPrice')
            prev = meta.get('chartPreviousClose') or meta.get('previousClose')
            if price and prev:
                price, prev = float(price), float(prev)
                dp = 4 if key == 'usd_twd' else 2
                result[key] = {
                    'price': round(price, dp),
                    'change': round(price - prev, dp),
                    'change_pct': round((price - prev) / prev * 100, 2),
                }
        except Exception:
            pass
    if not result['usd_twd']:
        try:
            data = cached_get('https://tw.rter.info/capi.php', ttl=300)
            if isinstance(data, dict) and 'USDTWD' in data:
                rate = float(data['USDTWD'].get('Exrate', 0))
                if rate:
                    result['usd_twd'] = {'price': rate, 'change': 0, 'change_pct': 0}
        except Exception:
            pass
    return jsonify(result)

@app.route('/api/momentum')
def momentum():
    all_codes_tse = list(dict.fromkeys(POPULAR_TSE + ['2603','2609','2615','4904','2105','1216','2207',
                                    '3443','2382','2395','6239','2049','1590','3563']))
    all_codes_otc = list(dict.fromkeys(POPULAR_OTC + ['6426','3529','6180','8044','4763','6770','5289']))
    pairs = [(c, 'tse') for c in all_codes_tse] + [(c, 'otc') for c in all_codes_otc]
    realtime = fetch_stocks(pairs)
    seen_codes = set()
    unique_realtime = []
    for s in realtime:
        if s['code'] not in seen_codes:
            seen_codes.add(s['code'])
            unique_realtime.append(s)
    realtime = unique_realtime

    scored = []
    for s in realtime:
        if s['change'] == 0 and s['price'] == s['yesterday']:
            continue
        score = 0
        try:
            code, market = s['code'], s['market']
            hist = fetch_daily_history(code, market, months=2)
            closes = [r['close'] for r in hist]
            if len(closes) < 5:
                continue

            price = s['price']
            ma5 = sum(closes[-5:]) / 5
            ma10 = sum(closes[-10:]) / 10 if len(closes) >= 10 else ma5

            if price > ma5:
                score += 2
            if price > ma10:
                score += 2
            if s['change_pct'] > 0:
                score += 1
            if s['change_pct'] > 2:
                score += 1
            vol = _safe_int(s['volume']) if s['volume'] != '-' else 0
            if vol > 5000:
                score += 1

            consec_up = 0
            for i in range(len(closes)-1, 0, -1):
                if closes[i] > closes[i-1]:
                    consec_up += 1
                else:
                    break
            score += min(consec_up, 3)

            if score >= 3:
                signals = []
                if price > ma5:
                    signals.append('站上MA5')
                if price > ma10:
                    signals.append('站上MA10')
                if consec_up >= 2:
                    signals.append(f'連漲{consec_up}日')
                if s['change_pct'] > 2:
                    signals.append('今日強漲')
                if vol > 10000:
                    signals.append('爆量')

                scored.append({
                    'code': s['code'], 'name': s['name'],
                    'price': s['price'], 'change': s['change'],
                    'change_pct': s['change_pct'], 'volume': s['volume'],
                    'market': s['market'], 'score': score,
                    'signals': signals,
                })
        except Exception:
            continue

    scored.sort(key=lambda x: x['score'], reverse=True)
    return jsonify(scored[:15])

@app.route('/api/announcements')
def announcements():
    today = datetime.date.today()
    date_str = today.strftime('%Y%m%d')
    try:
        url = f'https://www.twse.com.tw/news/newsList?response=json&date={date_str}'
        data = cached_get(url, ttl=600)
        results = []
        for item in data.get('data', [])[:15]:
            try:
                results.append({'title': item[2], 'date': item[0]})
            except (IndexError, TypeError):
                continue
        if not results:
            url2 = 'https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&type=MS'
            data2 = cached_get(url2, ttl=600)
            if data2.get('title'):
                results.append({'title': data2['title'], 'date': today.strftime('%Y/%m/%d')})
        return jsonify(results)
    except Exception:
        return jsonify([])

@app.route('/api/taiex_history')
def taiex_history():
    all_data = []
    today = datetime.date.today()
    for m in range(3):
        d = today.replace(day=1) - datetime.timedelta(days=m * 28)
        date_str = d.strftime('%Y%m01')
        try:
            url = f'https://www.twse.com.tw/exchangeReport/FMTQIK?response=json&date={date_str}'
            data = cached_get(url, ttl=3600)
            for row in data.get('data', []):
                try:
                    parts = row[0].split('/')
                    y = int(parts[0]) + 1911
                    all_data.append({
                        'date': f'{y}-{parts[1]}-{parts[2]}',
                        'close': float(row[4].replace(',', '')),
                        'volume': int(row[1].replace(',', '')),
                    })
                except (ValueError, IndexError):
                    continue
        except Exception:
            continue
    all_data.sort(key=lambda x: x['date'])
    return jsonify(all_data)

# Reverse lookup: Chinese name → stock code (for news headline matching)
NAME_TO_CODE = {v: k for k, v in STOCK_NAMES.items()}
POSITIVE_KW = ['漲','漲停','大漲','飆','走高','創新高','突破','看好','看多',
    '利多','喊買','目標價','上調','加碼','買超','爆量','強勢','營收增',
    '成長','獲利','訂單','需求','旺季','擴產','AI','法說會','上修']
NEGATIVE_KW = ['跌','下跌','利空','看空','砍','下修','衰退','虧損','減產']

@app.route('/api/news_picks')
def news_picks():
    return jsonify(_compute_news_picks())

def _compute_news_picks():
    # Diverse queries surface more than just the daily mega-cap headlines
    queries = ['台股 漲停 個股', '法人 買超 個股', '營收 創新高 個股',
               '台股 強勢 飆股', '外資 買超 股票', '台股 利多 題材', '半導體 股票 漲']
    all_news = []
    for q in queries:
        all_news.extend(fetch_google_news(q, limit=12))

    # Dedup by title
    seen_titles = set()
    unique_news = []
    for n in all_news:
        if n['title'] not in seen_titles:
            seen_titles.add(n['title'])
            unique_news.append(n)

    now = datetime.datetime.now(datetime.timezone.utc)
    RECENT_HOURS = 96  # only news within last 4 days counts (drops weeks-old stale picks)

    picks = {}
    for n in unique_news:
        title = n['title']
        pos = sum(1 for kw in POSITIVE_KW if kw in title)
        neg = sum(1 for kw in NEGATIVE_KW if kw in title)
        if pos <= neg:
            continue
        # Recency gate: skip stale headlines entirely
        ts = _parse_pubdate(n.get('date'))
        if ts is None:
            continue
        age_h = (now - ts).total_seconds() / 3600
        if age_h > RECENT_HOURS:
            continue
        # Find all company names in the title (skip 1-char names — too noisy)
        matched = [(name, code) for name, code in NAME_TO_CODE.items()
                   if len(name) >= 2 and name in title]
        # Drop names that are substrings of a longer matched name
        # (e.g. "聯發" when "聯發科" also matched → keep only 聯發科)
        matched = [(nm, cd) for nm, cd in matched
                   if not any(nm != other and nm in other for other, _ in matched)]
        for name, code in matched:
            if code not in picks:
                picks[code] = {'code': code, 'name': name, 'news': [],
                               'mentions': 0, 'kw': 0, 'fresh_h': age_h}
            picks[code]['mentions'] += 1
            picks[code]['kw'] += pos
            picks[code]['fresh_h'] = min(picks[code]['fresh_h'], age_h)
            if len(picks[code]['news']) < 2:
                picks[code]['news'].append({
                    'title': title, 'source': n['source'],
                    'date': n['date'], 'link': n['link'],
                })

    if not picks:
        return []

    codes = list(picks.keys())
    otc_codes = set(POPULAR_OTC)
    pairs = [(c, 'otc' if c in otc_codes else 'tse') for c in codes]
    stocks = fetch_stocks(pairs)
    smap = {s['code']: s for s in stocks}

    results = []
    for code, pk in picks.items():
        s = smap.get(code, {})
        if not s or not s.get('price'):
            continue
        chg = s.get('change_pct', 0) or 0
        # A "good-news pick" shouldn't be one that's actually crashing today
        if chg < -3:
            continue
        fresh_h = pk['fresh_h']
        # Blended score: positive-keyword strength + mention count + today's
        # momentum, minus a freshness penalty (older news ranks lower)
        hot = pk['kw'] * 2 + pk['mentions'] * 1.5 + chg * 0.6 - (fresh_h / 24)
        results.append({
            'code': code, 'name': pk['name'],
            'price': s.get('price', 0),
            'change': s.get('change', 0),
            'change_pct': chg,
            'volume': s.get('volume', '-'),
            'market': s.get('market', 'tse'),
            'score': pk['mentions'],          # shown as 新聞提及 N 次
            'hot': round(hot, 1),
            'fresh_hours': round(fresh_h, 1),
            'news': pk['news'],
        })

    # Rank by blended hotness (fresh + positive + rising), not raw keyword count
    results.sort(key=lambda x: x['hot'], reverse=True)
    return results[:8]

@app.route('/api/news')
def news():
    query = request.args.get('q', '台股').strip()
    # Build a smart query: append 股票 only for short index/sector keywords
    q = query if any(c.isdigit() for c in query) else f'{query} 股票'
    results = fetch_google_news(q, limit=30)
    # Fallback to cnyes only if Google totally failed
    if not results:
        try:
            url2 = 'https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?limit=30'
            data = cached_get(url2, ttl=300)
            for item in data.get('items', {}).get('data', [])[:30]:
                ts = item.get('publishAt', 0)
                results.append({
                    'title': item.get('title', ''),
                    'link': f'https://news.cnyes.com/news/id/{item.get("newsId","")}',
                    'date': email.utils.formatdate(ts, localtime=False) if ts else '',
                    'source': '鉅亨網',
                })
        except Exception:
            pass
    return jsonify(results)

# ── Fundamental data fetchers ──────────────────────────────────────────
def _fetch_pe_pb_yield():
    """Fetch PE ratio, PB ratio, dividend yield for all TSE + OTC stocks"""
    result = {}
    # TSE stocks
    try:
        data = cached_get('https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_ALL?response=json', ttl=3600)
        for row in data.get('data', []):
            try:
                code = row[0].strip()
                pe = float(row[2]) if row[2] and row[2] != '-' else None
                dy = float(row[3]) if row[3] and row[3] != '-' else None
                pb = float(row[4]) if row[4] and row[4] != '-' else None
                result[code] = {'pe': pe, 'yield': dy, 'pb': pb}
            except (ValueError, IndexError):
                continue
    except Exception:
        pass
    # OTC stocks
    try:
        data = cached_get('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis', ttl=3600)
        for row in data:
            try:
                code = row.get('SecuritiesCompanyCode', '').strip()
                pe = float(row['PriceEarningRatio']) if row.get('PriceEarningRatio') and row['PriceEarningRatio'] != '-' else None
                dy = float(row['YieldRatio']) if row.get('YieldRatio') and row['YieldRatio'] != '-' else None
                pb = float(row['PriceBookRatio']) if row.get('PriceBookRatio') and row['PriceBookRatio'] != '-' else None
                if code:
                    result[code] = {'pe': pe, 'yield': dy, 'pb': pb}
            except (ValueError, KeyError):
                continue
    except Exception:
        pass
    return result

def _fetch_revenue_growth():
    """Fetch monthly revenue MoM and YoY growth for all TSE + OTC stocks"""
    result = {}
    # TSE stocks
    try:
        data = cached_get('https://openapi.twse.com.tw/v1/opendata/t187ap05_L', ttl=3600)
        for row in data:
            try:
                code = row.get('公司代號', '').strip()
                yoy = float(row['營業收入-去年同月增減(%)']) if row.get('營業收入-去年同月增減(%)') and row['營業收入-去年同月增減(%)'] != '-' else None
                mom = float(row['營業收入-上月比較增減(%)']) if row.get('營業收入-上月比較增減(%)') and row['營業收入-上月比較增減(%)'] != '-' else None
                rev = int(row['營業收入-當月營收']) if row.get('營業收入-當月營收') else 0
                period = row.get('資料年月', '')
                if code:
                    result[code] = {'yoy': yoy, 'mom': mom, 'revenue': rev, 'period': period}
            except (ValueError, KeyError):
                continue
    except Exception:
        pass
    # OTC stocks
    try:
        data = cached_get('https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O', ttl=3600)
        for row in data:
            try:
                code = row.get('公司代號', '').strip()
                yoy = float(row['營業收入-去年同月增減(%)']) if row.get('營業收入-去年同月增減(%)') and row['營業收入-去年同月增減(%)'] != '-' else None
                mom = float(row['營業收入-上月比較增減(%)']) if row.get('營業收入-上月比較增減(%)') and row['營業收入-上月比較增減(%)'] != '-' else None
                rev = int(row['營業收入-當月營收']) if row.get('營業收入-當月營收') else 0
                period = row.get('資料年月', '')
                if code:
                    result[code] = {'yoy': yoy, 'mom': mom, 'revenue': rev, 'period': period}
            except (ValueError, KeyError):
                continue
    except Exception:
        pass
    return result

def _ffloat(v):
    """Parse a financial-statement string field to float, else None."""
    try:
        s = str(v).strip().replace(',', '')
        if not s or s == '-':
            return None
        return float(s)
    except (ValueError, TypeError):
        return None

def _fetch_fundamentals():
    """Quarterly financial-statement metrics (income statement + balance sheet)
    for all TSE + OTC companies. Per stock computes: eps, roe (annualized %),
    gross/op/net margin (%), debt_ratio (%), book_value, equity, net_income,
    revenue, period. Statements are cumulative YTD, so ROE/EPS annualize by
    4/quarter. Cached 6h (data only changes quarterly)."""
    result = {}

    def _ingest_income(rows, code_key, season_key, is_fin=False):
        for row in rows:
            try:
                code = str(row.get(code_key, '')).strip()
                if not code:
                    continue
                net = _ffloat(row.get('本期淨利（淨損）')
                              or row.get('淨利（損）歸屬於母公司業主')
                              or row.get('淨利（淨損）歸屬於母公司業主'))
                eps = _ffloat(row.get('基本每股盈餘（元）'))
                season = str(row.get(season_key, '') or row.get('Season', '') or '').strip()
                year = str(row.get('年度', '') or row.get('Year', '') or '').strip()
                d = result.setdefault(code, {})
                d['net_income'] = net
                d['eps'] = eps
                d['is_financial'] = is_fin
                ind = str(row.get('產業別', '') or '').strip()
                if ind:
                    d['industry'] = ind
                try:
                    d['quarter'] = int(season) if season else None
                except ValueError:
                    d['quarter'] = None
                if year and season:
                    d['period'] = f'{year}Q{season}'
                if not is_fin:
                    rev = _ffloat(row.get('營業收入'))
                    gross = _ffloat(row.get('營業毛利（毛損）淨額') or row.get('營業毛利（毛損）'))
                    op = _ffloat(row.get('營業利益（損失）'))
                    d['revenue'] = rev
                    if rev and rev > 0:
                        if gross is not None:
                            d['gross_margin'] = round(gross / rev * 100, 1)
                        if op is not None:
                            d['op_margin'] = round(op / rev * 100, 1)
                        if net is not None:
                            d['net_margin'] = round(net / rev * 100, 1)
            except Exception:
                continue

    def _ingest_balance(rows, code_key, is_fin=False):
        for row in rows:
            try:
                code = str(row.get(code_key, '')).strip()
                if not code:
                    continue
                equity = _ffloat(row.get('權益總額') or row.get('權益總計')
                                 or row.get('歸屬於母公司業主之權益合計'))
                book = _ffloat(row.get('每股參考淨值'))
                d = result.setdefault(code, {})
                d['equity'] = equity
                d['book_value'] = book
                if not is_fin:
                    # Debt ratio is meaningful only for non-financials (a bank's
                    # deposits aren't "debt" in the Buffett sense).
                    assets = _ffloat(row.get('資產總額'))
                    liab = _ffloat(row.get('負債總額'))
                    if assets and assets > 0 and liab is not None:
                        d['debt_ratio'] = round(liab / assets * 100, 1)
            except Exception:
                continue

    # All statement endpoints: (kind, url, code_key, season_key, is_fin).
    # Fetched in parallel (12 large payloads) then ingested in a deterministic
    # order — cuts cold-start latency from ~50s to a few seconds.
    specs = [
        ('income', 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci', '公司代號', '季別', False),
        ('income', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap06_O_ci', 'SecuritiesCompanyCode', 'Season', False),
        ('income', 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_fh', '公司代號', '季別', True),
        ('income', 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_basi', '公司代號', '季別', True),
        ('income', 'https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ins', '公司代號', '季別', True),
        ('balance', 'https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ci', '公司代號', None, False),
        ('balance', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap07_O_ci', 'SecuritiesCompanyCode', None, False),
        ('balance', 'https://openapi.twse.com.tw/v1/opendata/t187ap07_L_fh', '公司代號', None, True),
        ('balance', 'https://openapi.twse.com.tw/v1/opendata/t187ap07_L_basi', '公司代號', None, True),
        ('balance', 'https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ins', '公司代號', None, True),
        ('industry', 'https://openapi.twse.com.tw/v1/opendata/t187ap14_L', '公司代號', None, False),
        ('industry', 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap14_O', 'SecuritiesCompanyCode', None, False),
    ]
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as pool:
        fetched = list(pool.map(lambda sp: cached_get(sp[1], ttl=21600), specs))
    # Ingest income → balance → industry (order matters: industry needs codes present)
    for order_kind in ('income', 'balance', 'industry'):
        for (kind, url, ck, sk, is_fin), data in zip(specs, fetched):
            if kind != order_kind or not isinstance(data, list):
                continue
            try:
                if kind == 'income':
                    _ingest_income(data, ck, sk, is_fin=is_fin)
                elif kind == 'balance':
                    _ingest_balance(data, ck, is_fin=is_fin)
                else:
                    for row in data:
                        code = str(row.get(ck, '')).strip()
                        ind = str(row.get('產業別', '') or '').strip()
                        if code and ind and code in result:
                            result[code]['industry'] = ind
            except Exception:
                continue

    # ROE = annualized net income / equity (cumulative YTD → ×4/quarter).
    # Fallback: annualized EPS / book value per share (per-share consistent —
    # works for financial holdings where the total-net-income field is blank).
    for code, d in result.items():
        ni, eq, q = d.get('net_income'), d.get('equity'), d.get('quarter')
        factor = 4 / q if q else 4
        eps_ann = round(d['eps'] * factor, 2) if d.get('eps') is not None else None
        d['eps_annual'] = eps_ann
        roe = None
        if ni is not None and eq and eq > 0:
            roe = round(ni / eq * 100 * factor, 1)
        elif eps_ann is not None and d.get('book_value') and d['book_value'] > 0:
            roe = round(eps_ann / d['book_value'] * 100, 1)
        # Annualizing a single strong quarter (×4) can over-state ROE; cap the
        # display at a high-but-believable ceiling to avoid artifacts like 104%.
        if roe is not None and roe > 60:
            roe = 60.0
        d['roe'] = roe
    return result

def _fair_price(pe, price, roe, rev_yoy, debt, is_fin):
    """Reference fair price via a fair-PE multiple. Growth premium is gated on
    decent ROE so cyclical stocks at peak earnings (low PE, high temporary
    growth) don't get an inflated valuation."""
    if pe is None or pe <= 0 or not price:
        return None, None
    fair_pe = 11.0 if is_fin else 15.0
    if roe is not None:
        fair_pe += min(max((roe - 10) * 0.4, -5), 7)
    # Growth premium only when quality (ROE) supports it — avoids cyclical trap
    if rev_yoy is not None and (roe is None or roe >= 10):
        fair_pe += min(max(rev_yoy * 0.10, -3), 4)
    if debt is not None and debt > 70:
        fair_pe -= 2
    cap = 16.0 if is_fin else 24.0
    fair_pe = max(7.0, min(fair_pe, cap))
    fp = round(price * fair_pe / pe, 2)
    # A simple PE model can't credibly claim huge mispricing — clamp to ±60%
    mos = max(-60.0, min((fp - price) / price * 100, 60.0))
    return fp, round(mos, 1)


def buffett_score(fund, pe, pb, dy, rev_yoy, price):
    """Value-investing scorecard in the spirit of Buffett: a wonderful business
    (high ROE, fat margins, low debt) at a fair price (sensible PE/PB) with a
    margin of safety. Financials are scored on ROE + valuation + dividend
    (margins/debt don't apply to banks). Returns score 0-100, breakdown,
    plain-language verdict + reasons, and a reference fair price."""
    fund = fund or {}
    roe = fund.get('roe')
    nm = fund.get('net_margin')
    gm = fund.get('gross_margin')
    debt = fund.get('debt_ratio')
    ni = fund.get('net_income')
    is_fin = bool(fund.get('is_financial'))
    pros, cons = [], []

    # Cap one-off-inflated net margin for messaging (e.g. huge non-operating gains)
    nm_real = nm if (nm is not None and nm <= 100) else None

    has_fundamentals = any(x is not None for x in (roe, nm, gm, debt))
    fair_price, margin_of_safety = _fair_price(pe, price, roe, rev_yoy, debt, is_fin)

    # ── No fundamentals at all → valuation-only soft read (never harsh "避開") ──
    if not has_fundamentals:
        if pe is None and pb is None:
            return {'available': False}
        v = 0
        if pe is not None and pe > 0:
            if pe < 12: v += 40; pros.append(f'本益比 {pe:.0f} 倍，估值便宜')
            elif pe < 18: v += 30; pros.append(f'本益比 {pe:.0f} 倍，估值合理')
            elif pe < 25: v += 18
            elif pe < 40: v += 8; cons.append(f'本益比 {pe:.0f} 倍偏貴')
        if pb is not None:
            if pb < 1.5: v += 25
            elif pb < 3: v += 16
            elif pb < 5: v += 8
        if dy is not None:
            if dy >= 4: v += 20; pros.append(f'殖利率 {dy:.1f}%')
            elif dy >= 2: v += 12
            elif dy > 0: v += 5
        if rev_yoy is not None and rev_yoy >= 10:
            v += 15; pros.append(f'營收年增 {rev_yoy:+.0f}%')
        return {
            'available': True, 'limited': True, 'score': min(v, 100),
            'quality': 0, 'health': 0, 'value': v, 'growth': 0, 'dividend': 0,
            'verdict': '財報資料有限', 'verdict_icon': '⚪',
            'verdict_desc': '缺少完整財報，僅依估值面參考，無法做價值評等',
            'pros': pros[:4], 'cons': cons[:3],
            'fair_price': fair_price, 'margin_of_safety': margin_of_safety,
            'roe': roe, 'net_margin': nm, 'gross_margin': gm, 'debt_ratio': debt,
            'eps': fund.get('eps'), 'book_value': fund.get('book_value'),
            'period': fund.get('period'), 'is_financial': is_fin,
        }

    cheap = (margin_of_safety is not None and margin_of_safety >= 10)
    fair = (margin_of_safety is not None and margin_of_safety >= -10)

    if is_fin:
        # ── Financial scorecard: ROE(35) + Value(40) + Dividend(25) ──
        q = 0
        if roe is not None:
            if roe >= 15: q += 35; pros.append(f'ROE 高達 {roe:.0f}%，金融股中的績優生')
            elif roe >= 12: q += 28; pros.append(f'ROE {roe:.0f}%，獲利能力佳')
            elif roe >= 10: q += 22; pros.append(f'ROE {roe:.0f}%，穩健')
            elif roe >= 8: q += 15
            elif roe >= 5: q += 8
            elif roe >= 0: q += 3
            else: cons.append(f'ROE 為負 ({roe:.0f}%)，本期虧損')
        v = 0
        if pe is not None and pe > 0:
            if pe < 8: v += 22; pros.append(f'本益比僅 {pe:.0f} 倍，便宜')
            elif pe < 10: v += 18
            elif pe < 12: v += 15; pros.append(f'本益比 {pe:.0f} 倍，合理')
            elif pe < 15: v += 11
            elif pe < 18: v += 7
            elif pe < 25: v += 3
            else: cons.append(f'本益比 {pe:.0f} 倍偏高')
        if pb is not None:
            if pb < 0.8: v += 18; pros.append(f'股價淨值比 {pb:.1f}，低於每股淨值')
            elif pb < 1.2: v += 15; pros.append(f'淨值比 {pb:.1f}，接近淨值')
            elif pb < 1.5: v += 12
            elif pb < 2: v += 8
            elif pb < 2.5: v += 5
            else: v += 2; cons.append(f'淨值比 {pb:.1f}，溢價偏高')
        dvd = 0
        if dy is not None:
            if dy >= 6: dvd += 25; pros.append(f'殖利率 {dy:.1f}%，存股優選')
            elif dy >= 5: dvd += 21; pros.append(f'殖利率 {dy:.1f}%，配息優渥')
            elif dy >= 4: dvd += 16; pros.append(f'殖利率 {dy:.1f}%，配息穩定')
            elif dy >= 3: dvd += 11
            elif dy >= 2: dvd += 6
            elif dy > 0: dvd += 3
        h = 0; g = 0
        total = q + v + dvd
        quality_pts = q          # out of 35
        strong = quality_pts >= 22   # ROE ≥ ~10
        if roe is not None and roe < 0:
            verdict, vicon = '本期虧損、避開', '🔴'
            vdesc = '金融股本期虧損，價值投資不碰'
        elif strong and cheap:
            verdict, vicon = '好金融股 + 好價格', '🎩'
            vdesc = 'ROE 穩健且價格有安全邊際，適合長期存股'
        elif strong and fair:
            verdict, vicon = '穩健金融股、價格合理', '🟢'
            vdesc = 'ROE 不錯、估值合理，適合分批佈局存股'
        elif strong:
            verdict, vicon = '穩健金融股、偏貴', '🟡'
            vdesc = '體質不錯但目前偏貴，可等回檔再進'
        elif quality_pts >= 15:
            verdict, vicon = '中等金融股', '🟡'
            vdesc = 'ROE 普通，宜留意獲利與利差變化'
        else:
            verdict, vicon = '金融股體質偏弱', '🔴'
            vdesc = 'ROE 偏低，獲利能力不足'
    else:
        # ── General-industry scorecard: Quality(35)+Health(20)+Value(25)+Growth(10)+Dividend(10) ──
        q = 0
        if roe is not None:
            if roe >= 20: q += 15; pros.append(f'股東報酬率(ROE)高達 {roe:.0f}%，賺錢效率一流')
            elif roe >= 15: q += 12; pros.append(f'ROE {roe:.0f}%，獲利能力優秀')
            elif roe >= 10: q += 8; pros.append(f'ROE {roe:.0f}%，獲利能力穩健')
            elif roe >= 5: q += 4
            elif roe >= 0: q += 1
            else: cons.append(f'ROE 為負 ({roe:.0f}%)，股東的錢沒在賺錢')
        if nm is not None:
            if nm >= 20: q += 10
            elif nm >= 10: q += 7
            elif nm >= 5: q += 4
            elif nm >= 0: q += 2
            else: cons.append(f'淨利率為負 ({nm:.0f}%)，本業在虧損')
            if nm_real is not None and nm_real >= 20:
                pros.append(f'淨利率 {nm_real:.0f}%，每塊營收留下很多獲利')
        if gm is not None:
            if gm >= 40: q += 10; pros.append(f'毛利率 {gm:.0f}%，產品有定價權(護城河)')
            elif gm >= 25: q += 7
            elif gm >= 15: q += 4
            else: q += 2
        h = 0
        if debt is not None:
            if debt < 30: h += 12; pros.append(f'負債比僅 {debt:.0f}%，財務體質穩健')
            elif debt < 50: h += 9
            elif debt < 65: h += 5
            elif debt < 80: h += 2; cons.append(f'負債比 {debt:.0f}%，槓桿偏高')
            else: cons.append(f'負債比高達 {debt:.0f}%，財務風險大')
        if ni is not None:
            if ni > 0: h += 8
            else: cons.append('公司目前處於虧損狀態')
        v = 0
        if pe is not None:
            if pe < 0: cons.append('本益比為負(虧損)，無法用 PE 評價')
            elif pe < 12: v += 15; pros.append(f'本益比僅 {pe:.0f} 倍，估值便宜')
            elif pe < 16: v += 12; pros.append(f'本益比 {pe:.0f} 倍，估值合理')
            elif pe < 20: v += 9
            elif pe < 28: v += 6
            elif pe < 40: v += 3; cons.append(f'本益比 {pe:.0f} 倍，估值偏貴')
            else: cons.append(f'本益比高達 {pe:.0f} 倍，價格昂貴')
        if pb is not None:
            if pb < 1.5: v += 10; pros.append(f'股價淨值比 {pb:.1f}，接近資產價值')
            elif pb < 3: v += 7
            elif pb < 5: v += 4
            elif pb < 8: v += 2
            else: v += 1; cons.append(f'淨值比 {pb:.1f}，市場給予高溢價')
        g = 0
        if rev_yoy is not None:
            if rev_yoy >= 20: g += 10; pros.append(f'營收年增 {rev_yoy:+.0f}%，成長動能強')
            elif rev_yoy >= 10: g += 7
            elif rev_yoy >= 3: g += 4
            elif rev_yoy >= 0: g += 2
            else: cons.append(f'營收年減 {rev_yoy:.0f}%，成長轉弱')
        dvd = 0
        if dy is not None:
            if dy >= 5: dvd += 10; pros.append(f'殖利率 {dy:.1f}%，配息優渥')
            elif dy >= 3: dvd += 7; pros.append(f'殖利率 {dy:.1f}%，配息穩定')
            elif dy >= 1.5: dvd += 4
            elif dy > 0: dvd += 2
        total = q + h + v + g + dvd
        quality_pts = q + h          # out of 55
        # Cyclical-peak detection: a low PE in a cyclical industry (shipping,
        # steel, cement, plastics…) with only mediocre ROE is the classic
        # "value trap" at the top of a cycle — cheap is an illusion.
        CYCLICAL_IND = ('航運', '鋼鐵', '水泥', '造紙', '橡膠', '塑膠', '玻璃')
        ind = fund.get('industry', '') or ''
        cyclical = (
            (nm is not None and nm < 12 and pe is not None and 0 < pe < 12
             and rev_yoy is not None and rev_yoy > 15)
            or (pe is not None and 0 < pe < 10 and pb is not None and pb < 1.5
                and dy is not None and dy > 5 and (roe is None or roe < 15))
            or (any(c in ind for c in CYCLICAL_IND) and pe is not None
                and 0 < pe < 15 and (roe is None or roe < 18))
        )
        if ni is not None and ni < 0:
            verdict, vicon = '不符合價值投資', '🔴'
            vdesc = '公司虧損中，巴菲特只買持續賺錢的好公司'
        elif cyclical:
            verdict, vicon = '景氣循環股、當心', '🟡'
            vdesc = '低本益比可能是處於獲利高峰的循環股，便宜是假象，須留意獲利反轉'
        elif quality_pts >= 40 and cheap:
            verdict, vicon = '好公司 + 好價格', '🎩'
            vdesc = '體質優異且價格有安全邊際，正是價值投資的甜蜜點'
        elif quality_pts >= 40 and fair:
            verdict, vicon = '好公司、價格合理', '🟢'
            vdesc = '是值得長抱的好公司，目前價格尚屬合理'
        elif quality_pts >= 40:
            verdict, vicon = '好公司、但偏貴', '🟡'
            vdesc = '基本面很好，但現價偏貴，建議等回檔出現安全邊際'
        elif quality_pts >= 24:
            verdict, vicon = '體質中等', '🟡'
            vdesc = '基本面尚可但稱不上頂尖，須留意產業與獲利變化'
        else:
            verdict, vicon = '體質偏弱、避開', '🔴'
            vdesc = '獲利能力或財務體質不足，不符合長期價值投資標準'

    return {
        'available': True,
        'score': total,
        'quality': q, 'health': h, 'value': v, 'growth': g, 'dividend': dvd,
        'verdict': verdict, 'verdict_icon': vicon, 'verdict_desc': vdesc,
        'pros': pros[:5], 'cons': cons[:4],
        'fair_price': fair_price, 'margin_of_safety': margin_of_safety,
        'roe': roe, 'net_margin': nm, 'gross_margin': gm, 'debt_ratio': debt,
        'eps': fund.get('eps'), 'eps_annual': fund.get('eps_annual'),
        'book_value': fund.get('book_value'), 'period': fund.get('period'),
        'is_financial': is_fin,
    }

def _dividend_quality(code, market, price=None, eps_annual=None):
    """Dividend track record (存股 / income view) from Yahoo dividend history:
    consecutive payout years, trailing-12m dividend, payout ratio, trend, and
    an income-investing score + verdict. Returns None if no dividend record."""
    suffix = '.TWO' if market == 'otc' else '.TW'
    events = {}
    for sfx in [suffix, ('.TW' if suffix == '.TWO' else '.TWO')]:
        try:
            url = f'https://query1.finance.yahoo.com/v8/finance/chart/{code}{sfx}?interval=1d&range=10y&events=div'
            d = cached_get(url, ttl=86400)
            ev = d.get('chart', {}).get('result', [{}])[0].get('events', {}).get('dividends', {})
            if ev:
                events = ev
                break
        except Exception:
            continue
    if not events:
        return None
    now = datetime.datetime.now()
    by_year = {}
    ttm = 0.0
    for v in events.values():
        try:
            dt = datetime.datetime.fromtimestamp(v['date'])
            amt = float(v['amount'])
            by_year[dt.year] = by_year.get(dt.year, 0.0) + amt
            if (now - dt).days <= 366:
                ttm += amt
        except Exception:
            continue
    if not by_year:
        return None
    cur = now.year
    # Consecutive payout years counting back from this year (or last year if
    # this year hasn't distributed yet).
    consec = 0
    start = cur if by_year.get(cur, 0) > 0 else cur - 1
    y = start
    while by_year.get(y, 0) > 0:
        consec += 1
        y -= 1
    years_paid = len([y for y, a in by_year.items() if a > 0])
    # Trend: avg of last 3 completed years vs the 3 before that
    completed = sorted([yr for yr in by_year if yr < cur])
    trend = 'stable'
    if len(completed) >= 4:
        recent = [by_year[y] for y in completed[-3:]]
        older = [by_year[y] for y in completed[-6:-3]] or [by_year[completed[0]]]
        ra, oa = sum(recent) / len(recent), sum(older) / len(older)
        if ra > oa * 1.15:
            trend = 'growing'
        elif ra < oa * 0.85:
            trend = 'shrinking'
    ttm = round(ttm, 2)
    payout = round(ttm / eps_annual * 100, 1) if (eps_annual and eps_annual > 0) else None
    yld = round(ttm / price * 100, 2) if price else None

    score = 0
    if consec >= 10: score += 40
    elif consec >= 5: score += 30
    elif consec >= 3: score += 20
    elif consec >= 1: score += 8
    if yld is not None:
        if yld >= 5: score += 30
        elif yld >= 4: score += 25
        elif yld >= 3: score += 18
        elif yld >= 2: score += 10
        elif yld > 0: score += 4
    if payout is not None:
        if 30 <= payout <= 70: score += 20
        elif payout < 30: score += 12
        elif payout <= 90: score += 8
        elif payout <= 110: score += 3
    if trend == 'growing': score += 10
    elif trend == 'shrinking': score -= 5
    score = max(0, min(score, 100))

    unsustainable = (payout is not None and payout > 110)
    extreme_yield = (yld is not None and yld > 10)
    if unsustainable or (extreme_yield and (payout is None or payout > 90)):
        verdict, vicon = '高息但恐難持續', '⚠️'
        vdesc = '配息超過當期獲利（可能來自一次性或景氣高峰），不宜當成長期穩定息源'
        score = min(score, 45)
    elif consec >= 8 and (yld or 0) >= 3 and (payout is None or payout <= 85) and trend != 'shrinking':
        verdict, vicon = '優質存股', '🏆'
        vdesc = f'連續配息 {consec} 年、殖利率佳且配息可持續，存股首選'
    elif consec >= 5 and (yld or 0) >= 2.5:
        verdict, vicon = '穩定存股', '💰'
        vdesc = f'連續配息 {consec} 年，配息穩定，適合長期持有領息'
    elif consec >= 3:
        verdict, vicon = '配息穩定', '📅'
        vdesc = f'連續配息 {consec} 年，配息紀錄尚可'
    elif consec >= 1:
        verdict, vicon = '配息紀錄偏短', '🟡'
        vdesc = '配息年數不長，存股前建議觀察持續性'
    else:
        verdict, vicon = '近年未穩定配息', '⚪'
        vdesc = '近年未見穩定配息，不適合存股族'
    notes = []
    if payout is not None and payout > 100:
        notes.append('配息率超過 100%，配發超過當期盈餘，留意能否持續')
    if trend == 'growing':
        notes.append('股利逐年成長，是很好的訊號')
    elif trend == 'shrinking':
        notes.append('近年股利縮水，留意獲利變化')

    return {
        'consecutive_years': consec, 'years_paid': years_paid,
        'ttm_dividend': ttm, 'payout_ratio': payout, 'yield': yld,
        'trend': trend, 'score': score,
        'verdict': verdict, 'verdict_icon': vicon, 'verdict_desc': vdesc,
        'notes': notes,
    }

def _fetch_institutional():
    """Fetch institutional net buy/sell data (三大法人買賣超). The most recent
    trading day with data is unknown, so fetch the candidate days in parallel
    (each T86 payload is large) and use the newest non-empty one."""
    inst_map = {}
    today = datetime.date.today()
    days = [d for d in (today - datetime.timedelta(days=i) for i in range(7)) if d.weekday() < 5]

    def _fetch(d):
        try:
            url = f'https://www.twse.com.tw/fund/T86?response=json&date={d.strftime("%Y%m%d")}&selectType=ALLBUT0999'
            return cached_get(url, ttl=1800)
        except Exception:
            return None

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=7) as pool:
        results = list(pool.map(_fetch, days))  # newest-first order preserved

    for data in results:
        if isinstance(data, dict) and data.get('stat') == 'OK' and data.get('data'):
            for row in data['data']:
                try:
                    inst_map[row[0].strip()] = {
                        'name': row[1].strip(),
                        'foreign': int(row[4].replace(',', '')),
                        'trust': int(row[10].replace(',', '')),
                        'total': int(row[18].replace(',', '')),
                    }
                except (ValueError, IndexError):
                    continue
            break
    return inst_map

def _compute_tech_picks():
    """AI/科技股精選: rank a curated tech universe (semis, AI servers,
    networking, components) by institutional buying + revenue growth + quality
    (ROE/margin) + today's momentum. Growth/momentum-oriented, not value."""
    inst_map = _fetch_institutional()
    rev_map = _fetch_revenue_growth()
    fundamentals = _fetch_fundamentals()
    stocks = fetch_stocks(TECH_AI)
    seen = set()
    picks = []
    for s in stocks:
        code = s['code']
        if code in seen or not s.get('price'):
            continue
        seen.add(code)
        chg = s.get('change_pct', 0) or 0
        inst = inst_map.get(code)
        total_net = (inst.get('total', 0) // 1000) if inst else 0   # 張
        foreign_net = (inst.get('foreign', 0) // 1000) if inst else 0
        yoy = rev_map.get(code, {}).get('yoy')
        f = fundamentals.get(code, {})
        roe = f.get('roe')
        gm = f.get('gross_margin')
        score = 0.0
        reasons = []
        if total_net >= 3000:
            score += 3; reasons.append(f'法人大買 {total_net:,} 張')
        elif total_net >= 500:
            score += 2; reasons.append(f'法人買超 {total_net:,} 張')
        elif total_net <= -3000:
            score -= 2; reasons.append(f'法人大賣 {abs(total_net):,} 張')
        if yoy is not None:
            if yoy >= 30:
                score += 3; reasons.append(f'營收年增 {yoy:+.0f}%')
            elif yoy >= 15:
                score += 2; reasons.append(f'營收年增 {yoy:+.0f}%')
            elif yoy >= 5:
                score += 1
            elif yoy < 0:
                score -= 1
        if roe is not None and roe >= 20:
            score += 1.5; reasons.append(f'ROE {roe:.0f}%')
        elif roe is not None and roe >= 12:
            score += 1
        if gm is not None and gm >= 40 and len(reasons) < 3:
            reasons.append(f'毛利率 {gm:.0f}%')
        if 0 < chg <= 6:
            score += 1
        elif chg > 6:
            score += 0.5; reasons.append('今日強漲')
        elif chg < -3:
            score -= 1
        picks.append({
            'code': code, 'name': s['name'], 'price': s['price'],
            'change': s.get('change', 0), 'change_pct': chg,
            'market': s.get('market', 'tse'),
            'score': round(score, 1), 'reasons': reasons[:3],
            'foreign_net': foreign_net, 'total_net': total_net,
            'rev_yoy': round(yoy, 1) if yoy is not None else None, 'roe': roe,
        })
    picks.sort(key=lambda x: (x['score'], x['total_net']), reverse=True)
    return picks[:12]

@app.route('/api/tech_picks')
def tech_picks():
    return jsonify(_compute_tech_picks())

@app.route('/api/value_picks')
def value_picks():
    """Buffett value-investing leaderboard: rank stocks by the value scorecard
    (wonderful business — high ROE / margins / low debt or strong financials —
    at a fair price with margin of safety)."""
    fund_map = _fetch_pe_pb_yield()
    rev_map = _fetch_revenue_growth()
    fundamentals = _fetch_fundamentals()
    pairs = ([(c, 'tse') for c in dict.fromkeys(POPULAR_TSE)] +
             [(c, 'otc') for c in dict.fromkeys(POPULAR_OTC)])
    stocks = fetch_stocks(pairs)
    seen = set()
    results = []
    for s in stocks:
        code = s['code']
        if code in seen or not s.get('price'):
            continue
        seen.add(code)
        f = fund_map.get(code, {})
        b = buffett_score(fundamentals.get(code, {}), f.get('pe'), f.get('pb'),
                          f.get('yield'), rev_map.get(code, {}).get('yoy'), s['price'])
        if not b.get('available') or b.get('limited'):
            continue
        results.append({
            'code': code, 'name': s['name'], 'price': s['price'],
            'change_pct': s.get('change_pct', 0), 'market': s.get('market', 'tse'),
            'score': b['score'], 'verdict': b['verdict'], 'verdict_icon': b['verdict_icon'],
            'verdict_desc': b['verdict_desc'],
            'roe': b['roe'], 'pe': f.get('pe'), 'pb': f.get('pb'),
            'dividend_yield': f.get('yield'),
            'fair_price': b['fair_price'], 'margin_of_safety': b['margin_of_safety'],
            'is_financial': b.get('is_financial', False), 'pros': b['pros'][:2],
        })
    # Rank by score, but demote cyclical-peak "value traps" so real compounders lead
    def _rank(x):
        pen = 25 if '景氣循環' in x['verdict'] else 0
        return (x['score'] - pen, x['margin_of_safety'] if x['margin_of_safety'] is not None else -999)
    results.sort(key=_rank, reverse=True)
    return jsonify(results[:15])

def _scan_value_alerts(threshold=8.0):
    """好公司跌進便宜區: high-quality (🎩/🟢, non-cyclical) stocks trading at
    least `threshold`% below reference fair value. Shared by the 估值雷達 UI
    endpoint and the scheduled LINE-push endpoint."""
    fund_map = _fetch_pe_pb_yield()
    rev_map = _fetch_revenue_growth()
    fundamentals = _fetch_fundamentals()
    pairs = ([(c, 'tse') for c in dict.fromkeys(POPULAR_TSE)] +
             [(c, 'otc') for c in dict.fromkeys(POPULAR_OTC)])
    stocks = fetch_stocks(pairs)
    seen = set()
    alerts = []
    for s in stocks:
        code = s['code']
        if code in seen or not s.get('price'):
            continue
        seen.add(code)
        f = fund_map.get(code, {})
        b = buffett_score(fundamentals.get(code, {}), f.get('pe'), f.get('pb'),
                          f.get('yield'), rev_map.get(code, {}).get('yoy'), s['price'])
        if not b.get('available') or b.get('limited'):
            continue
        mos = b.get('margin_of_safety')
        if (b['verdict_icon'] in ('🎩', '🟢') and mos is not None
                and mos >= threshold and '景氣循環' not in b['verdict']):
            alerts.append({
                'code': code, 'name': s['name'], 'price': s['price'],
                'change_pct': s.get('change_pct', 0), 'market': s.get('market', 'tse'),
                'verdict': b['verdict'], 'verdict_icon': b['verdict_icon'],
                'score': b['score'], 'roe': b['roe'], 'pe': f.get('pe'),
                'dividend_yield': f.get('yield'),
                'fair_price': b['fair_price'], 'margin_of_safety': mos,
                'pros': b['pros'][:2],
            })
    alerts.sort(key=lambda x: x['margin_of_safety'], reverse=True)
    return alerts

@app.route('/api/value_alerts')
def value_alerts():
    """估值雷達 — good companies that dropped into the cheap zone (UI source)."""
    try:
        threshold = float(request.args.get('mos', '8'))
    except ValueError:
        threshold = 8.0
    return jsonify(_scan_value_alerts(threshold))

def _line_push(msg, count):
    """Send a text message to LINE (broadcast, or push to LINE_TO). Returns a
    JSON-able status dict. If no token is set, returns a preview instead."""
    token = os.environ.get('LINE_CHANNEL_TOKEN', '')
    if not token:
        return {'pushed': False, 'reason': 'LINE_CHANNEL_TOKEN not set',
                'count': count, 'preview': msg}
    try:
        to = os.environ.get('LINE_TO', '')
        if to:
            url = 'https://api.line.me/v2/bot/message/push'
            payload = {'to': to, 'messages': [{'type': 'text', 'text': msg}]}
        else:
            url = 'https://api.line.me/v2/bot/message/broadcast'
            payload = {'messages': [{'type': 'text', 'text': msg}]}
        r = requests.post(url, headers={'Authorization': f'Bearer {token}',
                                        'Content-Type': 'application/json'},
                          json=payload, timeout=10)
        return {'pushed': r.status_code == 200, 'http': r.status_code,
                'count': count, 'resp': r.text[:200]}
    except Exception as e:
        return {'pushed': False, 'error': str(e), 'count': count}

# Best-effort recent TradingView signals (in-memory; resets on cold start)
_tv_recent = []

@app.route('/api/tv_webhook', methods=['POST', 'GET'])
def tv_webhook():
    """Receive a TradingView strategy alert (JSON) and push a PAPER-TRADE
    notification to LINE. SAFE — never places a real order. Secret-guarded via
    the TV_SECRET env var (passed as JSON 'secret' or ?key=)."""
    payload = request.get_json(force=True, silent=True) or {}
    if not payload and request.args:
        payload = dict(request.args)

    secret = os.environ.get('TV_SECRET', '')
    if secret:
        got = str(payload.get('secret', '')) or request.args.get('key', '')
        if got != secret:
            return jsonify({'error': 'unauthorized'}), 401

    def g(*keys):
        for k in keys:
            v = payload.get(k)
            if v not in (None, ''):
                return v
        return ''
    action = str(g('action', 'side', 'order')).lower().strip()
    symbol = str(g('symbol', 'ticker') or '?').strip()
    price = g('price', 'close')
    sl = g('sl', 'stop', 'stoploss')
    tp = g('tp', 'target', 'takeprofit')
    qty = g('qty', 'contracts', 'size', 'position')
    pnl = g('pnl', 'profit')
    strat = str(g('strategy', 'comment', 'name')).strip()
    note = str(g('note', 'message', 'text')).strip()

    # TradingView strategy alerts send the resulting position; use it to tell
    # entry vs exit reliably (a strategy "sell" can be a short entry OR a long exit).
    mpos = str(g('position', 'market_position')).lower().strip()
    if mpos in ('flat', '0'):
        is_close, is_buy, is_sell = True, False, False
    elif mpos == 'long':
        is_close, is_buy, is_sell = False, True, False
    elif mpos == 'short':
        is_close, is_buy, is_sell = False, False, True
    else:
        is_close = ('close' in action or 'exit' in action or 'flat' in action or action == 'cover')
        is_buy = (action in ('buy', 'long') or action.startswith('long') or action == 'buy_entry')
        is_sell = (action in ('sell', 'short') or action.startswith('short') or action == 'sell_entry')

    if is_close:
        head = '📤 出場訊號（模擬）'
        body = [f'策略：{strat}' if strat else '',
                f'{symbol} 平倉' + (f' @ {price}' if price != '' else ''),
                f'本筆損益：{pnl}' if pnl != '' else '']
    elif is_buy or is_sell:
        head = '📥 進場訊號（模擬）'
        dir_txt = '做多 🟢' if is_buy else '做空 🔴'
        body = [f'策略：{strat}' if strat else '',
                f'{dir_txt}　{symbol}' + (f' @ {price}' if price != '' else ''),
                (f'停損 {sl}　停利 {tp}' if (sl != '' or tp != '') else ''),
                f'口數 {qty}' if qty != '' else '']
    else:
        head = '🔔 策略訊號（模擬）'
        body = [f'策略：{strat}' if strat else '', note or f'{symbol} {action}'.strip()]

    msg = '\n'.join([head] + [b for b in body if b] + ['', '⚠️ 模擬通知，未實際下單'])
    try:
        _tv_recent.insert(0, {'t': datetime.datetime.now().strftime('%m/%d %H:%M'),
                              'action': action, 'symbol': symbol, 'price': str(price)})
        del _tv_recent[50:]
    except Exception:
        pass
    res = _line_push(msg, 1)
    return jsonify({'ok': True, 'parsed': {'action': action, 'symbol': symbol,
                    'price': str(price)}, 'line': {'pushed': res.get('pushed'),
                    'reason': res.get('reason')}, 'preview': msg})

@app.route('/api/tv_log')
def tv_log():
    """Recent TradingView signals received (best-effort, in-memory)."""
    return jsonify(_tv_recent)

@app.route('/api/scan_and_push')
def scan_and_push():
    """Scheduled (Vercel Cron) endpoint: push 🤖 AI/科技股精選 + 📰 新聞選股 to
    LINE. Auth: Vercel injects `Authorization: Bearer $CRON_SECRET` when the env
    var is set; we also accept ?key=<CRON_SECRET>. `mode` query selects content
    (tech_news default / value)."""
    secret = os.environ.get('CRON_SECRET', '')
    if secret:
        auth = request.headers.get('Authorization', '')
        if auth != f'Bearer {secret}' and request.args.get('key', '') != secret:
            return jsonify({'error': 'unauthorized'}), 401

    mode = request.args.get('mode', 'tech_news')
    today = datetime.date.today().strftime('%m/%d')

    if mode == 'value':
        try:
            threshold = float(request.args.get('mos', '8'))
        except ValueError:
            threshold = 8.0
        alerts = _scan_value_alerts(threshold)
        if not alerts:
            return jsonify({'pushed': False, 'reason': 'no cheap good stocks', 'count': 0})
        lines = ['🎯 估值雷達：好公司進入便宜區', f'（{today} 盤後）', '']
        for a in alerts[:8]:
            lines.append(f"・{a['name']}({a['code']})　低估 {a['margin_of_safety']}%")
            lines.append(f"　現價 {a['price']} / 合理價 {a['fair_price']}")
        lines += ['', '※ 僅供參考，不構成投資建議']
        return jsonify(_line_push('\n'.join(lines), len(alerts)))

    # Default: 技術面進場訊號 + AI/科技股精選 + 新聞選股
    sigs = _compute_entry_signals()
    tech = _compute_tech_picks()
    news = _compute_news_picks()
    sig_strong = [s for s in sigs if s.get('total_weight', 0) >= 7][:5]
    tech_strong = [t for t in tech if t['score'] >= 2][:5] or tech[:4]
    sections = []
    if sig_strong:
        block = ['📊 技術面進場訊號']
        for s in sig_strong:
            tags = '、'.join(sig['type'] for sig in s.get('signals', [])[:2])
            block.append(f"・{s['name']}({s['code']})　{s['change_pct']:+.1f}%"
                         f"\n　進場 {s['entry']}｜停損 {s['stop_loss']}｜目標 {s['target']}"
                         + (f"\n　{tags}" if tags else ''))
        sections.append('\n'.join(block))
    if tech_strong:
        block = ['🤖 AI/科技股精選']
        for t in tech_strong:
            tag = '｜'.join(t['reasons'][:2]) if t.get('reasons') else ''
            block.append(f"・{t['name']}({t['code']})　{t['change_pct']:+.1f}%" + (f"\n　{tag}" if tag else ''))
        sections.append('\n'.join(block))
    if news:
        block = ['📰 新聞熱門選股']
        for n in news[:5]:
            block.append(f"・{n['name']}({n['code']})　{n['change_pct']:+.1f}%　新聞提及 {n['score']} 次")
        sections.append('\n'.join(block))

    if not sections:
        return jsonify({'pushed': False, 'reason': 'no picks today', 'count': 0})

    msg = f'📈 台股盤後精選（{today}）\n\n' + '\n\n'.join(sections) + '\n\n※ 僅供參考，不構成投資建議'
    return jsonify(_line_push(msg, len(sig_strong) + len(tech_strong) + len(news[:5])))

@app.route('/api/recommend')
def recommend():
    # 1. Fetch all fundamental data in parallel-ish (cached after first call)
    fund_map = _fetch_pe_pb_yield()       # PE, PB, dividend yield
    rev_map = _fetch_revenue_growth()      # revenue MoM/YoY growth
    inst_map = _fetch_institutional()      # institutional buying

    # 2. Fetch real-time prices for popular stocks
    all_tse = list(dict.fromkeys(POPULAR_TSE))
    all_otc = list(dict.fromkeys(POPULAR_OTC))
    pairs = [(c, 'tse') for c in all_tse] + [(c, 'otc') for c in all_otc]
    stocks = fetch_stocks(pairs)

    seen = set()
    unique = []
    for s in stocks:
        if s['code'] not in seen and s['price'] > 0:
            seen.add(s['code'])
            unique.append(s)

    # 3. Score each stock with fundamentals + technicals
    scored = []
    for s in unique:
        code = s['code']
        score = 0
        reasons = []
        fund = fund_map.get(code, {})
        rev = rev_map.get(code, {})
        inst = inst_map.get(code)

        pe = fund.get('pe')
        dy = fund.get('yield')
        pb = fund.get('pb')
        yoy = rev.get('yoy')
        mom = rev.get('mom')

        # ── PE ratio scoring ──
        if pe is not None and pe > 0:
            if pe <= 12:
                score += 4
                reasons.append(f'本益比極低 {pe:.1f}')
            elif pe <= 18:
                score += 3
                reasons.append(f'本益比偏低 {pe:.1f}')
            elif pe <= 25:
                score += 2
                reasons.append(f'本益比合理 {pe:.1f}')
            elif pe <= 40:
                score += 1

        # ── Dividend yield scoring ──
        if dy is not None:
            if dy >= 6:
                score += 4
                reasons.append(f'高殖利率 {dy:.1f}%')
            elif dy >= 4:
                score += 3
                reasons.append(f'殖利率佳 {dy:.1f}%')
            elif dy >= 2:
                score += 2
                reasons.append(f'殖利率 {dy:.1f}%')
            elif dy >= 1:
                score += 1

        # ── PB ratio scoring ──
        if pb is not None:
            if pb < 1:
                score += 3
                reasons.append(f'股價淨值比 {pb:.2f} (低於淨值)')
            elif pb < 1.5:
                score += 2
                reasons.append(f'淨值比偏低 {pb:.2f}')
            elif pb < 2.5:
                score += 1

        # ── Revenue YoY growth scoring ──
        if yoy is not None:
            if yoy >= 50:
                score += 5
                reasons.append(f'營收年增 {yoy:+.1f}% 🚀')
            elif yoy >= 30:
                score += 4
                reasons.append(f'營收年增 {yoy:+.1f}%')
            elif yoy >= 15:
                score += 3
                reasons.append(f'營收年增 {yoy:+.1f}%')
            elif yoy >= 5:
                score += 2
                reasons.append(f'營收穩定成長 {yoy:+.1f}%')
            elif yoy > 0:
                score += 1

        # ── Revenue MoM growth scoring ──
        if mom is not None:
            if mom >= 20:
                score += 3
                reasons.append(f'月營收大增 {mom:+.1f}%')
            elif mom >= 10:
                score += 2
                reasons.append(f'月營收成長 {mom:+.1f}%')
            elif mom > 0:
                score += 1

        # ── Institutional buying scoring ──
        if inst and inst['total'] > 0:
            lots = inst['total'] // 1000
            if lots > 1000:
                score += 4
                reasons.append(f'法人狂買 {lots:,}張')
            elif lots > 500:
                score += 3
                reasons.append(f'法人大買 {lots:,}張')
            elif lots > 100:
                score += 2
                reasons.append(f'法人買超 {lots:,}張')
            elif lots > 0:
                score += 1
            if inst.get('foreign', 0) > 0 and inst.get('trust', 0) > 0:
                score += 2
                reasons.append('外資投信聯手')

        # ── Price momentum (small bonus) ──
        if s['change_pct'] > 3:
            score += 2
            reasons.append(f'今日強漲 +{s["change_pct"]}%')
        elif s['change_pct'] > 1:
            score += 1

        # Must have at least some fundamental data and a minimum score
        has_fundamental = (pe is not None) or (dy is not None) or (yoy is not None)
        if score >= 6 and reasons and has_fundamental:
            # Determine category based on strongest dimension
            has_rev_growth = yoy is not None and yoy > 20
            has_high_yield = (dy or 0) >= 5
            inst_score = (inst['total'] if inst else 0) // 1000
            has_value = pe is not None and pe <= 15 and (dy or 0) >= 3

            if has_rev_growth and has_high_yield:
                cat = '基本面優質'
                cat_icon = '🏆'
            elif has_rev_growth:
                cat = '營收成長股'
                cat_icon = '📊'
            elif has_high_yield:
                cat = '高殖利率'
                cat_icon = '💰'
            elif inst_score > 500:
                cat = '法人加持'
                cat_icon = '🔥'
            elif has_value:
                cat = '低估值精選'
                cat_icon = '🏆'
            else:
                cat = '綜合推薦'
                cat_icon = '⭐'

            scored.append({
                'code': code, 'name': s['name'],
                'price': s['price'], 'change': s['change'],
                'change_pct': s['change_pct'], 'volume': s['volume'],
                'market': s['market'], 'score': score,
                'category': cat, 'cat_icon': cat_icon,
                'reasons': reasons,
                # Fundamental data for frontend display
                'pe': round(pe, 1) if pe else None,
                'pb': round(pb, 2) if pb else None,
                'dividend_yield': round(dy, 2) if dy else None,
                'rev_yoy': round(yoy, 1) if yoy else None,
                'rev_mom': round(mom, 1) if mom else None,
            })

    scored.sort(key=lambda x: x['score'], reverse=True)
    return jsonify(scored[:12])

@app.route('/api/recommend_sell')
def recommend_sell():
    """Recommend stocks to SELL based on fundamental deterioration"""
    fund_map = _fetch_pe_pb_yield()
    rev_map = _fetch_revenue_growth()
    inst_map = _fetch_institutional()

    all_tse = list(dict.fromkeys(POPULAR_TSE))
    all_otc = list(dict.fromkeys(POPULAR_OTC))
    pairs = [(c, 'tse') for c in all_tse] + [(c, 'otc') for c in all_otc]
    stocks = fetch_stocks(pairs)

    seen = set()
    unique = []
    for s in stocks:
        if s['code'] not in seen and s['price'] > 0:
            seen.add(s['code'])
            unique.append(s)

    scored = []
    for s in unique:
        code = s['code']
        score = 0
        reasons = []
        fund = fund_map.get(code, {})
        rev = rev_map.get(code, {})
        inst = inst_map.get(code)

        pe = fund.get('pe')
        dy = fund.get('yield')
        pb = fund.get('pb')
        yoy = rev.get('yoy')
        mom = rev.get('mom')

        # ── PE ratio: overvalued ──
        if pe is not None:
            if pe < 0:
                score += 4
                reasons.append(f'本益比為負 {pe:.1f} (虧損)')
            elif pe > 100:
                score += 4
                reasons.append(f'本益比極高 {pe:.1f}')
            elif pe > 60:
                score += 3
                reasons.append(f'本益比偏高 {pe:.1f}')
            elif pe > 40:
                score += 2
                reasons.append(f'本益比偏貴 {pe:.1f}')

        # ── PB ratio: overpriced ──
        if pb is not None:
            if pb > 8:
                score += 3
                reasons.append(f'淨值比極高 {pb:.2f}')
            elif pb > 5:
                score += 2
                reasons.append(f'淨值比偏高 {pb:.2f}')

        # ── No dividend ──
        if dy is not None and dy == 0 and pe is not None and pe > 30:
            score += 2
            reasons.append('零殖利率 + 高本益比')

        # ── Revenue YoY decline ──
        if yoy is not None:
            if yoy <= -30:
                score += 5
                reasons.append(f'營收年減 {yoy:.1f}% 📉')
            elif yoy <= -15:
                score += 4
                reasons.append(f'營收年減 {yoy:.1f}%')
            elif yoy <= -5:
                score += 3
                reasons.append(f'營收衰退 {yoy:.1f}%')
            elif yoy < 0:
                score += 1

        # ── Revenue MoM decline ──
        if mom is not None:
            if mom <= -30:
                score += 3
                reasons.append(f'月營收驟降 {mom:.1f}%')
            elif mom <= -15:
                score += 2
                reasons.append(f'月營收下滑 {mom:.1f}%')
            elif mom <= -5:
                score += 1

        # ── Institutional selling ──
        if inst and inst['total'] < 0:
            lots = abs(inst['total']) // 1000
            if lots > 1000:
                score += 4
                reasons.append(f'法人狂賣 {lots:,}張')
            elif lots > 500:
                score += 3
                reasons.append(f'法人大賣 {lots:,}張')
            elif lots > 100:
                score += 2
                reasons.append(f'法人賣超 {lots:,}張')
            elif lots > 0:
                score += 1
            if inst.get('foreign', 0) < 0 and inst.get('trust', 0) < 0:
                score += 2
                reasons.append('外資投信同步賣出')

        # ── Price dropping ──
        if s['change_pct'] < -5:
            score += 3
            reasons.append(f'今日重挫 {s["change_pct"]}%')
        elif s['change_pct'] < -2:
            score += 2
            reasons.append(f'今日下跌 {s["change_pct"]}%')
        elif s['change_pct'] < 0:
            score += 1

        has_fundamental = (pe is not None) or (yoy is not None)
        if score >= 6 and reasons and has_fundamental:
            has_rev_decline = yoy is not None and yoy < -10
            has_inst_sell = inst is not None and inst['total'] < -500000
            has_high_pe = pe is not None and (pe > 60 or pe < 0)

            if has_rev_decline and has_high_pe:
                cat = '基本面惡化'
                cat_icon = '🚨'
            elif has_inst_sell:
                cat = '法人倒貨'
                cat_icon = '📉'
            elif has_rev_decline:
                cat = '營收衰退'
                cat_icon = '⚠️'
            elif has_high_pe:
                cat = '高估值風險'
                cat_icon = '💸'
            else:
                cat = '綜合警示'
                cat_icon = '🔻'

            scored.append({
                'code': code, 'name': s['name'],
                'price': s['price'], 'change': s['change'],
                'change_pct': s['change_pct'], 'volume': s['volume'],
                'market': s['market'], 'score': score,
                'category': cat, 'cat_icon': cat_icon,
                'reasons': reasons,
                'pe': round(pe, 1) if pe else None,
                'pb': round(pb, 2) if pb else None,
                'dividend_yield': round(dy, 2) if dy else None,
                'rev_yoy': round(yoy, 1) if yoy else None,
                'rev_mom': round(mom, 1) if mom else None,
            })

    scored.sort(key=lambda x: x['score'], reverse=True)
    return jsonify(scored[:12])

@app.route('/api/hot_stocks')
def hot_stocks():
    """Return institutional buying rankings + volume leaders"""
    inst_map = _fetch_institutional()

    # Filter out ETFs (codes starting with 00) for individual stock rankings
    etf_prefixes = ('00',)
    stocks_only = {k: v for k, v in inst_map.items() if not k.startswith(etf_prefixes)}

    def _build_ranking(data, sort_key, limit=10):
        items = sorted(data.items(), key=lambda x: x[1][sort_key], reverse=True)[:limit]
        result = []
        for code, info in items:
            name = STOCK_NAMES.get(code) or info.get('name', code)
            lots = info[sort_key] // 1000
            if lots <= 0:
                continue
            result.append({
                'code': code, 'name': name,
                'lots': lots,
                'foreign_lots': info['foreign'] // 1000,
                'trust_lots': info['trust'] // 1000,
                'total_lots': info['total'] // 1000,
            })
        return result

    # Rankings for individual stocks (exclude ETFs)
    foreign_rank = _build_ranking(stocks_only, 'foreign', 10)
    trust_rank = _build_ranking(stocks_only, 'trust', 10)
    total_rank = _build_ranking(stocks_only, 'total', 10)

    # Volume leaders from TWSE
    volume_rank = []
    try:
        data = cached_get('https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX20?response=json&type=ALLBUT0999', ttl=1800)
        if data.get('stat') == 'OK':
            for row in data.get('data', [])[:20]:
                try:
                    code = row[1].strip()
                    name = STOCK_NAMES.get(code) or row[2].strip()
                    vol_shares = int(row[3].replace(',', ''))
                    close_str = row[8].replace(',', '')
                    close = float(close_str) if close_str and close_str != '--' else 0
                    # Parse change direction from HTML span (red=up, green=down)
                    sign_html = str(row[9])
                    chg_val_str = row[10].replace(',', '')
                    chg_val = float(chg_val_str) if chg_val_str and chg_val_str != '0.00' else 0
                    if 'green' in sign_html:
                        chg_val = -abs(chg_val)
                    chg_pct = round(chg_val / (close - chg_val) * 100, 2) if close and (close - chg_val) != 0 else 0
                    volume_rank.append({
                        'code': code, 'name': name,
                        'volume': vol_shares // 1000,  # in lots (張)
                        'close': close, 'change': round(chg_val, 2),
                        'change_pct': chg_pct,
                    })
                except (ValueError, IndexError):
                    continue
    except Exception:
        pass

    return jsonify({
        'foreign': foreign_rank,
        'trust': trust_rank,
        'total': total_rank,
        'volume': volume_rank,
    })

@app.route('/api/watchlist_health')
def watchlist_health():
    """Analyze all stocks in the user's watchlist"""
    wl = load_watchlist()
    if not wl:
        return jsonify([])
    fund_map = _fetch_pe_pb_yield()
    rev_map = _fetch_revenue_growth()
    inst_map = _fetch_institutional()

    # Fetch real-time prices
    pairs = [(w['code'], w.get('market', 'tse')) for w in wl]
    stocks = fetch_stocks(pairs)
    smap = {s['code']: s for s in stocks}

    results = []
    for w in wl:
        code = w['code']
        s = smap.get(code)
        if not s:
            continue
        fund = fund_map.get(code, {})
        rev = rev_map.get(code, {})
        inst = inst_map.get(code)
        pe = fund.get('pe')
        dy = fund.get('yield')
        pb = fund.get('pb')
        yoy = rev.get('yoy')
        mom = rev.get('mom')

        buy_score, sell_score = 0, 0
        alerts = []

        if pe is not None:
            if pe < 0:
                sell_score += 4; alerts.append('⚠️ 虧損中')
            elif pe <= 15:
                buy_score += 3
            elif pe > 60:
                sell_score += 3; alerts.append(f'⚠️ PE={pe:.0f} 過高')
            elif pe > 40:
                sell_score += 2
        if dy is not None:
            if dy >= 5: buy_score += 3
            elif dy >= 3: buy_score += 2
        if pb is not None:
            if pb < 1: buy_score += 2
            elif pb > 8: sell_score += 2; alerts.append(f'⚠️ PB={pb:.1f} 過高')
        if yoy is not None:
            if yoy >= 20: buy_score += 3
            elif yoy >= 5: buy_score += 1
            elif yoy <= -20:
                sell_score += 4; alerts.append(f'📉 營收年減{yoy:.0f}%')
            elif yoy < 0:
                sell_score += 2; alerts.append(f'📉 營收衰退{yoy:.0f}%')
        if mom is not None:
            if mom >= 15: buy_score += 1
            elif mom <= -20: sell_score += 1
        if inst:
            total_lots = inst['total'] // 1000
            if total_lots > 500: buy_score += 2
            elif total_lots < -500:
                sell_score += 2; alerts.append(f'📉 法人賣超{abs(total_lots):,}張')

        diff = buy_score - sell_score
        if diff >= 4:
            action, icon, color = '加碼', '🟢', 'green'
        elif diff >= 1:
            action, icon, color = '持有', '🟡', 'gold'
        elif diff >= -2:
            action, icon, color = '觀望', '🟠', 'orange'
        else:
            action, icon, color = '減碼', '🔴', 'red'

        results.append({
            'code': code, 'name': s['name'],
            'price': s['price'], 'change': s['change'],
            'change_pct': s['change_pct'],
            'action': action, 'icon': icon, 'color': color,
            'buy_score': buy_score, 'sell_score': sell_score,
            'pe': round(pe, 1) if pe else None,
            'dividend_yield': round(dy, 2) if dy else None,
            'rev_yoy': round(yoy, 1) if yoy else None,
            'alerts': alerts,
        })
    return jsonify(results)

@app.route('/api/margin')
def margin_trading():
    """Fetch margin trading (融資融券) data for individual stocks"""
    today = datetime.date.today()
    result = {'date': '', 'summary': {}, 'stocks': []}
    for days_back in range(7):
        d = today - datetime.timedelta(days=days_back)
        if d.weekday() >= 5:
            continue
        date_str = d.strftime('%Y%m%d')
        try:
            url = f'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date={date_str}&selectType=ALL'
            data = cached_get(url, ttl=3600)
            if data.get('stat') != 'OK':
                continue
            tables = data.get('tables', [])
            if len(tables) < 2:
                continue
            # Summary table
            summary = tables[0]
            for row in summary.get('data', []):
                if '融資' in row[0] and '金額' not in row[0]:
                    result['summary']['margin_buy'] = row[1]
                    result['summary']['margin_sell'] = row[2]
                    result['summary']['margin_balance'] = row[4]
                    result['summary']['margin_today'] = row[5] if len(row) > 5 else row[4]
                elif '融券' in row[0] and '金額' not in row[0]:
                    result['summary']['short_buy'] = row[1]
                    result['summary']['short_sell'] = row[2]
                    result['summary']['short_balance'] = row[4]
                    result['summary']['short_today'] = row[5] if len(row) > 5 else row[4]
            # Individual stocks — pick top movers
            detail = tables[1]
            all_stocks = []
            for row in detail.get('data', []):
                try:
                    code = row[0].strip()
                    if code.startswith('00'):
                        continue  # skip ETFs
                    name = STOCK_NAMES.get(code) or row[1].strip()
                    m_prev = int(row[5].replace(',', ''))
                    m_today = int(row[6].replace(',', ''))
                    m_chg = m_today - m_prev
                    s_prev = int(row[11].replace(',', ''))
                    s_today = int(row[12].replace(',', ''))
                    s_chg = s_today - s_prev
                    all_stocks.append({
                        'code': code, 'name': name,
                        'margin_balance': m_today, 'margin_change': m_chg,
                        'short_balance': s_today, 'short_change': s_chg,
                    })
                except (ValueError, IndexError):
                    continue
            # Sort: top margin increase + top margin decrease
            inc = sorted(all_stocks, key=lambda x: x['margin_change'], reverse=True)[:10]
            dec = sorted(all_stocks, key=lambda x: x['margin_change'])[:10]
            result['stocks_increase'] = inc
            result['stocks_decrease'] = dec
            roc_year = d.year - 1911
            result['date'] = f'{roc_year}/{d.month:02d}/{d.day:02d}'
            break
        except Exception:
            continue
    return jsonify(result)

@app.route('/api/dca_calc')
def dca_calc():
    """Dollar Cost Averaging (定期定額) calculator using historical data"""
    code = request.args.get('code', '').strip()
    monthly = request.args.get('amount', '3000')
    months_str = request.args.get('months', '12')
    if not code:
        return jsonify({'error': 'need code'}), 400
    try:
        monthly_amount = int(monthly)
        total_months = int(months_str)
    except ValueError:
        return jsonify({'error': 'invalid amount'}), 400
    total_months = min(total_months, 36)  # cap at 3 years

    # Determine market
    market = 'tse'
    if code in [c for c in POPULAR_OTC]:
        market = 'otc'

    # Fetch enough historical data (unified fetcher: TSE + OTC + Yahoo fallback)
    all_data = fetch_daily_history(code, market, months=total_months + 2)
    if not all_data:
        return jsonify({'error': 'no data', 'records': []})

    # Group by month, take first trading day of each month
    monthly_prices = {}
    for d in all_data:
        month_key = d['date'][:7]  # YYYY-MM
        if month_key not in monthly_prices:
            monthly_prices[month_key] = d['close']

    months_list = sorted(monthly_prices.keys())
    if len(months_list) < 2:
        return jsonify({'error': 'not enough data', 'records': []})

    # Take only the last N months
    target_months = months_list[-total_months:] if len(months_list) >= total_months else months_list

    records = []
    total_invested = 0
    total_shares = 0
    for mo in target_months:
        price = monthly_prices[mo]
        shares = monthly_amount / price
        total_invested += monthly_amount
        total_shares += shares
        current_value = total_shares * price
        records.append({
            'month': mo,
            'price': round(price, 2),
            'shares': round(shares, 4),
            'total_shares': round(total_shares, 4),
            'total_invested': total_invested,
            'value': round(current_value, 0),
        })

    # Current price
    current_price = all_data[-1]['close'] if all_data else monthly_prices.get(target_months[-1], 0)
    current_value = round(total_shares * current_price, 0)
    profit = current_value - total_invested
    profit_pct = round(profit / total_invested * 100, 2) if total_invested > 0 else 0
    avg_cost = round(total_invested / total_shares, 2) if total_shares > 0 else 0
    name = STOCK_NAMES.get(code, code)

    return jsonify({
        'code': code, 'name': name,
        'months': len(target_months),
        'monthly_amount': monthly_amount,
        'total_invested': total_invested,
        'total_shares': round(total_shares, 4),
        'avg_cost': avg_cost,
        'current_price': current_price,
        'current_value': current_value,
        'profit': round(profit, 0),
        'profit_pct': profit_pct,
        'records': records,
    })

@app.route('/api/chip_analysis')
def chip_analysis():
    """Analyze chip distribution (籌碼面) for a given stock"""
    code = request.args.get('code', '').strip()
    if not code:
        return jsonify({'error': 'need code'}), 400

    inst_map = _fetch_institutional()
    inst = inst_map.get(code)

    # Get multi-day institutional data for trend
    today = datetime.date.today()
    daily_data = []
    for days_back in range(10):
        d = today - datetime.timedelta(days=days_back)
        if d.weekday() >= 5:
            continue
        date_str = d.strftime('%Y%m%d')
        try:
            url = f'https://www.twse.com.tw/fund/T86?response=json&date={date_str}&selectType=ALLBUT0999'
            data = cached_get(url, ttl=3600)
            if data.get('stat') == 'OK' and data.get('data'):
                for row in data['data']:
                    try:
                        if row[0].strip() == code:
                            daily_data.append({
                                'date': d.strftime('%m/%d'),
                                'foreign': int(row[4].replace(',', '')) // 1000,
                                'trust': int(row[10].replace(',', '')) // 1000,
                                'total': int(row[18].replace(',', '')) // 1000,
                            })
                            break
                    except (ValueError, IndexError):
                        continue
        except Exception:
            continue

    daily_data.reverse()  # oldest first

    # Margin data for the stock
    margin_info = {}
    for days_back in range(7):
        d = today - datetime.timedelta(days=days_back)
        if d.weekday() >= 5:
            continue
        date_str = d.strftime('%Y%m%d')
        try:
            url = f'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date={date_str}&selectType=ALL'
            data = cached_get(url, ttl=3600)
            if data.get('stat') != 'OK':
                continue
            tables = data.get('tables', [])
            if len(tables) < 2:
                continue
            detail = tables[1]
            for row in detail.get('data', []):
                try:
                    if row[0].strip() == code:
                        margin_info = {
                            'margin_balance': int(row[6].replace(',', '')),
                            'margin_change': int(row[6].replace(',', '')) - int(row[5].replace(',', '')),
                            'short_balance': int(row[12].replace(',', '')),
                            'short_change': int(row[12].replace(',', '')) - int(row[11].replace(',', '')),
                        }
                        break
                except (ValueError, IndexError):
                    continue
            if margin_info:
                break
        except Exception:
            continue

    # Calculate trend
    total_foreign = sum(d['foreign'] for d in daily_data)
    total_trust = sum(d['trust'] for d in daily_data)
    total_net = sum(d['total'] for d in daily_data)
    consecutive_buy = 0
    consecutive_sell = 0
    for d in reversed(daily_data):
        if d['total'] > 0:
            consecutive_buy += 1
        else:
            break
    for d in reversed(daily_data):
        if d['total'] < 0:
            consecutive_sell += 1
        else:
            break

    # Generate insight
    insights = []
    if consecutive_buy >= 3:
        insights.append(f'🔥 法人連續{consecutive_buy}日買超，籌碼持續集中')
    elif consecutive_sell >= 3:
        insights.append(f'⚠️ 法人連續{consecutive_sell}日賣超，籌碼鬆動中')

    if total_foreign > 0 and total_trust > 0:
        insights.append('✅ 近期外資投信同步買進，主力認同度高')
    elif total_foreign < 0 and total_trust < 0:
        insights.append('🚨 外資投信同步賣出，注意風險')
    elif total_foreign > 0 and total_trust < 0:
        insights.append('📊 外資買、投信賣，法人意見分歧')
    elif total_foreign < 0 and total_trust > 0:
        insights.append('📊 投信買、外資賣，短線可能有支撐')

    if margin_info:
        mc = margin_info.get('margin_change', 0)
        if mc > 500:
            insights.append(f'📈 融資大增{mc:,}張，散戶追買意願強')
        elif mc < -500:
            insights.append(f'📉 融資減少{abs(mc):,}張，散戶停損或換股')

    # Chip concentration score
    chip_score = 0
    if total_net > 0:
        chip_score += min(total_net // 500, 5)
    else:
        chip_score -= min(abs(total_net) // 500, 5)
    if consecutive_buy >= 3:
        chip_score += 2
    elif consecutive_sell >= 3:
        chip_score -= 2

    if chip_score >= 4:
        status = '籌碼集中'
        status_icon = '🟢'
        status_color = 'green'
    elif chip_score >= 1:
        status = '偏多'
        status_icon = '🟡'
        status_color = 'gold'
    elif chip_score >= -1:
        status = '中性'
        status_icon = '⚪'
        status_color = 'gray'
    elif chip_score >= -4:
        status = '偏空'
        status_icon = '🟠'
        status_color = 'orange'
    else:
        status = '籌碼鬆散'
        status_icon = '🔴'
        status_color = 'red'

    name = STOCK_NAMES.get(code, code)
    return jsonify({
        'code': code,
        'name': name,
        'status': status,
        'status_icon': status_icon,
        'status_color': status_color,
        'chip_score': chip_score,
        'daily': daily_data,
        'total_foreign': total_foreign,
        'total_trust': total_trust,
        'total_net': total_net,
        'consecutive_buy': consecutive_buy,
        'consecutive_sell': consecutive_sell,
        'margin': margin_info,
        'insights': insights,
    })

@app.route('/api/backtest')
def backtest():
    """Compare historical performance of multiple stocks"""
    codes_str = request.args.get('codes', '').strip()
    months = int(request.args.get('months', '3'))
    if not codes_str:
        return jsonify({'error': 'need codes'}), 400
    codes = [c.strip() for c in codes_str.split(',') if c.strip()][:5]  # max 5 stocks
    months = min(months, 12)

    results = []
    for code in codes:
        market = 'otc' if code in POPULAR_OTC else 'tse'
        # Unified fetcher: TSE + OTC + Yahoo fallback, sorted & deduped
        all_data = fetch_daily_history(code, market, months=months + 1)
        if len(all_data) < 2:
            continue

        start_price = all_data[0]['close']
        end_price = all_data[-1]['close']
        max_price = max(d['close'] for d in all_data)
        min_price = min(d['close'] for d in all_data)
        total_return = round((end_price - start_price) / start_price * 100, 2)
        max_drawdown = round((min_price - max_price) / max_price * 100, 2) if max_price else 0

        # Weekly data points for chart
        chart_data = []
        base = all_data[0]['close']
        for d in all_data:
            pct = round((d['close'] - base) / base * 100, 2)
            chart_data.append({'date': d['date'], 'pct': pct, 'close': d['close']})

        name = STOCK_NAMES.get(code, code)
        results.append({
            'code': code, 'name': name,
            'start_price': start_price, 'end_price': end_price,
            'max_price': max_price, 'min_price': min_price,
            'total_return': total_return, 'max_drawdown': max_drawdown,
            'chart': chart_data,
            'data_points': len(all_data),
        })

    # Sort by return descending
    results.sort(key=lambda x: x['total_return'], reverse=True)
    return jsonify(results)

@app.route('/api/daily_summary')
def daily_summary():
    """Generate AI-style daily market summary"""
    import xml.etree.ElementTree as ET

    # 1. Get market index
    market = {}
    try:
        data = cached_get(f'{API_BASE}?ex_ch=tse_t00.tw|otc_o00.tw', ttl=60)
        for item in data.get('msgArray', []):
            s = parse_stock(item)
            if s and item.get('c') == 't00':
                market['tse'] = s
            elif s and item.get('c') == 'o00':
                market['otc'] = s
    except Exception:
        pass

    # Yahoo fallback
    if 'tse' not in market:
        try:
            url = f'https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?interval=1d&range=5d'
            d = cached_get(url, ttl=60)
            meta = d.get('chart', {}).get('result', [{}])[0].get('meta', {})
            price = float(meta.get('regularMarketPrice', 0))
            prev = float(meta.get('chartPreviousClose', 0) or meta.get('previousClose', 0))
            if price and prev:
                chg = round(price - prev, 2)
                pct = round(chg / prev * 100, 2)
                market['tse'] = {'price': price, 'change': chg, 'change_pct': pct}
        except Exception:
            pass

    # 2. Institutional summary
    inst_map = _fetch_institutional()
    total_foreign = sum(v['foreign'] for v in inst_map.values())
    total_trust = sum(v['trust'] for v in inst_map.values())
    total_all = sum(v['total'] for v in inst_map.values())

    # Top 3 foreign buy
    foreign_top = sorted(inst_map.items(), key=lambda x: x[1]['foreign'], reverse=True)[:3]
    trust_top = sorted(inst_map.items(), key=lambda x: x[1]['trust'], reverse=True)[:3]

    # 3. Margin data
    margin_summary = {}
    today = datetime.date.today()
    for days_back in range(7):
        d = today - datetime.timedelta(days=days_back)
        if d.weekday() >= 5:
            continue
        date_str = d.strftime('%Y%m%d')
        try:
            url = f'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date={date_str}&selectType=ALL'
            data = cached_get(url, ttl=3600)
            if data.get('stat') != 'OK':
                continue
            tables = data.get('tables', [])
            if tables:
                for row in tables[0].get('data', []):
                    if '融資' in row[0] and '金額' not in row[0]:
                        try:
                            margin_summary['margin_change'] = int(row[5].replace(',', '')) - int(row[4].replace(',', ''))
                        except (ValueError, IndexError):
                            margin_summary['margin_change'] = 0
                    elif '融券' in row[0] and '金額' not in row[0]:
                        try:
                            margin_summary['short_change'] = int(row[5].replace(',', '')) - int(row[4].replace(',', ''))
                        except (ValueError, IndexError):
                            margin_summary['short_change'] = 0
            break
        except Exception:
            continue

    # 4. Build summary text
    paragraphs = []

    # Market overview
    tse = market.get('tse', {})
    tse_price = tse.get('price', 0)
    tse_chg = tse.get('change', 0)
    tse_pct = tse.get('change_pct', 0)

    if tse_pct > 2:
        mood = '大漲'
        emoji = '🚀'
    elif tse_pct > 0.5:
        mood = '上漲'
        emoji = '📈'
    elif tse_pct > -0.5:
        mood = '平盤整理'
        emoji = '➡️'
    elif tse_pct > -2:
        mood = '下跌'
        emoji = '📉'
    else:
        mood = '重挫'
        emoji = '💥'

    paragraphs.append({
        'title': f'{emoji} 大盤{mood}',
        'text': f'加權指數收 {tse_price:,.0f} 點，{mood} {abs(tse_chg):,.0f} 點（{tse_pct:+.2f}%）。',
    })

    # Institutional
    f_lots = total_foreign // 1000
    t_lots = total_trust // 1000
    a_lots = total_all // 1000

    if a_lots > 0:
        inst_text = f'三大法人合計買超 {abs(a_lots):,} 張'
    else:
        inst_text = f'三大法人合計賣超 {abs(a_lots):,} 張'

    f_str = f'外資{"買超" if f_lots>0 else "賣超"} {abs(f_lots):,} 張'
    t_str = f'投信{"買超" if t_lots>0 else "賣超"} {abs(t_lots):,} 張'

    # Top foreign buy names
    foreign_names = [STOCK_NAMES.get(c, c) for c, _ in foreign_top if _['foreign'] > 0]
    trust_names = [STOCK_NAMES.get(c, c) for c, _ in trust_top if _['trust'] > 0]

    inst_detail = f'{f_str}，{t_str}。'
    if foreign_names:
        inst_detail += f'外資主要買進：{"、".join(foreign_names[:3])}。'
    if trust_names:
        inst_detail += f'投信主要加碼：{"、".join(trust_names[:3])}。'

    paragraphs.append({
        'title': f'🏦 {inst_text}',
        'text': inst_detail,
    })

    # Margin
    mc = margin_summary.get('margin_change', 0)
    sc = margin_summary.get('short_change', 0)
    margin_text = ''
    if mc > 0:
        margin_text += f'融資增加 {mc:,} 張，散戶追買。'
    elif mc < 0:
        margin_text += f'融資減少 {abs(mc):,} 張，散戶趨於謹慎。'
    if sc > 0:
        margin_text += f'融券增加 {sc:,} 張，空方力道增強。'
    elif sc < 0:
        margin_text += f'融券減少 {abs(sc):,} 張，空方回補。'

    if margin_text:
        paragraphs.append({
            'title': '💳 散戶動向',
            'text': margin_text,
        })

    # Overall assessment
    bullish = 0
    if tse_pct > 0: bullish += 1
    if tse_pct > 1: bullish += 1
    if a_lots > 0: bullish += 1
    if f_lots > 0 and t_lots > 0: bullish += 1
    if mc and mc < 0 and tse_pct > 0: bullish += 1  # price up + margin down = healthy

    if bullish >= 4:
        outlook = '偏多看好'
        outlook_icon = '🟢'
        outlook_text = '法人持續買超，技術面偏多，短線偏樂觀。但需注意漲多後的回檔壓力。'
    elif bullish >= 3:
        outlook = '中性偏多'
        outlook_icon = '🟡'
        outlook_text = '盤勢尚稱穩健，法人態度正向，但動能未明顯加速，宜觀察量能變化。'
    elif bullish >= 2:
        outlook = '中性觀望'
        outlook_icon = '⚪'
        outlook_text = '多空拉鋸中，建議觀望為主，待方向明確再行布局。'
    elif bullish >= 1:
        outlook = '中性偏空'
        outlook_icon = '🟠'
        outlook_text = '盤勢轉弱，法人態度保守，短線宜減碼或觀望。'
    else:
        outlook = '偏空謹慎'
        outlook_icon = '🔴'
        outlook_text = '法人持續賣超，盤勢偏弱，建議降低持股比重，保留現金等待機會。'

    paragraphs.append({
        'title': f'{outlook_icon} 綜合評估：{outlook}',
        'text': outlook_text,
    })

    return jsonify({
        'date': today.strftime('%Y/%m/%d'),
        'paragraphs': paragraphs,
        'market': {
            'tse_price': tse_price,
            'tse_change': tse_chg,
            'tse_pct': tse_pct,
        },
        'institutional': {
            'foreign': f_lots,
            'trust': t_lots,
            'total': a_lots,
        },
        'outlook': outlook,
        'outlook_icon': outlook_icon,
    })

@app.route('/api/price_check')
def price_check():
    """Check if any price alerts should trigger"""
    alerts_str = request.args.get('alerts', '')
    if not alerts_str:
        return jsonify({'triggered': []})

    try:
        alerts = json.loads(alerts_str)
    except json.JSONDecodeError:
        return jsonify({'triggered': []})

    if not alerts:
        return jsonify({'triggered': []})

    # Group by market
    pairs = []
    for a in alerts:
        code = a.get('code', '')
        market = 'otc' if code in POPULAR_OTC else 'tse'
        pairs.append((code, market))

    stocks = fetch_stocks(pairs)
    smap = {s['code']: s for s in stocks}

    triggered = []
    for a in alerts:
        code = a.get('code', '')
        s = smap.get(code)
        if not s:
            continue
        target = float(a.get('price', 0))
        direction = a.get('dir', 'above')

        if direction == 'above' and s['price'] >= target:
            triggered.append({
                'code': code, 'name': s['name'],
                'price': s['price'], 'target': target,
                'direction': direction,
                'message': f'{s["name"]}({code}) 已漲到 {s["price"]}，達到目標價 {target}！',
            })
        elif direction == 'below' and s['price'] <= target:
            triggered.append({
                'code': code, 'name': s['name'],
                'price': s['price'], 'target': target,
                'direction': direction,
                'message': f'{s["name"]}({code}) 已跌到 {s["price"]}，觸及警戒價 {target}！',
            })

    return jsonify({'triggered': triggered})

# ── Supply chain mapping (產業鏈) ──────────────────────────────────────
SUPPLY_CHAIN = {
    # 半導體
    '2330': {'role': 'IC 製造', 'upstream': [('2454','IC 設計'),('3443','IP 設計'),('6770','IC 製造')], 'downstream': [('3711','封測'),('2303','IC 製造'),('6239','矽智財')]},
    '2454': {'role': 'IC 設計', 'upstream': [], 'downstream': [('2330','晶圓代工'),('3711','封測')]},
    '2303': {'role': 'IC 製造', 'upstream': [('2454','IC 設計')], 'downstream': [('3711','封測')]},
    '3711': {'role': '封裝測試', 'upstream': [('2330','晶圓代工'),('2303','IC 製造')], 'downstream': [('2317','系統組裝')]},
    '3443': {'role': 'IP 設計', 'upstream': [], 'downstream': [('2330','晶圓代工')]},
    '6770': {'role': 'IC 製造', 'upstream': [('2454','IC 設計')], 'downstream': [('3711','封測')]},
    # 電子代工 / PC
    '2317': {'role': '系統組裝', 'upstream': [('3711','封測'),('2308','電源')], 'downstream': []},
    '2382': {'role': 'AI 伺服器', 'upstream': [('2330','GPU代工'),('2454','IC設計')], 'downstream': []},
    '3231': {'role': 'AI 伺服器', 'upstream': [('2330','GPU代工'),('2454','IC設計')], 'downstream': []},
    '2308': {'role': '電源管理', 'upstream': [], 'downstream': [('2317','系統組裝'),('2382','伺服器')]},
    # PCB/零組件
    '3037': {'role': 'PCB/載板', 'upstream': [], 'downstream': [('2330','晶圓代工'),('2454','IC設計')]},
    '2327': {'role': '被動元件', 'upstream': [], 'downstream': [('2317','系統組裝'),('2382','伺服器')]},
    # 面板/光電
    '3008': {'role': '光學鏡頭', 'upstream': [], 'downstream': [('2317','手機組裝')]},
    # 金融
    '2882': {'role': '壽險金控', 'upstream': [], 'downstream': []},
    '2881': {'role': '金控', 'upstream': [], 'downstream': []},
    '2891': {'role': '金控', 'upstream': [], 'downstream': []},
    '2886': {'role': '公股金控', 'upstream': [], 'downstream': []},
    '2892': {'role': '公股金控', 'upstream': [], 'downstream': []},
    # 傳產
    '1301': {'role': '石化上游', 'upstream': [], 'downstream': [('1303','塑膠加工'),('1326','石化中游'),('6505','石化')]},
    '1303': {'role': '塑膠加工', 'upstream': [('1301','石化原料')], 'downstream': []},
    '1326': {'role': '石化中游', 'upstream': [('1301','石化原料')], 'downstream': []},
    '6505': {'role': '石化', 'upstream': [('1301','石化原料')], 'downstream': []},
    # 航運
    '2603': {'role': '貨櫃航運', 'upstream': [], 'downstream': []},
    '2609': {'role': '貨櫃航運', 'upstream': [], 'downstream': []},
    '2615': {'role': '貨櫃航運', 'upstream': [], 'downstream': []},
    # 通訊
    '2412': {'role': '電信', 'upstream': [], 'downstream': []},
    '4904': {'role': '電信', 'upstream': [], 'downstream': []},
    # AI server chain
    '2345': {'role': '網通', 'upstream': [], 'downstream': [('2382','伺服器')]},
    '4938': {'role': '代工組裝', 'upstream': [('2330','晶圓代工')], 'downstream': []},
    '3034': {'role': 'IC 設計', 'upstream': [], 'downstream': [('2330','晶圓代工')]},
}

@app.route('/api/supply_chain')
def supply_chain():
    """Get supply chain relationships for a stock"""
    code = request.args.get('code', '').strip()
    if not code:
        return jsonify({'error': 'need code'}), 400
    chain = SUPPLY_CHAIN.get(code)
    name = STOCK_NAMES.get(code, code)
    if not chain:
        return jsonify({'code': code, 'name': name, 'has_chain': False, 'role': '', 'upstream': [], 'downstream': []})
    upstream = [{'code': c, 'name': STOCK_NAMES.get(c, c), 'role': r} for c, r in chain['upstream']]
    downstream = [{'code': c, 'name': STOCK_NAMES.get(c, c), 'role': r} for c, r in chain['downstream']]
    return jsonify({
        'code': code, 'name': name,
        'has_chain': True,
        'role': chain['role'],
        'upstream': upstream,
        'downstream': downstream,
    })

@app.route('/api/stock_news')
def stock_news():
    """Fetch news for a specific stock"""
    code = request.args.get('code', '').strip()
    if not code:
        return jsonify([])
    name = STOCK_NAMES.get(code, _name_cache.get(code, code))
    results = []
    for q in [f'{name} 股票', f'{code} 台股']:
        results.extend(fetch_google_news(q, limit=8))
    # Deduplicate by title, then sort newest-first
    seen = set()
    unique = []
    for n in results:
        if n['title'] not in seen:
            seen.add(n['title'])
            unique.append(n)
    unique = _finalize_news([{**n, '_ts': _parse_pubdate(n.get('date'))} for n in unique])
    return jsonify(unique[:6])

@app.route('/api/entry_signals')
def entry_signals():
    return jsonify(_compute_entry_signals())

def _compute_entry_signals():
    """Scan popular stocks for technical entry signals (RSI, KD, MACD, MA, Bollinger)"""
    import math

    def _fetch_hist(code, market, months=6):
        """Fetch historical OHLCV (delegates to unified fetcher: TSE + OTC + Yahoo)"""
        return fetch_daily_history(code, market, months=months)

    def calc_rsi(closes, period=14):
        return _wilder_rsi(closes, period)

    def calc_kd(highs, lows, closes, k_period=9, k_smooth=3, d_smooth=3):
        if len(closes) < k_period + k_smooth + d_smooth:
            return None, None
        rsv_list = []
        for i in range(k_period - 1, len(closes)):
            window_h = max(highs[i - k_period + 1:i + 1])
            window_l = min(lows[i - k_period + 1:i + 1])
            if window_h == window_l:
                rsv_list.append(50)
            else:
                rsv_list.append((closes[i] - window_l) / (window_h - window_l) * 100)
        # Smooth K
        k_val = 50
        k_list = []
        for rsv in rsv_list:
            k_val = k_val * 2 / 3 + rsv / 3
            k_list.append(k_val)
        # Smooth D
        d_val = 50
        d_list = []
        for k in k_list:
            d_val = d_val * 2 / 3 + k / 3
            d_list.append(d_val)
        return round(k_list[-1], 1), round(d_list[-1], 1)

    def calc_macd(closes, fast=12, slow=26, signal=9):
        if len(closes) < slow + signal:
            return None, None, None
        def ema(data, period):
            multiplier = 2 / (period + 1)
            result = [data[0]]
            for i in range(1, len(data)):
                result.append(data[i] * multiplier + result[-1] * (1 - multiplier))
            return result
        ema_fast = ema(closes, fast)
        ema_slow = ema(closes, slow)
        dif = [ema_fast[i] - ema_slow[i] for i in range(len(closes))]
        dem = ema(dif[slow - 1:], signal)
        dif_recent = dif[-1]
        dem_recent = dem[-1]
        histogram = dif_recent - dem_recent
        return round(dif_recent, 2), round(dem_recent, 2), round(histogram, 2)

    def calc_bollinger(closes, period=20, num_std=2):
        if len(closes) < period:
            return None, None, None
        window = closes[-period:]
        ma = sum(window) / period
        std = math.sqrt(sum((x - ma) ** 2 for x in window) / period)
        return round(ma, 2), round(ma + num_std * std, 2), round(ma - num_std * std, 2)

    # Scan stocks
    scan_list = [(c, 'tse') for c in POPULAR_TSE[:30]] + [(c, 'otc') for c in POPULAR_OTC[:15]]
    results = []

    # Get realtime prices
    rt_map = {}
    rt_stocks = fetch_stocks(scan_list)
    for s in rt_stocks:
        if s and s.get('code'):
            rt_map[s['code']] = s

    for code, market in scan_list:
        try:
            hist = _fetch_hist(code, market, months=5)
            if len(hist) < 40:
                continue

            closes = [r['close'] for r in hist]
            highs = [r['high'] for r in hist]
            lows = [r['low'] for r in hist]
            volumes = [r['volume'] for r in hist]

            rt = rt_map.get(code, {})
            price = rt.get('price', closes[-1])
            change_pct = rt.get('change_pct', 0)
            name = rt.get('name') or STOCK_NAMES.get(code, code)

            signals = []
            entry_price = price
            stop_loss = None
            target = None

            # 1. RSI
            rsi = calc_rsi(closes)
            prev_rsi = calc_rsi(closes[:-1]) if len(closes) > 15 else None

            if rsi is not None:
                if rsi <= 30:
                    signals.append({'type': 'RSI 超賣', 'icon': '📉', 'desc': f'RSI {rsi}，已進入超賣區，反彈機率高', 'weight': 3})
                elif rsi <= 40 and prev_rsi and prev_rsi < rsi:
                    signals.append({'type': 'RSI 回升', 'icon': '📈', 'desc': f'RSI {rsi}，從低檔回升中', 'weight': 2})

            # 2. KD
            k, d = calc_kd(highs, lows, closes)
            prev_k, prev_d = calc_kd(highs[:-1], lows[:-1], closes[:-1]) if len(closes) > 15 else (None, None)

            if k is not None and d is not None:
                if k < 25 and d < 25:
                    signals.append({'type': 'KD 超賣', 'icon': '🔻', 'desc': f'K={k} D={d}，KD 低檔超賣區', 'weight': 3})
                if prev_k is not None and prev_d is not None:
                    if prev_k <= prev_d and k > d and k < 50:
                        signals.append({'type': 'KD 黃金交叉', 'icon': '✨', 'desc': f'K={k} 上穿 D={d}，低檔黃金交叉', 'weight': 4})

            # 3. MACD
            dif, dem, hist_val = calc_macd(closes)
            prev_dif, prev_dem, prev_hist = calc_macd(closes[:-1]) if len(closes) > 36 else (None, None, None)

            if hist_val is not None and prev_hist is not None:
                if prev_hist < 0 and hist_val >= 0:
                    signals.append({'type': 'MACD 翻多', 'icon': '🔄', 'desc': f'MACD 柱翻正 ({hist_val:+.2f})，多方動能啟動', 'weight': 4})
                elif hist_val < 0 and hist_val > prev_hist and dif < 0:
                    signals.append({'type': 'MACD 收斂', 'icon': '🔍', 'desc': f'空方動能減弱 (DIF={dif:.2f})，可能即將翻多', 'weight': 2})

            # 4. MA support
            if len(closes) >= 20:
                ma5 = sum(closes[-5:]) / 5
                ma10 = sum(closes[-10:]) / 10
                ma20 = sum(closes[-20:]) / 20
                ma60 = sum(closes[-60:]) / 60 if len(closes) >= 60 else None

                # Price near MA20 support (within 2%)
                if abs(price - ma20) / ma20 < 0.02 and price >= ma20:
                    signals.append({'type': 'MA20 支撐', 'icon': '🛡️', 'desc': f'股價貼近 20 日均線 ({ma20:.0f})，獲得支撐', 'weight': 3})

                # Price near MA60 support
                if ma60 and abs(price - ma60) / ma60 < 0.02 and price >= ma60:
                    signals.append({'type': 'MA60 支撐', 'icon': '🏰', 'desc': f'股價貼近季線 ({ma60:.0f})，強支撐位', 'weight': 4})

                # MA golden cross (short-term)
                if len(closes) > 20:
                    prev_ma5 = sum(closes[-6:-1]) / 5
                    prev_ma10 = sum(closes[-11:-1]) / 10
                    if prev_ma5 <= prev_ma10 and ma5 > ma10:
                        signals.append({'type': '均線黃金交叉', 'icon': '💫', 'desc': f'MA5 ({ma5:.0f}) 上穿 MA10 ({ma10:.0f})', 'weight': 3})

            # 5. Bollinger Band
            bb_mid, bb_upper, bb_lower = calc_bollinger(closes)
            if bb_lower is not None:
                if price <= bb_lower * 1.01:
                    signals.append({'type': '布林帶下緣', 'icon': '📊', 'desc': f'觸及布林帶下緣 ({bb_lower:.0f})，可能反彈', 'weight': 3})

            # 6. Volume contraction + price stable (accumulation)
            if len(volumes) >= 10:
                avg_vol_5 = sum(volumes[-5:]) / 5
                avg_vol_20 = sum(volumes[-20:]) / 20 if len(volumes) >= 20 else avg_vol_5
                price_range_5 = (max(closes[-5:]) - min(closes[-5:])) / closes[-5] * 100 if closes[-5] else 0

                if avg_vol_5 < avg_vol_20 * 0.6 and price_range_5 < 3:
                    signals.append({'type': '量縮價穩', 'icon': '🤫', 'desc': f'近5日量縮至均量 {avg_vol_5/avg_vol_20*100:.0f}%，價格穩定，可能在吸籌', 'weight': 2})

                # Volume breakout
                if volumes[-1] > avg_vol_20 * 2 and closes[-1] > closes[-2] and change_pct > 2:
                    signals.append({'type': '量能突破', 'icon': '💥', 'desc': f'今日量能為均量 {volumes[-1]/avg_vol_20:.1f} 倍，帶量上攻', 'weight': 3})

            # 7. Trend signals — detect healthy uptrend stocks
            if len(closes) >= 20:
                ma5 = sum(closes[-5:]) / 5
                ma10 = sum(closes[-10:]) / 10
                ma20 = sum(closes[-20:]) / 20
                ma60 = sum(closes[-60:]) / 60 if len(closes) >= 60 else None
                if price > ma5 > ma10 > ma20:
                    signals.append({'type': '均線多頭排列', 'icon': '🚀', 'desc': f'股價站穩所有短中期均線之上，趨勢向上', 'weight': 3})
                if ma60 and price > ma60 * 1.05 and price > ma20:
                    signals.append({'type': '站穩季線上方', 'icon': '🏔️', 'desc': f'股價高於季線 ({ma60:.0f}) 5% 以上，中期趨勢穩健', 'weight': 2})

            # 8. MACD bullish trend (ongoing, not just crossover)
            if dif is not None and dem is not None and hist_val is not None:
                if dif > 0 and dem > 0 and dif > dem and hist_val > 0:
                    if not any(s['type'] == 'MACD 翻多' for s in signals):
                        signals.append({'type': 'MACD 多方運行', 'icon': '📈', 'desc': f'DIF({dif:.1f}) > DEA({dem:.1f})，多方動能持續', 'weight': 2})

            # Filter: volume-only on overbought = chasing, not entry
            non_vol_signals = [s for s in signals if s['type'] != '量能突破']
            if not non_vol_signals and signals:
                # Only volume breakout signal — check if already overbought
                if (rsi and rsi > 60) or (k and k > 70) or change_pct > 7:
                    signals = [{'type': '追高警示', 'icon': '⚠️',
                                'desc': f'今日大漲 {change_pct:+.1f}%，RSI={rsi}，指標已偏高，不建議追高',
                                'weight': -1}]

            if not signals or (len(signals) == 1 and signals[0].get('weight', 0) < 0):
                continue

            # Calculate stop-loss & target (smart levels — same logic as stock_signal)
            total_weight = sum(max(s['weight'], 0) for s in signals)
            _ma5 = sum(closes[-5:]) / 5 if len(closes) >= 5 else price
            _ma10 = sum(closes[-10:]) / 10 if len(closes) >= 10 else price
            _ma20 = sum(closes[-20:]) / 20 if len(closes) >= 20 else price
            _ma60 = sum(closes[-60:]) / 60 if len(closes) >= 60 else None
            _bb_upper = bb_upper

            # ATR-based volatility
            _atr_vals = [max(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1])) for i in range(-min(14, len(closes)-1), 0)]
            _atr = round(sum(_atr_vals) / len(_atr_vals), 2) if _atr_vals else round(price * 0.03, 2)

            # Entry adjustment (same logic as stock_signal)
            entry_price = round(price, 2)
            entry_note = '現價進場'
            if rsi and rsi > 75:
                if _ma5 < price * 0.97:
                    entry_price = round(_ma5, 2)
                    entry_note = '建議回測MA5再進場'
                elif _ma10 < price * 0.95:
                    entry_price = round(_ma10, 2)
                    entry_note = '建議回測MA10再進場'
                else:
                    entry_price = round(price * 0.97, 2)
                    entry_note = '短線過熱，建議回檔3%再進'
            elif rsi and rsi < 30:
                entry_note = '超賣區，可積極進場'
            ep = entry_price

            # Find nearest support within 3-10% of ENTRY price
            _stops = []
            stop_note = ''
            if len(lows) >= 3:
                _rl = min(lows[-3:])
                if _rl < ep:
                    _stops.append((round(_rl * 0.99, 2), '近3日低點下方'))
            for _mv, _mn in [(_ma5, 'MA5'), (_ma10, 'MA10'), (_ma20, 'MA20')]:
                if _mv < ep:
                    _stops.append((round(_mv * 0.98, 2), f'跌破{_mn}'))
            _stops.append((round(ep - 2 * _atr, 2), f'2倍ATR({_atr:.1f})'))
            _valid = [(s, n) for s, n in _stops if ep * 0.90 <= s <= ep * 0.97]
            if _valid:
                stop_loss, stop_note = max(_valid, key=lambda x: x[0])
            else:
                _close = [(s, n) for s, n in _stops if s >= ep * 0.88 and s < ep]
                if _close:
                    stop_loss, stop_note = max(_close, key=lambda x: x[0])
                else:
                    stop_loss = round(ep * 0.95, 2)
                    stop_note = '預設5%停損'

            # Target (multi-candidate, same as stock_signal)
            _tgt_cands = []
            _recent_high = max(highs[-20:]) if len(highs) >= 20 else max(highs[-5:])
            if _recent_high > ep * 1.03:
                _tgt_cands.append((round(_recent_high, 2), '近期高點'))
            if _bb_upper and _bb_upper > ep * 1.02:
                _tgt_cands.append((round(_bb_upper, 2), '布林帶上緣'))
            _rr2 = round(ep + (ep - stop_loss) * 2, 2)
            _tgt_cands.append((_rr2, '風報比1:2'))
            _rr3 = round(ep + (ep - stop_loss) * 3, 2)
            _tgt_cands.append((_rr3, '風報比1:3'))
            if _ma60 and ep > _ma60:
                _tgt_cands.append((round(ep * 1.10, 2), '趨勢延伸+10%'))
            if ep < price * 0.95:
                _tgt_cands.append((round(price, 2), '回測前高水準'))
            _tgt_cands.sort(key=lambda x: x[0])
            _min_tgt = ep + (ep - stop_loss) * 2
            if ep < price * 0.95:
                _min_tgt = max(_min_tgt, price)
            _good = [(t, n) for t, n in _tgt_cands if t >= _min_tgt and t <= ep * 1.50]
            if _good:
                target, target_note = _good[0]
            else:
                if ep < price * 0.95 and price > _rr2:
                    target, target_note = round(price, 2), '回測前高水準'
                else:
                    target, target_note = _rr2, '風報比1:2'

            _risk = ep - stop_loss
            risk_reward = round((target - ep) / _risk, 1) if _risk > 0 else 0
            stop_pct = round((ep - stop_loss) / ep * 100, 1)
            target_pct = round((target - ep) / ep * 100, 1)

            results.append({
                'code': code,
                'name': name,
                'market': market,
                'price': price,
                'change_pct': change_pct,
                'signals': signals,
                'signal_count': len(signals),
                'total_weight': total_weight,
                'entry': entry_price,
                'entry_note': entry_note,
                'stop_loss': stop_loss,
                'stop_pct': stop_pct,
                'stop_note': stop_note,
                'target': target,
                'target_pct': target_pct,
                'target_note': target_note,
                'risk_reward': risk_reward,
                'atr': _atr,
                'rsi': rsi,
                'k': k,
                'd': d,
                'dif': dif,
                'dem': dem,
                'macd_hist': hist_val,
            })
        except Exception:
            continue

    # Sort by total weight (signal strength)
    results.sort(key=lambda x: x['total_weight'], reverse=True)
    return results[:20]

@app.route('/api/portfolio_signals')
def portfolio_signals():
    """Lightweight batch analysis for user's holdings: trend + entry/stop/target + plain-language verdict"""
    import math
    codes_param = request.args.get('codes', '').strip()
    markets_param = request.args.get('markets', '').strip()
    if not codes_param:
        return jsonify([])
    codes = [c.strip() for c in codes_param.split(',') if c.strip()][:20]
    markets_list = [m.strip() for m in markets_param.split(',')] if markets_param else []
    pairs = []
    for i, c in enumerate(codes):
        m = markets_list[i] if i < len(markets_list) and markets_list[i] in ('tse', 'otc') else ('otc' if c in POPULAR_OTC else 'tse')
        pairs.append((c, m))

    # Realtime prices (single batched call)
    rt_map = {}
    for s in fetch_stocks(pairs):
        if s and s.get('code'):
            rt_map[s['code']] = s

    # Fundamentals for the per-holding Buffett value health check (all cached)
    pf_fund_map = _fetch_pe_pb_yield()
    pf_rev_map = _fetch_revenue_growth()
    pf_fundamentals = _fetch_fundamentals()

    def calc_rsi(closes, period=14):
        return _wilder_rsi(closes, period)

    def calc_kd(highs, lows, closes, k_period=9):
        if len(closes) < k_period + 6:
            return None, None
        rsv_list = []
        for i in range(k_period - 1, len(closes)):
            wh = max(highs[i - k_period + 1:i + 1])
            wl = min(lows[i - k_period + 1:i + 1])
            rsv_list.append(50 if wh == wl else (closes[i] - wl) / (wh - wl) * 100)
        k_val = 50
        k_list = []
        for rsv in rsv_list:
            k_val = k_val * 2 / 3 + rsv / 3
            k_list.append(k_val)
        d_val = 50
        for k in k_list:
            d_val = d_val * 2 / 3 + k / 3
        return round(k_list[-1], 1), round(d_val, 1)

    def _fetch_hist_pf(code, market):
        """Fetch historical OHLCV (delegates to unified fetcher: TSE + OTC + Yahoo)"""
        return fetch_daily_history(code, market, months=5)

    def analyze(pair):
        code, market = pair
        try:
            hist = _fetch_hist_pf(code, market)
            rt = rt_map.get(code, {})
            name = rt.get('name') or STOCK_NAMES.get(code, code)
            if len(hist) < 20:
                return {'code': code, 'name': name, 'market': market,
                        'price': rt.get('price', 0), 'change': rt.get('change', 0),
                        'change_pct': rt.get('change_pct', 0), 'error': 'insufficient_data'}
            closes = [r['close'] for r in hist]
            highs = [r['high'] for r in hist]
            lows = [r['low'] for r in hist]
            price = rt.get('price') or closes[-1]
            change = rt.get('change', 0)
            change_pct = rt.get('change_pct', 0)

            ma5 = sum(closes[-5:]) / 5
            ma10 = sum(closes[-10:]) / 10
            ma20 = sum(closes[-20:]) / 20
            ma60 = sum(closes[-60:]) / 60 if len(closes) >= 60 else None
            rsi = calc_rsi(closes)
            k, d = calc_kd(highs, lows, closes)

            # ── Trend: score-based, plain language ──
            t_score = 0
            t_score += 1 if price > ma20 else -1
            t_score += 1 if ma5 > ma20 else -1
            if ma60:
                t_score += 1 if price > ma60 else -1
            t_score += 1 if closes[-1] >= closes[-6] else -1  # 5-day momentum
            if t_score >= 2:
                trend, trend_label = 'up', '上升趨勢'
                trend_desc = '股價站上主要均線，趨勢向上'
                if price > ma5 > ma10 > ma20:
                    trend_desc = '多頭排列，短中期動能都向上'
            elif t_score <= -2:
                trend, trend_label = 'down', '下降趨勢'
                trend_desc = '股價跌破主要均線，趨勢偏弱'
            else:
                trend, trend_label = 'flat', '盤整中'
                trend_desc = '均線糾結，方向不明，等待表態'

            # ── ATR ──
            atr_vals = [max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
                        for i in range(-min(14, len(closes) - 1), 0)]
            atr = sum(atr_vals) / len(atr_vals) if atr_vals else price * 0.03

            # ── Smart entry (same as stock_signal) ──
            entry_price = round(price, 2)
            entry_note = '現價即可進場'
            if rsi and rsi > 75:
                if ma5 < price * 0.97:
                    entry_price = round(ma5, 2)
                    entry_note = '短線過熱，等回到 5 日均線再買'
                elif ma10 < price * 0.95:
                    entry_price = round(ma10, 2)
                    entry_note = '短線過熱，等回到 10 日均線再買'
                else:
                    entry_price = round(price * 0.97, 2)
                    entry_note = '短線過熱，等回檔 3% 再買'
            elif rsi and rsi < 30:
                entry_note = '超賣區，可分批佈局'
            elif abs(price - ma20) / ma20 < 0.02 and price >= ma20:
                entry_note = '貼近月線支撐，進場時機佳'
            ep = entry_price

            # ── Stop loss ──
            stops = []
            if len(lows) >= 3:
                rl = min(lows[-3:])
                if rl < ep:
                    stops.append((round(rl * 0.99, 2), '跌破近 3 日低點'))
            for mv, mn in [(ma5, '5日線'), (ma10, '10日線'), (ma20, '月線')]:
                if mv < ep:
                    stops.append((round(mv * 0.98, 2), f'跌破{mn}'))
            stops.append((round(ep - 2 * atr, 2), '波動度推算'))
            valid = [(s, n) for s, n in stops if ep * 0.90 <= s <= ep * 0.97]
            if valid:
                stop_loss, stop_note = max(valid, key=lambda x: x[0])
            else:
                close_stops = [(s, n) for s, n in stops if ep * 0.88 <= s < ep]
                if close_stops:
                    stop_loss, stop_note = max(close_stops, key=lambda x: x[0])
                else:
                    stop_loss, stop_note = round(ep * 0.95, 2), '固定 5% 停損'

            # ── Target ──
            tgts = []
            recent_high = max(highs[-20:])
            if recent_high > ep * 1.03:
                tgts.append((round(recent_high, 2), '挑戰近期高點'))
            rr2 = round(ep + (ep - stop_loss) * 2, 2)
            tgts.append((rr2, '風報比 1:2'))
            rr3 = round(ep + (ep - stop_loss) * 3, 2)
            tgts.append((rr3, '風報比 1:3'))
            if ma60 and ep > ma60:
                tgts.append((round(ep * 1.10, 2), '趨勢延伸 +10%'))
            if ep < price * 0.95:
                tgts.append((round(price, 2), '回到目前價位'))
            tgts.sort(key=lambda x: x[0])
            min_tgt = ep + (ep - stop_loss) * 2
            if ep < price * 0.95:
                min_tgt = max(min_tgt, price)
            good = [(t, n) for t, n in tgts if min_tgt <= t <= ep * 1.50]
            if good:
                target, target_note = good[0]
            else:
                target, target_note = (round(price, 2), '回到目前價位') if (ep < price * 0.95 and price > rr2) else (rr2, '風報比 1:2')

            risk = ep - stop_loss
            risk_reward = round((target - ep) / risk, 1) if risk > 0 else 0

            # ── Plain-language action verdict: 現在可以買嗎？──
            if price < stop_loss:
                action, action_label = 'below_stop', '🛑 跌破停損價位'
                action_desc = f'已跌破停損參考價 {stop_loss}，持有者注意風險控管'
            elif price >= target:
                action, action_label = 'hit_target', '🎉 已達目標價'
                action_desc = f'已達目標價 {target}，可考慮分批獲利了結'
            elif price >= target * 0.97:
                action, action_label = 'near_target', '🎯 接近目標價'
                action_desc = f'距離目標價 {target} 不到 3%，留意賣壓'
            elif trend == 'down':
                action, action_label = 'watch', '👀 先觀望'
                action_desc = '趨勢向下，等止穩訊號再考慮進場'
            elif ep < price * 0.97:
                action, action_label = 'wait_pullback', '⏳ 等回檔再買'
                action_desc = f'短線漲多，建議等回到 {entry_price} 附近再進場'
            elif trend == 'up':
                action, action_label = 'buy_zone', '✅ 可進場區間'
                action_desc = f'趨勢向上且價位合理，可分批進場'
            else:
                action, action_label = 'neutral', '🤔 可小量試單'
                action_desc = '盤整中，可小量佈局等待方向確認'

            # Buffett value health for this holding
            _f = pf_fund_map.get(code, {})
            _bb = buffett_score(pf_fundamentals.get(code, {}), _f.get('pe'), _f.get('pb'),
                                _f.get('yield'), pf_rev_map.get(code, {}).get('yoy'), price)
            value_score = _bb.get('score') if _bb.get('available') else None
            value_verdict = _bb.get('verdict') if _bb.get('available') else None
            value_icon = _bb.get('verdict_icon') if _bb.get('available') else None

            return {
                'code': code, 'name': name, 'market': market,
                'price': price, 'change': change, 'change_pct': change_pct,
                'trend': trend, 'trend_label': trend_label, 'trend_desc': trend_desc,
                'action': action, 'action_label': action_label, 'action_desc': action_desc,
                'entry': entry_price, 'entry_note': entry_note,
                'stop_loss': stop_loss, 'stop_note': stop_note,
                'stop_pct': round((ep - stop_loss) / ep * 100, 1),
                'target': target, 'target_note': target_note,
                'target_pct': round((target - ep) / ep * 100, 1),
                'risk_reward': risk_reward,
                'rsi': rsi, 'k': k, 'd': d,
                'ma5': round(ma5, 2), 'ma20': round(ma20, 2),
                'ma60': round(ma60, 2) if ma60 else None,
                'spark': [round(c, 2) for c in closes[-30:]],
                'value_score': value_score, 'value_verdict': value_verdict,
                'value_icon': value_icon, 'roe': _bb.get('roe'),
            }
        except Exception:
            return None

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = [r for r in pool.map(analyze, pairs) if r]
    return jsonify(results)

@app.route('/api/stock_signal')
def stock_signal():
    """Comprehensive stock analysis: technical + fundamental + institutional + margin + news"""
    import math
    code = request.args.get('code', '').strip()
    if not code:
        return jsonify({'error': 'need code'}), 400

    # Determine market
    market = 'otc' if code in POPULAR_OTC else 'tse'
    # Try to fetch — if tse fails, try otc
    def _fetch_hist_single(code, market, months=6):
        """Fetch historical OHLCV (delegates to unified fetcher: TSE + OTC + Yahoo)"""
        return fetch_daily_history(code, market, months=months)

    # Helper functions (same as entry_signals)
    def calc_rsi(closes, period=14):
        return _wilder_rsi(closes, period)

    def calc_kd(highs, lows, closes, k_period=9, k_smooth=3, d_smooth=3):
        if len(closes) < k_period + k_smooth + d_smooth:
            return None, None
        rsv_list = []
        for i in range(k_period - 1, len(closes)):
            window_h = max(highs[i - k_period + 1:i + 1])
            window_l = min(lows[i - k_period + 1:i + 1])
            if window_h == window_l:
                rsv_list.append(50)
            else:
                rsv_list.append((closes[i] - window_l) / (window_h - window_l) * 100)
        k_val = 50
        k_list = []
        for rsv in rsv_list:
            k_val = k_val * 2 / 3 + rsv / 3
            k_list.append(k_val)
        d_val = 50
        d_list = []
        for k in k_list:
            d_val = d_val * 2 / 3 + k / 3
            d_list.append(d_val)
        return round(k_list[-1], 1), round(d_list[-1], 1)

    def calc_macd(closes, fast=12, slow=26, signal=9):
        if len(closes) < slow + signal:
            return None, None, None
        def ema(data, period):
            multiplier = 2 / (period + 1)
            result = [data[0]]
            for i in range(1, len(data)):
                result.append(data[i] * multiplier + result[-1] * (1 - multiplier))
            return result
        ema_fast = ema(closes, fast)
        ema_slow = ema(closes, slow)
        dif = [ema_fast[i] - ema_slow[i] for i in range(len(closes))]
        dem = ema(dif[slow - 1:], signal)
        return round(dif[-1], 2), round(dem[-1], 2), round(dif[-1] - dem[-1], 2)

    def calc_bollinger(closes, period=20, num_std=2):
        if len(closes) < period:
            return None, None, None
        window = closes[-period:]
        ma = sum(window) / period
        std = math.sqrt(sum((x - ma) ** 2 for x in window) / period)
        return round(ma, 2), round(ma + num_std * std, 2), round(ma - num_std * std, 2)

    # Try tse first, if no data try otc
    hist = _fetch_hist_single(code, market, months=5)
    if len(hist) < 20 and market == 'tse':
        market = 'otc'
        hist = _fetch_hist_single(code, market, months=5)

    # Yahoo Finance fallback (same as /api/historical)
    if len(hist) < 20:
        for suffix in [('.TW' if market == 'tse' else '.TWO'), ('.TWO' if market == 'tse' else '.TW')]:
            try:
                url = f'https://query1.finance.yahoo.com/v8/finance/chart/{code}{suffix}?interval=1d&range=6mo'
                d = cached_get(url, ttl=3600)
                chart_result = d.get('chart', {}).get('result')
                if not chart_result:
                    continue
                result = chart_result[0]
                timestamps = result.get('timestamp', [])
                quotes = result.get('indicators', {}).get('quote', [{}])[0]
                for i, ts in enumerate(timestamps):
                    try:
                        dt = datetime.datetime.fromtimestamp(ts)
                        o = quotes.get('open', [])[i]
                        h = quotes.get('high', [])[i]
                        l = quotes.get('low', [])[i]
                        c = quotes.get('close', [])[i]
                        v = quotes.get('volume', [])[i]
                        if o and h and l and c:
                            hist.append({'date': dt.strftime('%Y-%m-%d'), 'open': round(float(o), 2),
                                         'high': round(float(h), 2), 'low': round(float(l), 2),
                                         'close': round(float(c), 2), 'volume': int(v) if v else 0})
                    except (IndexError, TypeError):
                        continue
                if len(hist) >= 20:
                    if suffix == '.TWO':
                        market = 'otc'
                    break
            except Exception:
                continue
        # Deduplicate and sort
        seen = set()
        unique = []
        for r in sorted(hist, key=lambda x: x['date']):
            if r['date'] not in seen:
                seen.add(r['date'])
                unique.append(r)
        hist = unique

    name = STOCK_NAMES.get(code) or _name_cache.get(code, code)

    if len(hist) < 20:
        return jsonify({'code': code, 'name': name, 'error': 'insufficient_data',
                        'message': f'歷史資料不足（僅 {len(hist)} 天），無法計算技術指標'})

    closes = [r['close'] for r in hist]
    highs = [r['high'] for r in hist]
    lows = [r['low'] for r in hist]
    volumes = [r['volume'] for r in hist]

    # Get realtime price
    rt_list = fetch_stocks([(code, market)])
    rt = rt_list[0] if rt_list else {}
    price = rt.get('price', closes[-1])
    change = rt.get('change', 0)
    change_pct = rt.get('change_pct', 0)
    if rt.get('name'):
        name = rt['name']

    signals = []

    # 1. RSI
    rsi = calc_rsi(closes)
    prev_rsi = calc_rsi(closes[:-1]) if len(closes) > 15 else None
    if rsi is not None:
        if rsi <= 30:
            signals.append({'type': 'RSI 超賣', 'icon': '📉', 'desc': f'RSI {rsi}，已進入超賣區，反彈機率高', 'weight': 3, 'bullish': True})
        elif rsi <= 40 and prev_rsi and prev_rsi < rsi:
            signals.append({'type': 'RSI 回升', 'icon': '📈', 'desc': f'RSI {rsi}，從低檔回升中', 'weight': 2, 'bullish': True})
        elif rsi >= 70:
            signals.append({'type': 'RSI 過熱', 'icon': '🔥', 'desc': f'RSI {rsi}，已進入過熱區，注意回檔風險', 'weight': -2, 'bullish': False})
        elif rsi >= 60 and prev_rsi and prev_rsi > rsi:
            signals.append({'type': 'RSI 轉弱', 'icon': '📉', 'desc': f'RSI {rsi}，從高檔滑落中', 'weight': -1, 'bullish': False})

    # 2. KD
    k, d = calc_kd(highs, lows, closes)
    prev_k, prev_d = calc_kd(highs[:-1], lows[:-1], closes[:-1]) if len(closes) > 15 else (None, None)
    if k is not None and d is not None:
        if k < 25 and d < 25:
            signals.append({'type': 'KD 超賣', 'icon': '🔻', 'desc': f'K={k} D={d}，KD 低檔超賣區', 'weight': 3, 'bullish': True})
        elif k > 80 and d > 80:
            signals.append({'type': 'KD 過熱', 'icon': '🔺', 'desc': f'K={k} D={d}，KD 高檔過熱區', 'weight': -2, 'bullish': False})
        if prev_k is not None and prev_d is not None:
            if prev_k <= prev_d and k > d and k < 50:
                signals.append({'type': 'KD 黃金交叉', 'icon': '✨', 'desc': f'K={k} 上穿 D={d}，低檔黃金交叉', 'weight': 4, 'bullish': True})
            elif prev_k >= prev_d and k < d and k > 50:
                signals.append({'type': 'KD 死亡交叉', 'icon': '💀', 'desc': f'K={k} 下穿 D={d}，高檔死亡交叉', 'weight': -3, 'bullish': False})

    # 3. MACD
    dif, dem, hist_val = calc_macd(closes)
    prev_dif, prev_dem, prev_hist = calc_macd(closes[:-1]) if len(closes) > 36 else (None, None, None)
    if hist_val is not None and prev_hist is not None:
        if prev_hist < 0 and hist_val >= 0:
            signals.append({'type': 'MACD 翻多', 'icon': '🔄', 'desc': f'MACD 柱翻正 ({hist_val:+.2f})，多方動能啟動', 'weight': 4, 'bullish': True})
        elif prev_hist > 0 and hist_val <= 0:
            signals.append({'type': 'MACD 翻空', 'icon': '🔄', 'desc': f'MACD 柱翻負 ({hist_val:+.2f})，空方動能啟動', 'weight': -3, 'bullish': False})
        elif hist_val < 0 and hist_val > prev_hist and dif < 0:
            signals.append({'type': 'MACD 收斂', 'icon': '🔍', 'desc': f'空方動能減弱 (DIF={dif:.2f})，可能即將翻多', 'weight': 2, 'bullish': True})
        elif hist_val > 0 and hist_val < prev_hist and dif > 0:
            signals.append({'type': 'MACD 動能減弱', 'icon': '📉', 'desc': f'多方動能減弱 (DIF={dif:.2f})，注意是否翻空', 'weight': -1, 'bullish': False})

    # 4. MA
    ma_data = {}
    if len(closes) >= 5:
        ma_data['ma5'] = round(sum(closes[-5:]) / 5, 2)
    if len(closes) >= 10:
        ma_data['ma10'] = round(sum(closes[-10:]) / 10, 2)
    if len(closes) >= 20:
        ma_data['ma20'] = round(sum(closes[-20:]) / 20, 2)
    if len(closes) >= 60:
        ma_data['ma60'] = round(sum(closes[-60:]) / 60, 2)

    ma20 = ma_data.get('ma20')
    ma60 = ma_data.get('ma60')
    if ma20 and abs(price - ma20) / ma20 < 0.02 and price >= ma20:
        signals.append({'type': 'MA20 支撐', 'icon': '🛡️', 'desc': f'股價貼近 20 日均線 ({ma20:.0f})，獲得支撐', 'weight': 3, 'bullish': True})
    elif ma20 and price < ma20 * 0.97:
        signals.append({'type': '跌破 MA20', 'icon': '⬇️', 'desc': f'股價跌破 20 日均線 ({ma20:.0f})，短線偏弱', 'weight': -2, 'bullish': False})

    if ma60 and abs(price - ma60) / ma60 < 0.02 and price >= ma60:
        signals.append({'type': 'MA60 支撐', 'icon': '🏰', 'desc': f'股價貼近季線 ({ma60:.0f})，強支撐位', 'weight': 4, 'bullish': True})
    elif ma60 and price < ma60 * 0.97:
        signals.append({'type': '跌破季線', 'icon': '⬇️', 'desc': f'股價跌破季線 ({ma60:.0f})，中期轉弱', 'weight': -3, 'bullish': False})

    if len(closes) > 20 and ma_data.get('ma5') and ma_data.get('ma10'):
        prev_ma5 = sum(closes[-6:-1]) / 5
        prev_ma10 = sum(closes[-11:-1]) / 10
        ma5 = ma_data['ma5']
        ma10 = ma_data['ma10']
        if prev_ma5 <= prev_ma10 and ma5 > ma10:
            signals.append({'type': '均線黃金交叉', 'icon': '💫', 'desc': f'MA5 ({ma5:.0f}) 上穿 MA10 ({ma10:.0f})', 'weight': 3, 'bullish': True})
        elif prev_ma5 >= prev_ma10 and ma5 < ma10:
            signals.append({'type': '均線死亡交叉', 'icon': '💀', 'desc': f'MA5 ({ma5:.0f}) 下穿 MA10 ({ma10:.0f})', 'weight': -2, 'bullish': False})

    # 5. Bollinger
    bb_mid, bb_upper, bb_lower = calc_bollinger(closes)
    if bb_lower is not None:
        if price <= bb_lower * 1.01:
            signals.append({'type': '布林帶下緣', 'icon': '📊', 'desc': f'觸及布林帶下緣 ({bb_lower:.0f})，可能反彈', 'weight': 3, 'bullish': True})
        elif price >= bb_upper * 0.99:
            # Don't flag upper band as bearish when stock is clearly oversold (contradictory)
            if rsi is not None and rsi < 35:
                pass  # Skip — oversold stock touching narrow upper band is NOT bearish
            else:
                signals.append({'type': '布林帶上緣', 'icon': '📊', 'desc': f'觸及布林帶上緣 ({bb_upper:.0f})，注意壓力', 'weight': -1, 'bullish': False})

    # 6. Volume
    if len(volumes) >= 20:
        avg_vol_5 = sum(volumes[-5:]) / 5
        avg_vol_20 = sum(volumes[-20:]) / 20
        if avg_vol_5 < avg_vol_20 * 0.6:
            price_range_5 = (max(closes[-5:]) - min(closes[-5:])) / closes[-5] * 100
            if price_range_5 < 3:
                signals.append({'type': '量縮價穩', 'icon': '🤫', 'desc': f'近5日量縮至均量 {avg_vol_5/avg_vol_20*100:.0f}%，價格穩定，可能在吸籌', 'weight': 2, 'bullish': True})
        if volumes[-1] > avg_vol_20 * 2 and closes[-1] > closes[-2]:
            signals.append({'type': '量能突破', 'icon': '💥', 'desc': f'今日量能為均量 {volumes[-1]/avg_vol_20:.1f} 倍，帶量上攻', 'weight': 3, 'bullish': True})

    # 7. Trend signals — detect healthy uptrend/downtrend stocks that don't hit extremes
    if ma_data.get('ma5') and ma_data.get('ma10') and ma_data.get('ma20'):
        ma5v, ma10v, ma20v = ma_data['ma5'], ma_data['ma10'], ma_data['ma20']
        if price > ma5v > ma10v > ma20v:
            signals.append({'type': '均線多頭排列', 'icon': '🚀', 'desc': f'股價站穩所有短中期均線之上，趨勢向上', 'weight': 3, 'bullish': True})
        elif price < ma5v < ma10v < ma20v:
            signals.append({'type': '均線空頭排列', 'icon': '📉', 'desc': f'股價跌破所有短中期均線，趨勢向下', 'weight': -3, 'bullish': False})

    if ma60 and price > ma60 * 1.05 and price > ma_data.get('ma20', 0):
        signals.append({'type': '站穩季線上方', 'icon': '🏔️', 'desc': f'股價高於季線 ({ma60:.0f}) 5% 以上，中期趨勢穩健', 'weight': 2, 'bullish': True})

    # 8. MACD trend — ongoing bullish/bearish momentum (not just crossover)
    if dif is not None and dem is not None and hist_val is not None:
        if dif > 0 and dem > 0 and dif > dem and hist_val > 0:
            # Don't double-count if MACD翻多 already triggered
            if not any(s['type'] == 'MACD 翻多' for s in signals):
                signals.append({'type': 'MACD 多方運行', 'icon': '📈', 'desc': f'DIF({dif:.1f}) > DEA({dem:.1f})，多方動能持續', 'weight': 2, 'bullish': True})
        elif dif < 0 and dem < 0 and dif < dem and hist_val < 0:
            if not any(s['type'] == 'MACD 翻空' for s in signals):
                signals.append({'type': 'MACD 空方運行', 'icon': '📉', 'desc': f'DIF({dif:.1f}) < DEA({dem:.1f})，空方動能持續', 'weight': -2, 'bullish': False})

    # ═══════════════════════════════════════════
    # SMART LEVELS: Entry / Stop / Target (巴菲特式分析)
    # 基於支撐壓力、均線、波動度、基本面來計算
    # ═══════════════════════════════════════════
    ma5_val = ma_data.get('ma5', price)
    ma10_val = ma_data.get('ma10', price)
    ma20_val = ma_data.get('ma20', price)
    ma60_val = ma_data.get('ma60')

    # --- ATR (Average True Range) for volatility ---
    atr_vals = []
    for i in range(-min(14, len(closes)-1), 0):
        tr = max(highs[i] - lows[i],
                 abs(highs[i] - closes[i-1]),
                 abs(lows[i] - closes[i-1]))
        atr_vals.append(tr)
    atr = sum(atr_vals) / len(atr_vals) if atr_vals else price * 0.03

    # --- ENTRY (建議進場) ---
    # If overbought: suggest waiting for pullback to nearest MA
    # If near support: suggest current price
    # If oversold: current price is good
    entry_price = price
    entry_note = '現價進場'
    if rsi and rsi > 75:
        # Overbought — suggest waiting for pullback
        if ma5_val < price * 0.97:
            entry_price = round(ma5_val, 2)
            entry_note = '建議回測MA5再進場'
        elif ma10_val < price * 0.95:
            entry_price = round(ma10_val, 2)
            entry_note = '建議回測MA10再進場'
        else:
            entry_price = round(price * 0.97, 2)
            entry_note = '短線過熱，建議回檔3%再進'
    elif rsi and rsi < 30:
        entry_note = '超賣區，可積極進場'
    elif ma20_val and abs(price - ma20_val) / ma20_val < 0.02:
        entry_note = '貼近MA20支撐，適合進場'

    # --- STOP LOSS (停損) based on support levels below ENTRY ---
    # All calculations relative to entry_price, not current price
    ep = entry_price  # shorthand
    stop_candidates = []
    if len(lows) >= 3:
        prev_low = min(lows[-3:])
        if prev_low < ep:
            stop_candidates.append((round(prev_low * 0.99, 2), '近3日低點下方'))
    for mv, mn in [(ma5_val, 'MA5'), (ma10_val, 'MA10'), (ma20_val, 'MA20')]:
        if mv < ep:
            stop_candidates.append((round(mv * 0.98, 2), f'跌破{mn}'))
    if bb_lower and bb_lower < ep:
        stop_candidates.append((round(bb_lower * 0.99, 2), '跌破布林下緣'))
    atr_stop = round(ep - 2 * atr, 2)
    stop_candidates.append((atr_stop, f'2倍ATR({atr:.1f})'))

    # Filter: 3%~10% below entry price
    valid = [(s, n) for s, n in stop_candidates if ep * 0.90 <= s <= ep * 0.97]
    if valid:
        stop_loss, stop_note = max(valid, key=lambda x: x[0])
    else:
        close_stops = [(s, n) for s, n in stop_candidates if s >= ep * 0.88 and s < ep]
        if close_stops:
            stop_loss, stop_note = max(close_stops, key=lambda x: x[0])
        else:
            stop_loss = round(ep * 0.95, 2)
            stop_note = '預設5%停損'

    # --- TARGET (目標價) based on resistance above ENTRY ---
    target_candidates = []
    recent_high = max(highs[-20:]) if len(highs) >= 20 else max(highs[-5:])
    if recent_high > ep * 1.03:
        target_candidates.append((round(recent_high, 2), '近期高點'))
    if bb_upper and bb_upper > ep * 1.02:
        target_candidates.append((round(bb_upper, 2), '布林帶上緣'))
    rr_target = round(ep + (ep - stop_loss) * 2, 2)
    target_candidates.append((rr_target, '風報比1:2'))
    rr3_target = round(ep + (ep - stop_loss) * 3, 2)
    target_candidates.append((rr3_target, '風報比1:3'))
    if ma60_val and ep > ma60_val:
        target_candidates.append((round(ep * 1.10, 2), '趨勢延伸+10%'))
    # When entry adjusted down (overbought), add current price as recovery target
    if ep < price * 0.95:
        target_candidates.append((round(price, 2), '回測前高水準'))

    target_candidates.sort(key=lambda x: x[0])
    min_target = ep + (ep - stop_loss) * 2
    # When entry is adjusted down, minimum target should be at least the current price
    if ep < price * 0.95:
        min_target = max(min_target, price)
    good_targets = [(t, n) for t, n in target_candidates if t >= min_target and t <= ep * 1.50]
    if good_targets:
        target, target_note = good_targets[0]
    else:
        # Fallback: use RR 1:2 or current price, whichever is higher
        if ep < price * 0.95 and price > rr_target:
            target = round(price, 2)
            target_note = '回測前高水準'
        else:
            target = rr_target
            target_note = '風報比1:2'

    risk = ep - stop_loss
    risk_reward = round((target - ep) / risk, 1) if risk > 0 else 0
    stop_pct = round((ep - stop_loss) / ep * 100, 1)
    target_pct = round((target - ep) / ep * 100, 1)

    # ═══════════════════════════════════════════
    # PART 2: Fundamental analysis (基本面)
    # ═══════════════════════════════════════════
    fund_signals = []
    fund_map = _fetch_pe_pb_yield()
    rev_map = _fetch_revenue_growth()
    fund = fund_map.get(code, {})
    rev = rev_map.get(code, {})
    pe = fund.get('pe')
    pb = fund.get('pb')
    dy = fund.get('yield')
    yoy = rev.get('yoy')
    mom = rev.get('mom')

    if pe is not None:
        if pe < 0:
            fund_signals.append({'type': '本益比為負', 'icon': '⚠️', 'desc': f'PE {pe:.1f}，公司處於虧損', 'weight': -3, 'bullish': False, 'cat': 'fundamental'})
        elif pe <= 15:
            fund_signals.append({'type': 'PE 低估', 'icon': '💰', 'desc': f'本益比 {pe:.1f}，估值偏低有吸引力', 'weight': 3, 'bullish': True, 'cat': 'fundamental'})
        elif pe <= 25:
            fund_signals.append({'type': 'PE 合理', 'icon': '📊', 'desc': f'本益比 {pe:.1f}，估值合理', 'weight': 1, 'bullish': True, 'cat': 'fundamental'})
        elif pe > 50:
            fund_signals.append({'type': 'PE 過高', 'icon': '⚠️', 'desc': f'本益比 {pe:.1f}，估值偏高需留意', 'weight': -2, 'bullish': False, 'cat': 'fundamental'})
        elif pe > 30:
            fund_signals.append({'type': 'PE 偏高', 'icon': '📊', 'desc': f'本益比 {pe:.1f}，估值略高', 'weight': -1, 'bullish': False, 'cat': 'fundamental'})

    if dy is not None and dy >= 4:
        fund_signals.append({'type': '高殖利率', 'icon': '🏦', 'desc': f'殖利率 {dy:.1f}%，配息豐厚', 'weight': 2, 'bullish': True, 'cat': 'fundamental'})

    if yoy is not None:
        if yoy >= 20:
            fund_signals.append({'type': '營收高成長', 'icon': '🚀', 'desc': f'營收年增 {yoy:+.1f}%，成長強勁', 'weight': 3, 'bullish': True, 'cat': 'fundamental'})
        elif yoy >= 5:
            fund_signals.append({'type': '營收穩健', 'icon': '📈', 'desc': f'營收年增 {yoy:+.1f}%', 'weight': 1, 'bullish': True, 'cat': 'fundamental'})
        elif yoy <= -20:
            fund_signals.append({'type': '營收衰退', 'icon': '📉', 'desc': f'營收年減 {yoy:.1f}%，衰退幅度大', 'weight': -3, 'bullish': False, 'cat': 'fundamental'})
        elif yoy <= -5:
            fund_signals.append({'type': '營收下滑', 'icon': '📉', 'desc': f'營收年減 {yoy:.1f}%', 'weight': -1, 'bullish': False, 'cat': 'fundamental'})

    # ── 🎩 Buffett value-investing view (財報品質 + 估值 + 安全邊際) ──
    _fund_metrics = _fetch_fundamentals().get(code, {})
    buffett = buffett_score(_fund_metrics, pe, pb, dy, yoy, price)
    # 存股 (income / dividend) track record
    dividend_quality = _dividend_quality(code, market, price, _fund_metrics.get('eps_annual'))

    # ═══════════════════════════════════════════
    # PART 3: Institutional / Chip analysis (籌碼面)
    # ═══════════════════════════════════════════
    chip_signals = []
    inst = None  # derived from the latest chip day below (avoids a 2nd full-market T86 download)
    chip_data = None
    try:
        # Fetch chip analysis data (consecutive buying) — 6 days fetched in
        # parallel (each T86 call is large), then processed newest-first.
        today = datetime.date.today()
        days = [d for d in (today - datetime.timedelta(days=dd) for dd in range(6)) if d.weekday() < 5]

        def _fetch_t86(d):
            try:
                url = f'https://www.twse.com.tw/fund/T86?response=json&date={d.strftime("%Y%m%d")}&selectType=ALL'
                return d, cached_get(url, ttl=3600)
            except Exception:
                return d, None

        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=6) as pool:
            t86_results = list(pool.map(_fetch_t86, days))

        chip_daily = []
        for chip_day, t86_data in t86_results:  # already newest-first
            if not isinstance(t86_data, dict):
                continue
            for row in t86_data.get('data', []):
                if row[0].strip() == code:
                    try:
                        foreign = int(row[4].replace(',', ''))
                        trust = int(row[10].replace(',', ''))
                        total = int(row[18].replace(',', ''))
                        chip_daily.append({'date': chip_day.strftime('%m/%d'), 'foreign': foreign // 1000,
                                           'trust': trust // 1000, 'total': total // 1000})
                        # Latest day → institutional snapshot (raw shares)
                        if inst is None:
                            inst = {'name': name, 'foreign': foreign, 'trust': trust, 'total': total}
                    except (ValueError, IndexError):
                        pass
                    break
        # Count consecutive buy days
        consec_buy = 0
        for cd in chip_daily:
            if cd['total'] > 0:
                consec_buy += 1
            else:
                break
        chip_data = {'daily': chip_daily[:5], 'consecutive_buy': consec_buy}
    except Exception:
        pass

    if inst:
        total_net = inst.get('total', 0) // 1000  # Convert to 張
        foreign_net = inst.get('foreign', 0) // 1000
        trust_net = inst.get('trust', 0) // 1000
        if total_net > 5000:
            chip_signals.append({'type': '法人大買', 'icon': '🏛️', 'desc': f'三大法人買超 {total_net:,} 張', 'weight': 3, 'bullish': True, 'cat': 'chip'})
        elif total_net > 1000:
            chip_signals.append({'type': '法人買超', 'icon': '🏛️', 'desc': f'三大法人買超 {total_net:,} 張', 'weight': 2, 'bullish': True, 'cat': 'chip'})
        elif total_net < -5000:
            chip_signals.append({'type': '法人大賣', 'icon': '🏛️', 'desc': f'三大法人賣超 {abs(total_net):,} 張', 'weight': -3, 'bullish': False, 'cat': 'chip'})
        elif total_net < -1000:
            chip_signals.append({'type': '法人賣超', 'icon': '🏛️', 'desc': f'三大法人賣超 {abs(total_net):,} 張', 'weight': -2, 'bullish': False, 'cat': 'chip'})

        if foreign_net > 0 and trust_net > 0:
            chip_signals.append({'type': '外資投信同買', 'icon': '🤝', 'desc': f'外資+{foreign_net:,}張 投信+{trust_net:,}張 同步看多', 'weight': 2, 'bullish': True, 'cat': 'chip'})

    if chip_data and chip_data['consecutive_buy'] >= 3:
        cb = chip_data['consecutive_buy']
        chip_signals.append({'type': f'連{cb}日買超', 'icon': '🔥', 'desc': f'法人連續 {cb} 個交易日買超，籌碼集中', 'weight': min(cb, 4), 'bullish': True, 'cat': 'chip'})

    # ═══════════════════════════════════════════
    # PART 4: Margin / Retail sentiment (散戶面)
    # ═══════════════════════════════════════════
    margin_signals = []
    margin_data = None
    try:
        margin_rows = []
        for days_back in range(5):
            md = datetime.date.today() - datetime.timedelta(days=days_back)
            if md.weekday() >= 5:
                continue
            margin_url = f'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date={md.strftime("%Y%m%d")}&selectType=STOCK'
            mdata = cached_get(margin_url, ttl=3600)
            margin_tables = mdata.get('tables', [])
            margin_rows = margin_tables[1].get('data', []) if len(margin_tables) >= 2 else []
            if margin_rows:
                break
        for row in margin_rows:
            if row[0].strip() == code:
                margin_buy = int(row[2].replace(',', ''))
                margin_sell = int(row[3].replace(',', ''))
                margin_bal = int(row[6].replace(',', ''))  # 今日餘額 is col 6
                prev_bal = int(row[5].replace(',', ''))     # 前日餘額
                margin_chg = margin_bal - prev_bal           # Accurate daily change
                margin_data = {'balance': margin_bal, 'change': margin_chg}
                if margin_chg > 3000:
                    margin_signals.append({'type': '融資大增', 'icon': '⚠️', 'desc': f'融資增 {margin_chg:,} 張，散戶積極追買', 'weight': -2, 'bullish': False, 'cat': 'sentiment'})
                elif margin_chg > 1000:
                    margin_signals.append({'type': '融資增加', 'icon': '📊', 'desc': f'融資增 {margin_chg:,} 張，散戶偏多', 'weight': -1, 'bullish': False, 'cat': 'sentiment'})
                elif margin_chg < -2000:
                    margin_signals.append({'type': '融資大減', 'icon': '💡', 'desc': f'融資減 {abs(margin_chg):,} 張，散戶出場，籌碼沉澱', 'weight': 2, 'bullish': True, 'cat': 'sentiment'})
                break
    except Exception:
        pass

    # ═══════════════════════════════════════════
    # PART 5: News (新聞面)
    # ═══════════════════════════════════════════
    news = []
    try:
        stock_name = name or code
        raw = []
        for q in [f'{stock_name} 台股', f'{code} 股票']:
            raw.extend(fetch_google_news(q, limit=5))
            if raw:
                break
        seen_titles = set()
        for n in raw:
            if n['title'] in seen_titles:
                continue
            seen_titles.add(n['title'])
            news.append({'title': n['title'], 'source': n.get('source', ''),
                         'date': n.get('date', '')[:16]})
        news = news[:4]
    except Exception:
        pass

    # ═══════════════════════════════════════════
    # OVERALL: Combine all dimensions
    # ═══════════════════════════════════════════
    all_signals = signals + fund_signals + chip_signals + margin_signals

    bullish_w = sum(s['weight'] for s in all_signals if s.get('bullish', True) and s.get('weight', 0) > 0)
    bearish_w = abs(sum(s['weight'] for s in all_signals if not s.get('bullish', True) and s.get('weight', 0) < 0))
    total_score = bullish_w - bearish_w

    # Dimension scores
    tech_score = sum(s['weight'] for s in signals)
    fund_score = sum(s['weight'] for s in fund_signals)
    chip_score = sum(s['weight'] for s in chip_signals)
    sent_score = sum(s['weight'] for s in margin_signals)

    if total_score >= 10:
        verdict = '強力進場'
        verdict_icon = '🟢'
        verdict_desc = '多維度指標共振，技術+基本+籌碼面皆看多'
    elif total_score >= 5:
        verdict = '建議進場'
        verdict_icon = '🟢'
        verdict_desc = '整體偏多，可分批佈局'
    elif total_score >= 0:
        verdict = '觀望為主'
        verdict_icon = '🟡'
        verdict_desc = '訊號不明確，建議等待更多確認'
    elif total_score >= -5:
        verdict = '暫不進場'
        verdict_icon = '🟠'
        verdict_desc = '整體偏弱，不建議現在進場'
    else:
        verdict = '建議迴避'
        verdict_icon = '🔴'
        verdict_desc = '多維度指標轉空，風險偏高'

    return jsonify({
        'code': code, 'name': name, 'market': market,
        'price': price, 'change': change, 'change_pct': change_pct,
        # Technical signals
        'signals': signals,
        'signal_count': len(all_signals),
        'bullish_weight': bullish_w,
        'bearish_weight': bearish_w,
        'total_score': total_score,
        'verdict': verdict, 'verdict_icon': verdict_icon, 'verdict_desc': verdict_desc,
        'entry': entry_price, 'entry_note': entry_note,
        'stop_loss': stop_loss, 'stop_note': stop_note, 'stop_pct': stop_pct,
        'target': target, 'target_note': target_note, 'target_pct': target_pct,
        'risk_reward': risk_reward, 'atr': round(atr, 2),
        'rsi': rsi, 'k': k, 'd': d,
        'dif': dif, 'dem': dem, 'macd_hist': hist_val,
        'ma': ma_data,
        'bollinger': {'mid': bb_mid, 'upper': bb_upper, 'lower': bb_lower} if bb_mid else None,
        'data_points': len(hist),
        'latest_date': hist[-1]['date'] if hist else '',
        # Dimension scores
        'tech_score': tech_score,
        'fund_score': fund_score,
        'chip_score': chip_score,
        'sent_score': sent_score,
        # Fundamental
        'fundamental': fund_signals,
        'pe': pe, 'pb': pb, 'dividend_yield': dy,
        'rev_yoy': yoy, 'rev_mom': mom,
        # Institutional / Chip
        'chip': chip_signals,
        'chip_data': chip_data,
        'institutional': {'foreign': inst.get('foreign', 0) // 1000 if inst else None,
                          'trust': inst.get('trust', 0) // 1000 if inst else None,
                          'total': inst.get('total', 0) // 1000 if inst else None} if inst else None,
        # Margin
        'margin_signals': margin_signals,
        'margin': margin_data,
        # News
        'news': news,
        # 🎩 Buffett value-investing analysis
        'buffett': buffett,
        # 💰 存股 / dividend track record
        'dividend_quality': dividend_quality,
    })

@app.route('/api/network_info')
def network_info():
    import socket
    ip = '127.0.0.1'
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass
    tunnel_url = ''
    try:
        with open(TUNNEL_URL_FILE, 'r') as f:
            tunnel_url = f.read().strip()
    except Exception:
        pass
    return jsonify({'ip': ip, 'port': 5566, 'local_url': f'http://{ip}:5566', 'tunnel_url': tunnel_url})

if __name__ == '__main__':
    import webbrowser, socket
    local_ip = '127.0.0.1'
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass

    def start_tunnel():
        base_dir = os.path.dirname(os.path.abspath(__file__))
        ngrok_path = os.path.join(base_dir, 'ngrok')
        bore_path = os.path.join(base_dir, 'bore')
        if os.path.exists(ngrok_path):
            try:
                domain_file = os.path.join(base_dir, 'ngrok_domain.txt')
                cmd = [ngrok_path, 'http', '5566', '--log=stdout', '--log-format=logfmt']
                if os.path.exists(domain_file):
                    with open(domain_file) as df:
                        domain = df.read().strip()
                    if domain:
                        cmd = [ngrok_path, 'http', '--url', domain, '5566', '--log=stdout', '--log-format=logfmt']
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                time.sleep(6)
                try:
                    import urllib.request
                    resp = urllib.request.urlopen('http://127.0.0.1:4040/api/tunnels', timeout=5)
                    data = json.loads(resp.read())
                    tunnel_url = data['tunnels'][0]['public_url']
                    with open(TUNNEL_URL_FILE, 'w') as f:
                        f.write(tunnel_url)
                    print(f"   \U0001f310 外網：{tunnel_url}  ← 不用 WiFi 也能看")
                except Exception:
                    pass
                proc.wait()
            except Exception as e:
                print(f"   ⚠️  ngrok: {e}")
        elif os.path.exists(bore_path):
            try:
                proc = subprocess.Popen(
                    [bore_path, 'local', '5566', '--to', 'bore.pub'],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
                )
                for line in proc.stdout:
                    m = re.search(r'bore\.pub:(\d+)', line)
                    if m:
                        tunnel_url = f'http://bore.pub:{m.group(1)}'
                        with open(TUNNEL_URL_FILE, 'w') as f:
                            f.write(tunnel_url)
                        print(f"   \U0001f310 外網：{tunnel_url}")
                        break
                proc.wait()
            except Exception as e:
                print(f"   ⚠️  bore: {e}")
        else:
            print("   ⚠️  找不到隧道工具，跳過外網連線")

    def open_browser():
        time.sleep(1.5)
        webbrowser.open('http://localhost:5566')

    threading.Thread(target=open_browser, daemon=True).start()
    threading.Thread(target=start_tunnel, daemon=True).start()
    print(f"\U0001f402 台股小牛助理 Premium 啟動中...")
    print(f"   本機：http://localhost:5566")
    print(f"   區網：http://{local_ip}:5566")
    print(f"   外網：連線建立中...")
    port = int(os.environ.get('PORT', 5566))
    app.run(host='0.0.0.0', port=port, debug=False)
