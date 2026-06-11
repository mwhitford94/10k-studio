// api/fetch-filing.js — one serverless function. Works on Vercel as-is.
// It: resolves ticker -> CIK, finds the latest 10-K/10-Q on SEC EDGAR,
// downloads the actual filing, asks Claude to structure it, and returns
// the JSON your 10-K Studio page imports. Your API key stays on the server.
//
// Speed: the output schema is large (~6-8k tokens), so structuring runs as TWO
// Claude calls in parallel — financial statements and commentary/profile —
// then merges. Wall time ≈ the slower call instead of the sum.
//
// Required environment variables (set in your host's dashboard):
//   ANTHROPIC_API_KEY  = sk-ant-...           (your Anthropic key)
//   SEC_USER_AGENT     = "Your Name you@firm.com"   (SEC requires a contact UA)

const STATEMENTS_PROMPT = [
'You are a precise SEC filing parser. Return ONLY one JSON object (no markdown) with EXACTLY these keys:',
'{"company":"","period":"","priorPeriod":"","currency":"USD","units":"millions",',
'"pnl":{"revenue":0,"costOfRevenue":0,"operatingExpenses":[{"name":"","value":0}],"nonOperating":[{"name":"","value":0}],"incomeTax":0,"netIncome":0},',
'"pnlPrior":{"revenue":0,"costOfRevenue":0,"operatingIncome":0,"netIncome":0},',
'"segments":[{"name":"","revenue":0,"operatingIncome":null}],"geographies":[{"name":"","revenue":0}],',
'"productCategories":[{"name":"","revenue":0}],"channelRevenue":[{"name":"","revenue":0}],',
'"balanceSheet":{"currentAssets":[{"name":"","value":0}],"nonCurrentAssets":[{"name":"","value":0}],"currentLiabilities":[{"name":"","value":0}],"nonCurrentLiabilities":[{"name":"","value":0}],"equity":[{"name":"","value":0}]},',
'"balanceSheetPrior":{"totalAssets":0,"totalLiabilities":0,"totalEquity":0,"accountsReceivable":0,"accountsPayable":0},',
'"balanceSheetPriorDetail":{"currentAssets":[{"name":"","value":0}],"nonCurrentAssets":[{"name":"","value":0}],"currentLiabilities":[{"name":"","value":0}],"nonCurrentLiabilities":[{"name":"","value":0}],"equity":[{"name":"","value":0}]},',
'"cashFlow":{"operating":[{"name":"","value":0}],"investing":[{"name":"","value":0}],"financing":[{"name":"","value":0}],"fxEffect":0,"beginningCash":0,"endingCash":0,"netChange":0},',
'"cashFlowPrior":{"netChange":0},"dimensionalCash":{"metric":"","bySegment":[],"byGeography":[]}}',
'Rules: most recent fiscal period for current figures, the prior comparable period for *Prior. units one of billions/millions/thousands/absolute. costOfRevenue/operatingExpenses POSITIVE; nonOperating SIGNED (income +, expense -); cashFlow items SIGNED (inflow +, outflow -). Include Accounts receivable and Accounts payable by name. balanceSheetPriorDetail = same structure as balanceSheet for the prior period; match line names to balanceSheet exactly; empty arrays if not available. productCategories = revenue by product line ONLY if separately disclosed; [] otherwise. channelRevenue ONLY if disclosed; [] otherwise. segments operatingIncome null if not disclosed. dimensionalCash ONLY if a cash metric is disclosed by segment/geography. Return only the JSON.'
].join('\n');

const COMMENTARY_PROMPT = [
'You are a precise SEC filing analyst. Return ONLY one JSON object (no markdown) with EXACTLY these keys:',
'{"balanceSheetNotes":[{"item":"","note":""}],',
'"cashFlowNotes":[{"item":"","note":""}],',
'"profile":{"description":"","sector":"","industry":"","headquarters":"","founded":"","employees":"","ticker":"","exchange":"","businessModel":"","segmentation":"","channels":[""],"competitors":[""],"marketPosition":"","marketShare":"","marketCap":"","sharesOutstanding":"","fiscalYearEnd":0,"industryPE":0,"industryForwardPE":0,"forwardPE":0,"mdaKpis":[{"name":"","value":"","sub":""}],"positioning":[{"name":"","cost":0,"quality":0}],"marketShareBreakdown":[{"name":"","share":0}],"marketShareMarkets":[{"market":"","entries":[{"name":"","share":0}]}],"differentiation":[""],"fiveYearRevenue":[{"year":"","revenue":0,"netIncome":0}]},',
'"narrative":{"headline":"","summary":"","findings":[""],"outlook":[""],"risks":[""],"capitalAllocation":[""]}}',
'Rules: balanceSheetNotes = for each balance sheet line that changed meaningfully plus "Assets"/"Liabilities"/"Equity" totals, 1-2 sentences from the MD&A financial condition discussion; item must EXACTLY match the statement line label as printed in the filing. cashFlowNotes = same for cash flow line items plus "Operating"/"Investing"/"Financing"/"Net change in cash". profile.fiscalYearEnd = month 1-12. profile.marketCap = approximate short string (e.g. "~$3.4T"); your knowledge may be stale — the viewer recomputes live, this is only a fallback. profile.sharesOutstanding = REQUIRED short string (e.g. "15.4B"); every 10-K/10-Q states it on the COVER PAGE ("...shares outstanding as of...") — read it from there, summing share classes if multiple. profile.industryPE / industryForwardPE = approximate industry trailing/forward P/E (numeric, general knowledge, 0 if unknown). profile.forwardPE = approximate forward P/E for THIS company (numeric, 0 if unknown). profile.mdaKpis = 4-6 company-specific KPIs from MD&A, each {name, value (short string WITH units), sub (YoY/context)}. positioning scores 0-100 (cost: budget->premium, quality: low->high) for the company + main rivals. marketShareBreakdown approximate percents (viewer adds "All other"). marketShareMarkets = 2-6 share views across distinct markets/product groups (labels may be product groups or region views e.g. "Smartphones — Greater China"), each {market, entries:[{name,share}]} including the company; [] if unknown. fiveYearRevenue = last 5 fiscal years in the SAME units as the statements, each {year,revenue,netIncome}. narrative in your own words, never copied. Return only the JSON.'
].join('\n');

async function sec(url, ua) {
  const r = await fetch(url, { headers: { 'User-Agent': ua, 'Accept-Encoding': 'gzip, deflate' } });
  if (!r.ok) throw new Error('SEC ' + r.status + ' for ' + url);
  return r;
}

async function callClaude(system, userContent, maxTokens) {
  const ar = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  const aj = await ar.json();
  if (aj.error) throw new Error('Anthropic: ' + (aj.error.message || JSON.stringify(aj.error)));
  let out = (aj.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  out = out.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const a = out.indexOf('{'), b = out.lastIndexOf('}');
  if (a >= 0 && b > a) out = out.slice(a, b + 1);
  return JSON.parse(out);
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
      .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, ' ') // inline-XBRL metadata block — large and useless
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 400000);

    // 4) structure with Claude — two passes IN PARALLEL (statements + commentary)
    const userContent = form + ' for ' + rec.title + ':\n\n' + text;
    const [stmts, comm] = await Promise.all([
      callClaude(STATEMENTS_PROMPT, userContent, 4500),
      callClaude(COMMENTARY_PROMPT, userContent, 4500)
    ]);
    const model = Object.assign({}, stmts, comm);
    model.filingUrl = url;

    res.setHeader('Cache-Control', 's-maxage=86400'); // filings are immutable; cache a day at the edge
    res.status(200).json(model);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
