// api/stock-data.js — market data proxy for stock price / sparkline / PE data.
//
// Price source tiers:
//   1) Yahoo Finance chart (primary; plain, then with a guest session cookie)
//   2) Twelve Data (fallback when Yahoo blocks the request) — set TWELVEDATA_API_KEY
//   3) Alpha Vantage — set ALPHAVANTAGE_API_KEY (optional last resort)
//
// Forward/trailing P/E: best-effort from Yahoo quoteSummary (analyst-estimate data
// isn't on any free official tier). The frontend computes trailing P/E itself from
// price x shares / net income, and falls back to a Claude-estimated forward P/E.
//
// All responses are reshaped to Yahoo's chart JSON so the frontend never changes.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ticker = (req.query.ticker || '').trim().toUpperCase();
  const range = req.query.range || '1y';

  if (!ticker) { res.status(400).json({ error: 'Missing ticker' }); return; }

  const validRanges = ['1d', '5d', '1mo', '3mo', '6mo', 'ytd', '1y', '2y', '5y', '10y', 'max'];
  const r = validRanges.includes(range) ? range : '1y';

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept': 'application/json,*/*'
  };
  try {
    // Kick off the Yahoo guest session early — used for PE and the Yahoo price retry.
    const sessionPromise = getYahooSession(headers);

    // Tier 1: Yahoo (primary — best data quality), plain then with a session cookie.
    const intervalMap = { '1d': '5m', '5d': '15m', '1mo': '1d', '3mo': '1d', '6mo': '1d', 'ytd': '1d', '1y': '1d', '2y': '1wk', '5y': '1wk', '10y': '1mo', 'max': '1mo' };
    let data = await fetchYahooChart(ticker, r, intervalMap[r] || '1d', headers, null);
    if (!data) {
      const session = await sessionPromise;
      if (session) data = await fetchYahooChart(ticker, r, intervalMap[r] || '1d', headers, session.cookie);
    }
    let source = data ? 'yahoo' : null;

    // Tier 2: Twelve Data (only when Yahoo is blocked)
    if (!data) {
      data = await fetchTwelveData(ticker, r);
      if (data) source = 'twelvedata';
    }
    // Tier 3: Alpha Vantage (optional last resort)
    if (!data) {
      data = await fetchAlphaVantage(ticker, r);
      if (data) source = 'alphavantage';
    }
    if (!data) {
      res.status(502).json({ error: 'Market data unavailable for ' + ticker + ' — set TWELVEDATA_API_KEY (free at twelvedata.com) for a reliable source.' });
      return;
    }

    const session = await sessionPromise;
    const pe = session ? await getYahooPE(ticker, headers, session) : null;
    if (pe) data._pe = pe;
    data._source = source;

    res.setHeader('Cache-Control', `public, max-age=${r === '1d' ? 60 : 300}, s-maxage=${r === '1d' ? 120 : 600}`);
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}

// ── Tier 1: Twelve Data ──────────────────────────────────────────────────────
async function fetchTwelveData(ticker, r) {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return null;
  try {
    // interval + number of points per range (free tier supports intraday too)
    const plan = {
      '1d': ['5min', 78], '5d': ['15min', 130], '1mo': ['1day', 23], '3mo': ['1day', 64],
      '6mo': ['1day', 128], '1y': ['1day', 252], '2y': ['1week', 105], '5y': ['1week', 261],
      '10y': ['1month', 120], 'max': ['1month', 600]
    }[r] || ['1day', 252];
    let url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}&interval=${plan[0]}&outputsize=${plan[1]}&apikey=${key}`;
    if (r === 'ytd') {
      const y = new Date().getFullYear();
      url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}&interval=1day&start_date=${y}-01-01&apikey=${key}`;
    }
    const j = await (await fetch(url)).json();
    if (!j || j.status === 'error' || !Array.isArray(j.values) || j.values.length < 2) return null;
    // values arrive newest-first; reverse to ascending like Yahoo
    const closes = j.values.map(v => parseFloat(v.close)).filter(v => !isNaN(v) && v > 0).reverse();
    if (closes.length < 2) return null;
    const currentPrice = closes[closes.length - 1];
    const prevClose = closes[0]; // change shown across the selected range
    return { chart: { result: [{ meta: { regularMarketPrice: currentPrice, chartPreviousClose: prevClose }, indicators: { quote: [{ close: closes }] } }] } };
  } catch (_) { return null; }
}

// ── Tier 2: Yahoo chart (unofficial) ─────────────────────────────────────────
async function fetchYahooChart(ticker, r, interval, headers, cookie) {
  const h = cookie ? Object.assign({}, headers, { Cookie: cookie }) : headers;
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${r}&interval=${interval}&includePrePost=false`;
      const resp = await fetch(url, { headers: h });
      if (!resp.ok) continue;
      const j = await resp.json();
      const result = j && j.chart && j.chart.result && j.chart.result[0];
      if (result && result.meta && result.meta.regularMarketPrice) return j;
    } catch (_) { /* try next host */ }
  }
  return null;
}

// Yahoo guest session: cookie from fc.yahoo.com + crumb (required for quoteSummary).
async function getYahooSession(headers) {
  try {
    const c = await fetch('https://fc.yahoo.com', { headers, redirect: 'manual' });
    const setCookies = typeof c.headers.getSetCookie === 'function' ? c.headers.getSetCookie() : [c.headers.get('set-cookie')].filter(Boolean);
    if (!setCookies.length) return null;
    const cookie = setCookies.map(s => s.split(';')[0]).join('; ');
    const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: Object.assign({}, headers, { Cookie: cookie }) });
    if (!cr.ok) return { cookie, crumb: null };
    const crumb = (await cr.text()).trim();
    return { cookie, crumb: (!crumb || crumb.includes('<')) ? null : crumb };
  } catch (_) { return null; }
}

// Best-effort P/E (trailing + forward) from Yahoo. Forward P/E needs analyst
// estimates, which no free official API provides — so this stays opportunistic.
async function getYahooPE(ticker, headers, session) {
  if (!session || !session.crumb) return null;
  try {
    const h = Object.assign({}, headers, { Cookie: session.cookie });
    const qs = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=summaryDetail&crumb=${encodeURIComponent(session.crumb)}`, { headers: h });
    if (!qs.ok) return null;
    const qj = await qs.json();
    const sd = (qj && qj.quoteSummary && qj.quoteSummary.result && qj.quoteSummary.result[0] && qj.quoteSummary.result[0].summaryDetail) || {};
    return {
      trailingPE: (sd.trailingPE && sd.trailingPE.raw) || null,
      forwardPE: (sd.forwardPE && sd.forwardPE.raw) || null
    };
  } catch (_) { return null; }
}

// ── Tier 3: Alpha Vantage (optional last resort) ─────────────────────────────
async function fetchAlphaVantage(ticker, r) {
  const key = process.env.ALPHAVANTAGE_API_KEY;
  if (!key) return null;
  try {
    const full = ['2y', '5y', '10y', 'max'].includes(r);
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(ticker)}&outputsize=${full ? 'full' : 'compact'}&apikey=${key}`;
    const j = await (await fetch(url)).json();
    const ts = j['Time Series (Daily)'];
    if (!ts) return null;
    let dates = Object.keys(ts).sort();
    if (r === 'ytd') {
      const y = new Date().getFullYear();
      dates = dates.filter(d => d >= y + '-01-01');
    } else {
      const days = { '1d': 2, '5d': 7, '1mo': 23, '3mo': 64, '6mo': 128, '1y': 252, '2y': 504, '5y': 1260, '10y': 2520, 'max': 1e9 }[r] || 252;
      dates = dates.slice(-days);
    }
    const closes = dates.map(d => parseFloat(ts[d]['4. close'])).filter(v => !isNaN(v) && v > 0);
    if (closes.length < 2) return null;
    const currentPrice = closes[closes.length - 1];
    const prevClose = r === '1d' ? closes[closes.length - 2] : closes[0];
    return { chart: { result: [{ meta: { regularMarketPrice: currentPrice, chartPreviousClose: prevClose }, indicators: { quote: [{ close: closes }] } }] } };
  } catch (_) { return null; }
}
