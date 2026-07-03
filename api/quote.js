// Vercel 서버리스 함수: Yahoo Finance 프록시 (CORS 우회)
// GET /api/quote?symbol=SPY  ->  { symbol, name, series: [["YYYY-MM-DD", value], ...] }
//  - 일반 티커: value = adjClose(배당 재투자 총수익)
//  - ^로 시작(금리 지수, 예 ^IRX): value = close(연이율 %)

module.exports = async function handler(req, res) {
  const symbol = String((req.query && req.query.symbol) || "").trim();
  if (!symbol) {
    res.status(400).json({ error: "symbol 파라미터가 필요합니다" });
    return;
  }
  if (!/^[\^A-Za-z0-9.\-=]{1,15}$/.test(symbol)) {
    res.status(400).json({ error: "유효하지 않은 티커 형식" });
    return;
  }

  try {
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?period1=0&period2=9999999999&interval=1d&events=div%2Csplit`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) {
      res.status(r.status).json({ error: `Yahoo 응답 오류 ${r.status}` });
      return;
    }
    const j = await r.json();
    const result = j && j.chart && j.chart.result && j.chart.result[0];
    if (!result) {
      res.status(404).json({ error: (j?.chart?.error?.description) || "데이터 없음" });
      return;
    }

    const ts = result.timestamp || [];
    const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const adj = (result.indicators && result.indicators.adjclose && result.indicators.adjclose[0]?.adjclose) || [];
    const isRate = symbol.startsWith("^");

    const series = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close ? q.close[i] : null;
      if (close == null) continue;
      const raw = isRate ? close : (adj[i] != null ? adj[i] : close);
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      series.push([date, Math.round(raw * 1e6) / 1e6]);
    }
    if (!series.length) {
      res.status(404).json({ error: "유효한 가격 데이터 없음" });
      return;
    }

    // 배당 이벤트
    const divObj = (result.events && result.events.dividends) || {};
    const dividends = Object.values(divObj)
      .map((d) => [new Date(d.date * 1000).toISOString().slice(0, 10), Math.round(d.amount * 1e6) / 1e6])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));

    const meta = result.meta || {};
    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json({
      symbol: (meta.symbol || symbol).toUpperCase(),
      name: meta.longName || meta.shortName || symbol,
      currency: meta.currency || "USD",
      series,
      dividends,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
