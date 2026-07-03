// 백테스트용 데이터 빌더
// QQQ, VOO (주가), ^IRX (13주 T-bill 금리, 리저브 이자 모델), SGOV (검증용)
// -> 각 티커 CSV + 브라우저용 data.js 생성
// 사용법: node build_data.js

const fs = require("fs");
const path = require("path");

const OUT_DIR = __dirname;
const STOCKS = ["QQQ", "VOO"];
const RATE = "^IRX";      // 13주 국채 금리 (연 %)
const VALID = "SGOV";     // 2020~ 검증용

function toDateStr(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return (
    d.getUTCFullYear() +
    "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getUTCDate()).padStart(2, "0")
  );
}
const r6 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 1e6) / 1e6);

async function fetchSeries(symbol) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=0&period2=9999999999&interval=1d&events=div%2Csplit`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`${symbol}: ${json?.chart?.error?.description || "no data"}`);

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];

  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (close == null) continue;
    out.push({
      date: toDateStr(ts[i]),
      open: r6(q.open?.[i]),
      high: r6(q.high?.[i]),
      low: r6(q.low?.[i]),
      close: r6(close),
      adjClose: r6(adj?.[i] != null ? adj[i] : close),
      volume: q.volume?.[i] ?? null,
    });
  }
  const divObj = (result.events && result.events.dividends) || {};
  const dividends = Object.values(divObj)
    .map((d) => [toDateStr(d.date), r6(d.amount)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  out.dividends = dividends;
  return out;
}

function writeCsv(symbol, rows) {
  const lines = ["Date,Open,High,Low,Close,AdjClose,Volume"];
  for (const r of rows) {
    lines.push(
      [r.date, r.open ?? "", r.high ?? "", r.low ?? "", r.close ?? "", r.adjClose ?? "", r.volume ?? ""].join(",")
    );
  }
  const safe = symbol.replace(/[^A-Za-z0-9]/g, "");
  fs.writeFileSync(path.join(OUT_DIR, `${safe}_daily.csv`), lines.join("\n") + "\n", "utf8");
}

(async () => {
  const data = {};
  const div = {};

  for (const s of STOCKS) {
    const rows = await fetchSeries(s);
    writeCsv(s, rows);
    // data.js: [날짜, adjClose] 만 (백테스트는 총수익 기준 adjClose 사용)
    data[s] = rows.map((r) => [r.date, r.adjClose]);
    div[s] = rows.dividends || [];
    console.log(`${s}: ${rows.length}행, 배당 ${div[s].length}건 (${rows[0].date} ~ ${rows[rows.length - 1].date})`);
  }

  // ^IRX: close = 연이율(%) 값
  const irx = await fetchSeries(RATE);
  writeCsv(RATE, irx);
  data.IRX = irx.map((r) => [r.date, r.close]);
  console.log(`${RATE}: ${irx.length}행 (${irx[0].date} ~ ${irx[irx.length - 1].date})`);

  // SGOV 검증용 (있으면)
  try {
    const sgov = await fetchSeries(VALID);
    writeCsv(VALID, sgov);
    data.SGOV = sgov.map((r) => [r.date, r.adjClose]);
    console.log(`${VALID}: ${sgov.length}행 (${sgov[0].date} ~ ${sgov[sgov.length - 1].date})`);
  } catch (e) {
    console.warn(`SGOV 스킵: ${e.message}`);
  }

  const js =
    "// 자동 생성 파일 (build_data.js). 각 항목: [ 'YYYY-MM-DD', 값 ]\n" +
    "window.DATA = " + JSON.stringify(data) + ";\n" +
    "window.DIV = " + JSON.stringify(div) + ";\n";
  fs.writeFileSync(path.join(OUT_DIR, "data.js"), js, "utf8");
  const kb = (fs.statSync(path.join(OUT_DIR, "data.js")).size / 1024).toFixed(0);
  console.log(`data.js 생성 완료 (${kb} KB)`);
})().catch((e) => {
  console.error("빌드 실패:", e.message);
  process.exit(1);
});
