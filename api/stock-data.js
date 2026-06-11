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
    const quoteUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=summaryDetail,defaultKeyStatistics`;
    const [chartRes, quoteRes] = await Promise.allSettled([
      fetch(chartUrl, { headers }),
      fetch(quoteUrl, { headers })
    ]);
    if (chartRes.status !== 'fulfilled' || !chartRes.value.ok) {
      const code = chartRes.status === 'fulfilled' ? chartRes.value.status : 500;
      res.status(code).json({ error: 'Yahoo Finance chart returned ' + code + ' for ' + ticker });
      return;
    }
    const data = await chartRes.value.json();
    // Attach PE data if available
    if (quoteRes.status === 'fulfilled' && quoteRes.value.ok) {
      try {
        const qj = await quoteRes.value.json();
        const sd = qj?.quoteSummary?.result?.[0]?.summaryDetail || {};
        data._pe = {
          trailingPE: sd.trailingPE?.raw || null,
          forwardPE: sd.forwardPE?.raw || null
        };
      } catch (_) { /* non-fatal */ }
    }
    res.setHeader('Cache-Control', `public, max-age=${r === '1d' ? 60 : 300}`);
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
