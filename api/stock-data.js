// api/stock-data.js — Yahoo Finance proxy for stock price / sparkline data
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ticker = (req.query.ticker || '').trim().toUpperCase();
  const range = req.query.range || '1y';

  if (!ticker) { res.status(400).json({ error: 'Missing ticker' }); return; }

  const validRanges = ['1d', '5d', '1mo', '3mo', '6mo', 'ytd', '1y', '2y', '5y', '10y', 'max'];
  const r = validRanges.includes(range) ? range : '1y';
  const intervalMap = { '1d': '5m', '5d': '15m', '1mo': '1d', '3mo': '1d', '6mo': '1d', 'ytd': '1d', '1y': '1d', '2y': '1wk', '5y': '1wk', '10y': '1mo', 'max': '1mo' };
  const interval = intervalMap[r] || '1d';

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept': 'application/json,*/*'
  };
  try {
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${r}&interval=${interval}&includePrePost=false`;
    const [chartRes, pe] = await Promise.all([
      fetch(chartUrl, { headers }),
      getYahooPE(ticker, headers)
    ]);
    if (!chartRes.ok) {
      res.status(chartRes.status).json({ error: 'Yahoo Finance chart returned ' + chartRes.status + ' for ' + ticker });
      return;
    }
    const data = await chartRes.json();
    if (pe) data._pe = pe;
    res.setHeader('Cache-Control', `public, max-age=${r === '1d' ? 60 : 300}`);
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}

// Yahoo's quoteSummary endpoint requires a session cookie + crumb since 2023.
async function getYahooPE(ticker, headers) {
  try {
    const c = await fetch('https://fc.yahoo.com', { headers, redirect: 'manual' });
    const setCookies = typeof c.headers.getSetCookie === 'function' ? c.headers.getSetCookie() : [c.headers.get('set-cookie')].filter(Boolean);
    if (!setCookies.length) return null;
    const cookie = setCookies.map(s => s.split(';')[0]).join('; ');
    const h = Object.assign({}, headers, { Cookie: cookie });
    const cr = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: h });
    if (!cr.ok) return null;
    const crumb = (await cr.text()).trim();
    if (!crumb || crumb.includes('<')) return null;
    const qs = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=summaryDetail&crumb=${encodeURIComponent(crumb)}`, { headers: h });
    if (!qs.ok) return null;
    const qj = await qs.json();
    const sd = (qj && qj.quoteSummary && qj.quoteSummary.result && qj.quoteSummary.result[0] && qj.quoteSummary.result[0].summaryDetail) || {};
    return {
      trailingPE: (sd.trailingPE && sd.trailingPE.raw) || null,
      forwardPE: (sd.forwardPE && sd.forwardPE.raw) || null
    };
  } catch (_) { return null; }
}
