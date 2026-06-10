// api/fetch-filing.js  — one serverless function. Works on Vercel as-is.
// It: resolves ticker -> CIK, finds the latest 10-K/10-Q on SEC EDGAR,
// downloads the actual filing, asks Claude to structure it, and returns
// the JSON your 10-K Studio page imports. Your API key stays on the server.
//
// Required environment variables (set in your host's dashboard):
//   ANTHROPIC_API_KEY  = sk-ant-...           (your Anthropic key)
//   SEC_USER_AGENT     = "Your Name you@firm.com"   (SEC requires a contact UA)

const SCHEMA_PROMPT = [
'You are a precise SEC filing parser. Return ONLY one JSON object (no markdown) with EXACTLY these keys:',
'{"company":"","period":"","priorPeriod":"","currency":"USD","units":"millions",',
'"pnl":{"revenue":0,"costOfRevenue":0,"operatingExpenses":[{"name":"","value":0}],"nonOperating":[{"name":"","value":0}],"incomeTax":0,"netIncome":0},',
'"pnlPrior":{"revenue":0,"costOfRevenue":0,"operatingIncome":0,"netIncome":0},',
'"segments":[{"name":"","revenue":0,"operatingIncome":null}],"geographies":[{"name":"","revenue":0}],',
'"balanceSheet":{"currentAssets":[{"name":"","value":0}],"nonCurrentAssets":[{"name":"","value":0}],"currentLiabilities":[{"name":"","value":0}],"nonCurrentLiabilities":[{"name":"","value":0}],"equity":[{"name":"","value":0}]},',
'"balanceSheetPrior":{"totalAssets":0,"totalLiabilities":0,"totalEquity":0,"accountsReceivable":0,"accountsPayable":0},',
'"cashFlow":{"operating":[{"name":"","value":0}],"investing":[{"name":"","value":0}],"financing":[{"name":"","value":0}],"fxEffect":0,"beginningCash":0,"endingCash":0,"netChange":0},',
'"cashFlowPrior":{"netChange":0},"dimensionalCash":{"metric":"","bySegment":[],"byGeography":[]},',
'"profile":{"description":"","sector":"","industry":"","headquarters":"","founded":"","employees":"","ticker":"","exchange":"","businessModel":"","segmentation":"","channels":[""],"competitors":[""],"marketPosition":"","marketShare":"","positioning":[{"name":"","cost":0,"quality":0}],"marketShareBreakdown":[{"name":"","share":0}],"differentiation":[""],"fiveYearRevenue":[{"year":"","revenue":0}]},',
'"narrative":{"headline":"","summary":"","findings":[""],"outlook":[""],"risks":[""],"capitalAllocation":[""]}}',
'Rules: most recent fiscal period for current figures, the prior comparable period for *Prior. units one of billions/millions/thousands/absolute. costOfRevenue/operatingExpenses POSITIVE; nonOperating SIGNED (income +, expense -); cashFlow items SIGNED (inflow +, outflow -). Include Accounts receivable and Accounts payable by name. segments operatingIncome null if not disclosed. positioning scores 0-100 (cost: budget->premium, quality: low->high) for the company + main rivals; marketShareBreakdown approximate percents (an "All other" remainder is added by the viewer). fiveYearRevenue = last 5 fiscal years in the same units. narrative in your own words, never copied. Return only the JSON.'
].join('\n');

async function sec(url, ua) {
  const r = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Encoding': 'gzip, deflate' } });
  if (!r.ok) throw new Error('SEC ' + r.status + ' for ' + url);
  return r;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const ticker = (req.query.ticker || '').trim();
  const form = (req.query.form || '10-K').trim();
  const period = (req.query.period || '').trim();
  const UA = process.env.SEC_USER_AGENT || 'TenK Studio contact@example.com';

  if (!ticker) { res.status(400).json({ error: 'Missing ticker' }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on the server' }); return; }

  try {
    // 1) ticker / name -> CIK
    const map = await (await sec('https://www.sec.gov/files/company_tickers.json', UA)).json();
    const q = ticker.toUpperCase();
    const rows = Object.values(map);
    const rec = rows.find(r => r.ticker.toUpperCase() === q)
             || rows.find(r => r.title.toUpperCase().includes(q));
    if (!rec) { res.status(404).json({ error: 'Company not found: ' + ticker }); return; }
    const cik10 = String(rec.cik_str).padStart(10, '0');

    // 2) find the filing in the submissions index (recent = newest first)
    const sub = await (await sec('https://data.sec.gov/submissions/CIK' + cik10 + '.json', UA)).json();
    const f = sub.filings.recent;
    let idx = -1;
    for (let i = 0; i < f.form.length; i++) {
      if (f.form[i] !== form) continue;
      const rd = f.reportDate[i] || '';
      if (period) {
        const fy = rd ? 'FY' + rd.slice(0, 4) : '';
        if (!rd.includes(period) && !fy.includes(period)) continue;
      }
      idx = i; break;
    }
    if (idx < 0) { res.status(404).json({ error: 'No ' + form + ' found for ' + rec.title + (period ? ' (' + period + ')' : '') }); return; }

    const accession = f.accessionNumber[idx].replace(/-/g, '');
    const doc = f.primaryDocument[idx];
    const url = 'https://www.sec.gov/Archives/edgar/data/' + rec.cik_str + '/' + accession + '/' + doc;

    // 3) download the actual filing and reduce to text
    let html = await (await sec(url, UA)).text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 500000);

    // 4) structure with Claude (key stays server-side)
    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: SCHEMA_PROMPT,
        messages: [{ role: 'user', content: form + ' for ' + rec.title + ':\n\n' + text }]
      })
    });
    const aj = await ar.json();
    if (aj.error) throw new Error('Anthropic: ' + (aj.error.message || JSON.stringify(aj.error)));
    let out = (aj.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    out = out.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const a = out.indexOf('{'), b = out.lastIndexOf('}');
    if (a >= 0 && b > a) out = out.slice(a, b + 1);
    const model = JSON.parse(out);

    res.setHeader('Cache-Control', 's-maxage=86400'); // filings are immutable; cache a day at the edge
    res.status(200).json(model);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
