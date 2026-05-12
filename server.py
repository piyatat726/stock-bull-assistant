#!/usr/bin/env python3
import json, datetime, time, threading, requests, os, subprocess, re
from flask import Flask, jsonify, send_from_directory, request

app = Flask(__name__, static_folder='static')

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

def cached_get(url, ttl=CACHE_TTL):
    now = time.time()
    if url in cache and now - cache[url]['t'] < ttl:
        return cache[url]['data']
    try:
        r = requests.get(url, headers=HEADERS, timeout=10)
        data = r.json()
        cache[url] = {'data': data, 't': now}
        return data
    except Exception:
        return cache.get(url, {}).get('data', {})

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
        current = float(z_val) if z_val and z_val != '-' else yesterday
        if current == 0 and yesterday == 0:
            return None
        change = current - yesterday
        change_pct = (change / yesterday * 100) if yesterday else 0
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
        return {
            'code': item.get('c', ''), 'name': item.get('n', ''),
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

def fetch_stock_yahoo(code, market='tse'):
    """Yahoo Finance fallback for when TWSE API is blocked (e.g. cloud deploy outside Taiwan)"""
    suffix = '.TW' if market == 'tse' else '.TWO'
    sym = f'{code}{suffix}'
    try:
        url = f'https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=5d'
        data = cached_get(url, ttl=30)
        result = data.get('chart', {}).get('result', [{}])[0]
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
        name = meta.get('shortName', meta.get('symbol', code))
        name = name.replace('.TW', '').replace('.TWO', '').strip()
        return {
            'code': code, 'name': name,
            'price': price, 'yesterday': prev,
            'change': change, 'change_pct': change_pct,
            'open': str(round(op, 2)), 'high': str(round(hi, 2)), 'low': str(round(lo, 2)),
            'volume': str(int(vol / 1000)) if vol else '-',
            'time': '', 'market': market,
            'limit_up': '-', 'limit_down': '-',
            'best_bid': '-', 'best_ask': '-',
        }
    except Exception:
        return None

def fetch_stocks(code_market_pairs):
    if not code_market_pairs:
        return []
    # Try TWSE API first
    ex_ch = '|'.join([f'{m}_{c}.tw' for c, m in code_market_pairs])
    data = cached_get(f'{API_BASE}?ex_ch={ex_ch}')
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
    return results

@app.route('/')
def index():
    return send_from_directory('static', 'index.html')

@app.route('/api/watchlist', methods=['GET'])
def get_watchlist():
    return jsonify(load_watchlist())

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
    for market in ['tse', 'otc']:
        results = fetch_stocks([(query, market)])
        if results and results[0].get('name'):
            return jsonify(results)
    return jsonify([])

@app.route('/api/historical')
def historical():
    code = request.args.get('code', '').strip()
    market = request.args.get('market', 'tse')
    months = int(request.args.get('months', '3'))
    if not code:
        return jsonify([])

    all_data = []
    today = datetime.date.today()

    for m in range(months):
        d = today.replace(day=1) - datetime.timedelta(days=m * 28)
        try:
            if market == 'tse':
                date_str = d.strftime('%Y%m01')
                url = f'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={date_str}&stockNo={code}'
                data = cached_get(url, ttl=3600)
                for row in data.get('data', []):
                    parts = row[0].split('/')
                    y = int(parts[0]) + 1911
                    all_data.append({
                        'date': f'{y}-{parts[1]}-{parts[2]}',
                        'open': float(row[3].replace(',', '')),
                        'high': float(row[4].replace(',', '')),
                        'low': float(row[5].replace(',', '')),
                        'close': float(row[6].replace(',', '')),
                        'volume': int(row[1].replace(',', '')),
                    })
            else:
                roc_year = d.year - 1911
                roc_date = f'{roc_year}/{d.month:02d}'
                url = f'https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d={roc_date}&stkno={code}'
                data = cached_get(url, ttl=3600)
                for row in data.get('aaData', []):
                    parts = row[0].split('/')
                    y = int(parts[0]) + 1911
                    all_data.append({
                        'date': f'{y}-{parts[1]}-{parts[2]}',
                        'open': float(str(row[3]).replace(',', '')),
                        'high': float(str(row[4]).replace(',', '')),
                        'low': float(str(row[5]).replace(',', '')),
                        'close': float(str(row[6]).replace(',', '')),
                        'volume': int(str(row[1]).replace(',', '')),
                    })
        except Exception:
            continue

    # Yahoo Finance fallback for historical data
    if not all_data:
        try:
            suffix = '.TW' if market == 'tse' else '.TWO'
            period = f'{months}mo' if months <= 6 else '1y'
            url = f'https://query1.finance.yahoo.com/v8/finance/chart/{code}{suffix}?interval=1d&range={period}'
            d = cached_get(url, ttl=3600)
            result = d.get('chart', {}).get('result', [{}])[0]
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
                        all_data.append({
                            'date': dt.strftime('%Y-%m-%d'),
                            'open': round(float(o), 2), 'high': round(float(h), 2),
                            'low': round(float(l), 2), 'close': round(float(c), 2),
                            'volume': int(v) if v else 0,
                        })
                except (IndexError, TypeError):
                    continue
        except Exception:
            pass

    all_data.sort(key=lambda x: x['date'])
    seen = set()
    unique = []
    for d in all_data:
        if d['date'] not in seen:
            seen.add(d['date'])
            unique.append(d)
    return jsonify(unique)

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
                        'trust_net': int(row[7].replace(',', '')),
                        'dealer_net': int(row[8].replace(',', '')),
                        'total_net': int(row[11].replace(',', '')),
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
                    'name': row[2].strip(), 'type': row[3].strip(),
                    'watched': row[1].strip() in wl_codes,
                })
            except (IndexError, AttributeError):
                continue
        return jsonify(results)
    except Exception:
        return jsonify([])

@app.route('/api/volume_rank')
def volume_rank():
    pairs = [(c, 'tse') for c in POPULAR_TSE] + [(c, 'otc') for c in POPULAR_OTC]
    results = fetch_stocks(pairs)
    ranked = sorted([r for r in results if r['volume'] != '-'], key=lambda x: int(x['volume']), reverse=True)[:10]
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
            today = datetime.date.today()
            d = today.replace(day=1)
            if market == 'tse':
                date_str = d.strftime('%Y%m01')
                url = f'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={date_str}&stockNo={code}'
            else:
                roc_year = d.year - 1911
                roc_date = f'{roc_year}/{d.month:02d}'
                url = f'https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d={roc_date}&stkno={code}'

            data = cached_get(url, ttl=3600)
            closes = []
            rows = data.get('data', []) if market == 'tse' else data.get('aaData', [])
            for row in rows:
                try:
                    c = float(str(row[6]).replace(',', '')) if market == 'tse' else float(str(row[6]).replace(',', ''))
                    closes.append(c)
                except (ValueError, IndexError):
                    continue

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
            vol = int(s['volume']) if s['volume'] != '-' else 0
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

STOCK_NAMES = {
    '台積電':'2330','鴻海':'2317','聯發科':'2454','台達電':'2308',
    '國泰金':'2882','富邦金':'2881','中信金':'2891','日月光':'3711',
    '聯電':'2303','中鋼':'2002','台塑':'1301','南亞':'1303',
    '中華電':'2412','大立光':'3008','兆豐金':'2886','台泥':'1101',
    '智邦':'2345','聯詠':'3034','瑞昱':'2379','欣興':'3037',
    '長榮':'2603','萬海':'2615','陽明':'2609','統一':'1216',
    '和碩':'4938','廣達':'2382','緯創':'3231','仁寶':'2324',
    '華碩':'2357','宏碁':'2353','微星':'2377','技嘉':'2376',
    '第一金':'2892','華南金':'2880','玉山金':'2884','元大金':'2885',
    '合庫金':'5880','永豐金':'2890','聯鈞':'3450','中碳':'1723',
    '華景電':'6788','力積電':'6770','世芯':'3661','創意':'3443',
    '穩懋':'3105','環球晶':'6488','群創':'3481','友達':'2409',
    '光寶科':'2301','鈊象':'3293','矽力':'6415','信驊':'5274',
    '台光電':'2383','南電':'8046','景碩':'3189','遠傳':'4904',
    '群聯':'8299','祥碩':'5269','譜瑞':'4966','聯茂':'6213',
    '金像電':'2368','台燿':'6274','健策':'3653','嘉澤':'3533',
}
POSITIVE_KW = ['漲','漲停','大漲','飆','走高','創新高','突破','看好','看多',
    '利多','喊買','目標價','上調','加碼','買超','爆量','強勢','營收增',
    '成長','獲利','訂單','需求','旺季','擴產','AI','法說會','上修']
NEGATIVE_KW = ['跌','下跌','利空','看空','砍','下修','衰退','虧損','減產']

@app.route('/api/news_picks')
def news_picks():
    import xml.etree.ElementTree as ET
    all_news = []
    for q in ['台股 漲 股票','台股 看好','外資 買超 股票','台股 利多','半導體 股票 漲']:
        try:
            url = f'https://news.google.com/rss/search?q={q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant'
            r = requests.get(url, headers=HEADERS, timeout=8)
            root = ET.fromstring(r.content)
            for item in root.findall('.//item')[:12]:
                t = item.find('title')
                l = item.find('link')
                p = item.find('pubDate')
                s = item.find('source')
                if t is not None and t.text:
                    all_news.append({
                        'title': t.text,
                        'link': l.text if l is not None else '',
                        'date': p.text if p is not None else '',
                        'source': s.text if s is not None else '',
                    })
        except Exception:
            continue

    seen_titles = set()
    unique_news = []
    for n in all_news:
        if n['title'] not in seen_titles:
            seen_titles.add(n['title'])
            unique_news.append(n)

    picks = {}
    for n in unique_news:
        title = n['title']
        pos = sum(1 for kw in POSITIVE_KW if kw in title)
        neg = sum(1 for kw in NEGATIVE_KW if kw in title)
        if pos <= neg:
            continue
        for name, code in STOCK_NAMES.items():
            if name in title:
                if code not in picks:
                    picks[code] = {'code': code, 'name': name, 'news': [], 'score': 0}
                picks[code]['score'] += pos
                if len(picks[code]['news']) < 2:
                    picks[code]['news'].append({
                        'title': title, 'source': n['source'],
                        'date': n['date'], 'link': n['link'],
                    })

    if not picks:
        return jsonify([])

    codes = list(picks.keys())
    otc_codes = set(POPULAR_OTC)
    pairs = [(c, 'otc' if c in otc_codes else 'tse') for c in codes]
    stocks = fetch_stocks(pairs)
    smap = {s['code']: s for s in stocks}

    results = []
    for code, pk in picks.items():
        s = smap.get(code, {})
        if not s:
            continue
        results.append({
            'code': code, 'name': pk['name'],
            'price': s.get('price', 0),
            'change': s.get('change', 0),
            'change_pct': s.get('change_pct', 0),
            'volume': s.get('volume', '-'),
            'market': s.get('market', 'tse'),
            'score': pk['score'],
            'news': pk['news'],
        })

    results.sort(key=lambda x: x['score'], reverse=True)
    return jsonify(results[:8])

@app.route('/api/news')
def news():
    query = request.args.get('q', '台股').strip()
    import xml.etree.ElementTree as ET
    results = []
    try:
        url = f'https://news.google.com/rss/search?q={query}+股票&hl=zh-TW&gl=TW&ceid=TW:zh-Hant'
        r = requests.get(url, headers=HEADERS, timeout=8)
        root = ET.fromstring(r.content)
        for item in root.findall('.//item')[:30]:
            title = item.find('title')
            link = item.find('link')
            pub = item.find('pubDate')
            src = item.find('source')
            if title is not None and title.text:
                results.append({
                    'title': title.text,
                    'link': link.text if link is not None else '',
                    'date': pub.text if pub is not None else '',
                    'source': src.text if src is not None else '',
                })
    except Exception:
        pass
    if not results:
        try:
            url2 = f'https://api.cnyes.com/media/api/v1/newslist/category/tw_stock?limit=30'
            data = cached_get(url2, ttl=300)
            for item in data.get('items', {}).get('data', [])[:30]:
                results.append({
                    'title': item.get('title', ''),
                    'link': f'https://news.cnyes.com/news/id/{item.get("newsId","")}',
                    'date': datetime.datetime.fromtimestamp(item.get('publishAt', 0)).strftime('%Y-%m-%d %H:%M') if item.get('publishAt') else '',
                    'source': '鉅亨網',
                })
        except Exception:
            pass
    return jsonify(results)

@app.route('/api/recommend')
def recommend():
    inst_map = {}
    today = datetime.date.today()
    for days_back in range(7):
        d = today - datetime.timedelta(days=days_back)
        if d.weekday() >= 5:
            continue
        date_str = d.strftime('%Y%m%d')
        try:
            url = f'https://www.twse.com.tw/fund/T86?response=json&date={date_str}&selectType=ALLBUT0999'
            data = cached_get(url, ttl=1800)
            if data.get('stat') == 'OK' and data.get('data'):
                for row in data['data']:
                    try:
                        code = row[0].strip()
                        inst_map[code] = {
                            'foreign': int(row[4].replace(',', '')),
                            'trust': int(row[7].replace(',', '')),
                            'total': int(row[11].replace(',', '')),
                        }
                    except (ValueError, IndexError):
                        continue
                break
        except Exception:
            continue

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
        score = 0
        reasons = []
        code = s['code']
        inst = inst_map.get(code)

        if inst and inst['total'] > 0:
            lots = inst['total'] // 1000
            if lots > 1000:
                score += 5
                reasons.append(f'法人狂買 {lots:,}張')
            elif lots > 500:
                score += 4
                reasons.append(f'法人大買 {lots:,}張')
            elif lots > 100:
                score += 3
                reasons.append(f'法人買超 {lots:,}張')
            elif lots > 0:
                score += 1
            if inst.get('foreign', 0) > 0 and inst.get('trust', 0) > 0:
                score += 2
                reasons.append('外資投信聯手')

        if s['change_pct'] > 5:
            score += 4
            reasons.append(f'漲停板 +{s["change_pct"]}%')
        elif s['change_pct'] > 3:
            score += 3
            reasons.append(f'大幅上漲 +{s["change_pct"]}%')
        elif s['change_pct'] > 1:
            score += 2
            reasons.append(f'穩健上漲 +{s["change_pct"]}%')
        elif s['change_pct'] > 0:
            score += 1

        vol = int(s['volume']) if s['volume'] != '-' else 0
        if vol > 50000:
            score += 3
            reasons.append('爆量交易')
        elif vol > 20000:
            score += 2
            reasons.append('量能放大')
        elif vol > 5000:
            score += 1

        if score >= 5 and reasons:
            if inst and inst['total'] > 500000:
                cat = '法人加持'
            elif s['change_pct'] > 2:
                cat = '強勢突破'
            else:
                cat = '值得關注'
            scored.append({
                'code': code, 'name': s['name'],
                'price': s['price'], 'change': s['change'],
                'change_pct': s['change_pct'], 'volume': s['volume'],
                'market': s['market'], 'score': score,
                'category': cat, 'reasons': reasons,
            })

    scored.sort(key=lambda x: x['score'], reverse=True)
    return jsonify(scored[:10])

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
    app.run(host='0.0.0.0', port=5566, debug=False)
