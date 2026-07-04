/* 기계식 vs 동적 DCA 백테스트
 * - 임의 티커 (Vercel /api/quote 프록시, 없으면 data.js 폴백)
 * - 단일 티커 또는 여러 티커 합산 포트폴리오
 * - 예산모델: reserve(총원금 동일+리저브) / extra(하락시 추가금, IRR 비교)
 */
const TRADING_DAYS = 252;

const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const fmtMoney = (v) => "$" + Math.round(v).toLocaleString("en-US");
const fmtK = (v) => "$" + Math.round(v / 1000).toLocaleString("en-US") + "k";
const fmtPct = (v, dp = 1) => (v * 100).toFixed(dp) + "%";
const fmtPp = (v, dp = 2) => (v >= 0 ? "+" : "") + (v * 100).toFixed(dp) + "%p";
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function fmtDur(years) {
  if (!isFinite(years)) return "도달 불가";
  if (years <= 0.04) return "이미 달성";
  const y = Math.floor(years), mo = Math.round((years - y) * 12);
  if (y === 0) return `약 ${mo}개월`;
  return mo > 0 ? `약 ${y}년 ${mo}개월` : `약 ${y}년`;
}

const NAMES = { QQQ: "Invesco QQQ", VOO: "Vanguard S&P 500", SPY: "SPDR S&P 500", GLD: "SPDR Gold", IRX: "13주 국채금리" };

// ---------- 데이터 레이어 ----------
async function loadSymbol(sym) {
  const key = sym.toUpperCase();
  if (window.DATA && window.DATA[key] && window.DATA[key].length) return { ok: true, key, name: NAMES[key] || key };
  try {
    const res = await fetch("/api/quote?symbol=" + encodeURIComponent(sym));
    const j = await res.json();
    if (!res.ok || !j.series || !j.series.length) throw new Error(j.error || ("HTTP " + res.status));
    window.DATA = window.DATA || {};
    window.DIV = window.DIV || {};
    window.DATA[key] = j.series;
    window.DIV[key] = j.dividends || [];
    NAMES[key] = j.name || key;
    return { ok: true, key, name: NAMES[key] };
  } catch (e) {
    if (window.DATA && window.DATA[key]) return { ok: true, key, name: NAMES[key] || key };
    return { ok: false, key, error: e.message };
  }
}

// 배당 이력에서 지급주기·회당 금액·연 배당·배당률 추론
function divInfo(sym) {
  const divs = (window.DIV && window.DIV[sym]) || [];
  const price = currentPrice(sym);
  if (!divs.length || !price) return { has: false };
  const recent = divs.slice(-12);
  const perShare = recent[recent.length - 1][1];
  // 최근 지급 간격(일) 중앙값으로 주기 추정
  const gaps = [];
  for (let i = 1; i < recent.length; i++) gaps.push((parseDate(recent[i][0]) - parseDate(recent[i - 1][0])) / 864e5);
  gaps.sort((a, b) => a - b);
  const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 365;
  let label, perYear;
  if (medGap <= 10) { label = "주간"; perYear = 52; }
  else if (medGap <= 20) { label = "격주"; perYear = 26; }
  else if (medGap <= 45) { label = "월간"; perYear = 12; }
  else if (medGap <= 135) { label = "분기"; perYear = 4; }
  else if (medGap <= 250) { label = "반기"; perYear = 2; }
  else { label = "연간"; perYear = 1; }
  // 연 배당: 최근 365일 합, 없으면 회당×연지급수
  const cutoff = Date.now() - 365 * 864e5;
  let ttm = 0, ttmCount = 0;
  for (const [d, a] of divs) { if (parseDate(d) >= cutoff) { ttm += a; ttmCount++; } }
  const annual = ttmCount >= Math.max(1, perYear - 1) ? ttm : perShare * perYear;
  return { has: true, label, perYear, perShare, annual, yield: annual / price, lastDate: recent[recent.length - 1][0] };
}
async function ensureRates() {
  if (window.DATA && window.DATA.IRX && window.DATA.IRX.length) return true;
  try {
    const res = await fetch("/api/quote?symbol=" + encodeURIComponent("^IRX"));
    const j = await res.json();
    if (!res.ok || !j.series) throw new Error(j.error);
    window.DATA = window.DATA || {};
    window.DATA.IRX = j.series;
    return true;
  } catch (e) { return false; }
}

function alignRates(dates) {
  const irx = (window.DATA && window.DATA.IRX) || [];
  const out = new Array(dates.length);
  let j = 0, last = 4.0;
  for (let i = 0; i < dates.length; i++) {
    while (j < irx.length && parseDate(irx[j][0]) <= dates[i]) { if (irx[j][1] != null) last = irx[j][1]; j++; }
    out[i] = last;
  }
  return out;
}
function rollingSMA(prices, win) {
  const out = new Array(prices.length).fill(null);
  let sum = 0;
  for (let i = 0; i < prices.length; i++) { sum += prices[i]; if (i >= win) sum -= prices[i - win]; if (i >= win) out[i] = sum / win; }
  return out;
}
function xirr(flows) {
  if (flows.length < 2) return NaN;
  const t0 = flows[0].t;
  const yrs = (f) => (f.t - t0) / (365 * 24 * 3600 * 1000);
  const npv = (r) => flows.reduce((s, f) => s + f.cf / Math.pow(1 + r, yrs(f)), 0);
  let lo = -0.9999, hi = 10, flo = npv(lo);
  if (isNaN(flo) || flo * npv(hi) > 0) return NaN;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-6) return mid;
    if (flo * fm < 0) hi = mid; else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

// ---------- 단일 티커 백테스트 ----------
function runBacktest(ticker, params) {
  const raw = window.DATA[ticker];
  const startT = params.startDate ? parseDate(params.startDate) : -Infinity;
  const endT = params.endDate ? parseDate(params.endDate) : Infinity;
  const dates = [], prices = [];
  for (const [d, p] of raw) { if (p == null) continue; dates.push(parseDate(d)); prices.push(p); }

  const sma = rollingSMA(prices, params.smaWin);
  const rates = alignRates(dates);
  const ath = new Array(prices.length);
  let peak = -Infinity;
  for (let i = 0; i < prices.length; i++) { peak = Math.max(peak, prices[i]); ath[i] = peak; }

  const B = params.base;
  const extra = params.mode === "extra";
  const freq = params.freq || "monthly";
  let mShares = 0, dShares = 0, reserve = 0, investedM = 0, investedD = 0;
  let lastReco = null;
  const series = { labels: [], mech: [], dyn: [], contribM: [], contribD: [], mult: [], second: [], reserveAmt: [], effM: [], effD: [] };
  const flowsM = [], flowsD = [];
  let started = false, prevMonthKey = null, lastI = -1;
  let maxMech = 0, maxDyn = 0, mddMech = 0, mddDyn = 0, rsvSum = 0, rsvCount = 0;

  for (let i = 0; i < dates.length; i++) {
    const t = dates[i];
    if (t < startT) continue;
    if (t > endT) break;
    lastI = i;
    const price = prices[i];
    const dObj = new Date(t);
    const periodKey = freq === "weekly" ? Math.floor(t / (7 * 864e5)) : dObj.getUTCFullYear() * 12 + dObj.getUTCMonth();
    const rf = 1 + rates[i] / 100 / TRADING_DAYS;
    if (params.rsvInterest && reserve > 0) reserve *= rf;

    const isContribDay = periodKey !== prevMonthKey;
    let mult = null;
    if (isContribDay) {
      prevMonthKey = periodKey; started = true;
      investedM += B; mShares += B / price; flowsM.push({ t, cf: -B });

      let m_ma = 1, disc = 0;
      if (sma[i] != null) { disc = (sma[i] - price) / sma[i]; m_ma = 1 + params.k * clamp(disc, -0.15, 0.30); }
      const dd = (ath[i] - price) / ath[i];
      let ddBonus = dd >= 0.30 ? 2.0 : dd >= 0.20 ? 1.0 : dd >= 0.10 ? 0.5 : 0.0;
      ddBonus *= params.ddScale;
      mult = clamp(m_ma + ddBonus, params.mMin, params.mMax);

      // 실행 가이드(항상 리저브식): 고정 적립금 B 중 매수액 + SGOV 예치/인출
      const recoInvest = Math.min(B * mult, B + reserve);

      if (extra) {
        const invest = B * mult;
        investedD += invest; dShares += invest / price; flowsD.push({ t, cf: -invest });
      } else {
        investedD += B; dShares += recoInvest / price; flowsD.push({ t, cf: -B });
      }
      reserve += B - recoInvest; // 리저브 회계는 mode와 무관하게 실전 가이드 기준으로 진행
      lastReco = {
        symbol: ticker, date: dObj.toISOString().slice(0, 10), price,
        sma: sma[i], discount: disc, dd, mult, base: B,
        invest: recoInvest, sgovFlow: B - recoInvest, balance: reserve,
      };
    }
    if (!started) continue;
    const mVal = mShares * price;
    const dVal = dShares * price + (extra ? 0 : reserve);
    if (isContribDay) {
      series.labels.push(dObj.toISOString().slice(0, freq === "weekly" ? 10 : 7));
      series.mech.push(mVal); series.dyn.push(dVal);
      series.contribM.push(investedM); series.contribD.push(investedD);
      series.mult.push(mult); series.reserveAmt.push(extra ? 0 : reserve);
      series.second.push(extra ? (investedM > 0 ? investedD / investedM : 1) : (dVal > 0 ? reserve / dVal : 0));
      series.effM.push(investedM > 0 ? mVal / investedM : 1);
      series.effD.push(investedD > 0 ? dVal / investedD : 1);
    }
    maxMech = Math.max(maxMech, mVal); mddMech = Math.max(mddMech, (maxMech - mVal) / maxMech);
    maxDyn = Math.max(maxDyn, dVal); mddDyn = Math.max(mddDyn, (maxDyn - dVal) / maxDyn);
    rsvSum += reserve; rsvCount++;
  }

  const li = lastI >= 0 ? lastI : dates.length - 1;
  const lastT = dates[li], lastPrice = prices[li];
  const finalMech = mShares * lastPrice, finalDyn = dShares * lastPrice + (extra ? 0 : reserve);
  flowsM.push({ t: lastT, cf: finalMech }); flowsD.push({ t: lastT, cf: finalDyn });

  return {
    extra, series, flowsM, flowsD, recos: lastReco ? [lastReco] : [],
    metrics: {
      investedM, investedD, finalMech, finalDyn,
      effMech: finalMech / investedM, effDyn: finalDyn / investedD,
      irrMech: xirr(flowsM), irrDyn: xirr(flowsD),
      mddMech, mddDyn, finalReserve: reserve, avgReserve: rsvCount ? rsvSum / rsvCount : 0,
      months: series.labels.length,
      period: series.labels.length ? series.labels[0] + " ~ " + series.labels[series.labels.length - 1] : "-",
      composition: ticker,
    },
  };
}

// ---------- 통합 포트폴리오 엔진 (공통 타임라인 + 리밸런싱) ----------
function buildLeg(symbol, smaWin) {
  const raw = window.DATA[symbol];
  const dates = [], prices = [];
  for (const [d, p] of raw) { if (p == null) continue; dates.push(parseDate(d)); prices.push(p); }
  const sma = rollingSMA(prices, smaWin);
  const ath = new Array(prices.length);
  let pk = -Infinity;
  for (let i = 0; i < prices.length; i++) { pk = Math.max(pk, prices[i]); ath[i] = pk; }
  return { dates, prices, sma, ath };
}

function runPortfolio(legs, params) {
  const totalW = legs.reduce((s, l) => s + l.weight, 0) || 1;
  const w = legs.map((l) => l.weight / totalW);
  const extra = params.mode === "extra";
  const freq = params.freq || "monthly";
  const B = params.base;
  const rebalOn = params.rebalOn && legs.length >= 2;
  const rebalMode = params.rebalMode || "contrib";
  const rebalPeriod = Math.max(1, params.rebalPeriod || 12);
  const shiftFrac = 0.5;

  const LD = legs.map((l) => buildLeg(l.symbol, params.smaWin));
  let lo = params.startDate ? parseDate(params.startDate) : -Infinity;
  let hi = params.endDate ? parseDate(params.endDate) : Infinity;
  for (const ld of LD) { lo = Math.max(lo, ld.dates[0]); hi = Math.min(hi, ld.dates[ld.dates.length - 1]); }

  const set = new Set();
  for (const ld of LD) for (const d of ld.dates) if (d >= lo && d <= hi) set.add(d);
  const master = [...set].sort((a, b) => a - b);
  const rates = alignRates(master);
  const ptr = LD.map(() => -1);

  const N = legs.length;
  const mSh = Array(N).fill(0), dSh = Array(N).fill(0);
  let reserve = 0, investedM = 0, investedD = 0;
  const flowsM = [], flowsD = [];
  const series = { labels: [], mech: [], dyn: [], contribM: [], contribD: [], mult: [], second: [], reserveAmt: [], effM: [], effD: [], price: [], avgM: [], avgD: [] };
  let started = false, prevKey = null, prevRebalKey = null;
  let maxMech = 0, maxDyn = 0, mddMech = 0, mddDyn = 0, rsvSum = 0, rsvCount = 0;
  let recos = [], recoCash = null;
  const px = Array(N), smaV = Array(N), athV = Array(N);
  // 평단(평균 매입가) 차트용: 합성 가격지수 PI 기준 유닛 누적
  const refPx = new Array(N).fill(null);
  let mUnits = 0, dUnits = 0, spentD = 0, PInow = 1, base = 100;

  for (let i = 0; i < master.length; i++) {
    const t = master[i], dObj = new Date(t);
    for (let k = 0; k < N; k++) {
      const ld = LD[k];
      while (ptr[k] + 1 < ld.dates.length && ld.dates[ptr[k] + 1] <= t) ptr[k]++;
      const j = ptr[k];
      px[k] = ld.prices[j]; smaV[k] = ld.sma[j]; athV[k] = ld.ath[j];
    }
    const rf = 1 + rates[i] / 100 / TRADING_DAYS;
    if (params.rsvInterest && reserve > 0) reserve *= rf;

    const periodKey = freq === "weekly" ? Math.floor(t / (7 * 864e5)) : dObj.getUTCFullYear() * 12 + dObj.getUTCMonth();
    const isContribDay = periodKey !== prevKey;

    if (isContribDay) {
      prevKey = periodKey; started = true;
      investedM += B;
      for (let k = 0; k < N; k++) mSh[k] += (B * w[k]) / px[k];
      flowsM.push({ t, cf: -B });

      const mArr = new Array(N), ddArr = new Array(N), desired = new Array(N);
      let totalDesired = 0;
      for (let k = 0; k < N; k++) {
        let m_ma = 1;
        if (smaV[k] != null) m_ma = 1 + params.k * clamp((smaV[k] - px[k]) / smaV[k], -0.15, 0.30);
        const dd = (athV[k] - px[k]) / athV[k];
        let bonus = dd >= 0.30 ? 2.0 : dd >= 0.20 ? 1.0 : dd >= 0.10 ? 0.5 : 0.0;
        bonus *= params.ddScale;
        mArr[k] = clamp(m_ma + bonus, params.mMin, params.mMax);
        ddArr[k] = dd;
        desired[k] = B * w[k] * mArr[k];
        totalDesired += desired[k];
      }
      const recoInvestTotal = Math.min(totalDesired, B + reserve);
      const actualInvestTotal = extra ? totalDesired : recoInvestTotal;

      // 현재 동적 보유 평가액
      const v = new Array(N); let V = 0;
      for (let k = 0; k < N; k++) { v[k] = dSh[k] * px[k]; V += v[k]; }

      // 이번 회차 매수 분배 (동적)
      const buy = new Array(N).fill(0);
      const distribute = (total, useTarget) => {
        const out = new Array(N).fill(0);
        if (total <= 0) return out;
        if (rebalOn && rebalMode === "contrib") {
          const need = new Array(N); let needSum = 0;
          for (let k = 0; k < N; k++) { need[k] = Math.max(0, w[k] * (V + total) - v[k]); needSum += need[k]; }
          if (needSum > 0) for (let k = 0; k < N; k++) out[k] = total * need[k] / needSum;
          else for (let k = 0; k < N; k++) out[k] = total * w[k];
        } else if (rebalOn && (rebalMode === "trim" || rebalMode === "shift")) {
          for (let k = 0; k < N; k++) out[k] = total * w[k];
        } else {
          for (let k = 0; k < N; k++) out[k] = totalDesired > 0 ? total * desired[k] / totalDesired : total * w[k];
        }
        return out;
      };
      const buyActual = distribute(actualInvestTotal);
      for (let k = 0; k < N; k++) { buy[k] = buyActual[k]; dSh[k] += buy[k] / px[k]; }
      investedD += extra ? actualInvestTotal : B;
      flowsD.push({ t, cf: extra ? -actualInvestTotal : -B });
      reserve += B - recoInvestTotal;

      // 평단: 합성 가격지수(PI) 기준 매입 유닛 누적
      if (refPx[0] == null) { for (let k = 0; k < N; k++) refPx[k] = px[k]; base = N === 1 ? refPx[0] : 100; }
      PInow = 0; for (let k = 0; k < N; k++) PInow += w[k] * px[k] / refPx[k];
      mUnits += B / PInow;                 // 기계식: 매기 B 전액 매수
      spentD += actualInvestTotal;         // 동적: 실제 주식 매수액 누적
      dUnits += actualInvestTotal / PInow;

      // 주기적 리밸런싱 (trim/shift): 보유 자산 재조정 (현금흐름 없음)
      let rebalKey = null;
      if (rebalOn && (rebalMode === "trim" || rebalMode === "shift")) {
        const mk = dObj.getUTCFullYear() * 12 + dObj.getUTCMonth();
        rebalKey = Math.floor(mk / rebalPeriod);
        if (prevRebalKey != null && rebalKey !== prevRebalKey) {
          let V2 = 0; for (let k = 0; k < N; k++) V2 += dSh[k] * px[k];
          for (let k = 0; k < N; k++) {
            const target = w[k] * V2;
            const cur = dSh[k] * px[k];
            const newVal = rebalMode === "trim" ? target : cur + (target - cur) * shiftFrac;
            dSh[k] = newVal / px[k];
          }
        }
        prevRebalKey = rebalKey;
      }

      // 실행 플랜(리저브식): recoInvestTotal 을 분배
      const recoBuy = distribute(recoInvestTotal);
      recos = [];
      for (let k = 0; k < N; k++) recos.push({ symbol: legs[k].symbol, mult: mArr[k], dd: ddArr[k], invest: recoBuy[k] });
      recoCash = { base: B, sgovFlow: B - recoInvestTotal, balance: reserve, date: dObj.toISOString().slice(0, 10) };
    }
    if (!started) continue;

    let mVal = 0, dEq = 0, wMult = 0;
    for (let k = 0; k < N; k++) { mVal += mSh[k] * px[k]; dEq += dSh[k] * px[k]; }
    const dVal = dEq + (extra ? 0 : reserve);
    if (isContribDay) {
      // 가중 평균 매수배수(직전 계산값 재사용)
      for (let k = 0; k < N; k++) { const r = recos[k]; if (r) wMult += w[k] * r.mult; }
      series.labels.push(dObj.toISOString().slice(0, freq === "weekly" ? 10 : 7));
      series.mech.push(mVal); series.dyn.push(dVal);
      series.contribM.push(investedM); series.contribD.push(investedD);
      series.mult.push(wMult); series.reserveAmt.push(extra ? 0 : reserve);
      series.second.push(extra ? (investedM > 0 ? investedD / investedM : 1) : (dVal > 0 ? reserve / dVal : 0));
      series.effM.push(investedM > 0 ? mVal / investedM : 1);
      series.effD.push(investedD > 0 ? dVal / investedD : 1);
      series.price.push(PInow * base);
      series.avgM.push(mUnits > 0 ? investedM / mUnits * base : null);
      series.avgD.push(dUnits > 0 ? spentD / dUnits * base : null);
    }
    maxMech = Math.max(maxMech, mVal); mddMech = Math.max(mddMech, (maxMech - mVal) / maxMech);
    maxDyn = Math.max(maxDyn, dVal); mddDyn = Math.max(mddDyn, (maxDyn - dVal) / maxDyn);
    rsvSum += reserve; rsvCount++;
  }

  const lastPx = px.slice();
  let finalMech = 0, finalDynEq = 0;
  for (let k = 0; k < N; k++) { finalMech += mSh[k] * lastPx[k]; finalDynEq += dSh[k] * lastPx[k]; }
  const finalDyn = finalDynEq + (extra ? 0 : reserve);
  const lastT = master[master.length - 1];
  flowsM.push({ t: lastT, cf: finalMech }); flowsD.push({ t: lastT, cf: finalDyn });

  const legInfo = legs.map((l, k) => ({ symbol: l.symbol, weight: l.weight, targetPct: w[k], finalDyn: dSh[k] * lastPx[k], finalMech: mSh[k] * lastPx[k] }));
  const n = series.labels.length;

  return {
    extra, series, flowsM, flowsD, recos, recoCash, legInfo, singleTicker: N === 1,
    metrics: {
      investedM, investedD, finalMech, finalDyn,
      effMech: finalMech / investedM, effDyn: finalDyn / investedD,
      irrMech: xirr(flowsM), irrDyn: xirr(flowsD),
      mddMech, mddDyn, finalReserve: reserve, avgReserve: rsvCount ? rsvSum / rsvCount : 0,
      months: n, period: n ? series.labels[0] + " ~ " + series.labels[n - 1] : "-",
      composition: legs.length === 1 ? legs[0].symbol : legs.map((l, k) => `${l.symbol} ${(w[k] * 100).toFixed(0)}%`).join(" · "),
    },
  };
}

// ---------- 3년 전망 (역사적 3년 DCA 분포) ----------
function projectFuture(legs, params) {
  const totalW = legs.reduce((s, l) => s + l.weight, 0) || 1;
  const w = legs.map((l) => l.weight / totalW);
  const LD = legs.map((l) => buildLeg(l.symbol, params.smaWin));
  let lo = -Infinity, hi = Infinity;
  for (const ld of LD) { lo = Math.max(lo, ld.dates[0]); hi = Math.min(hi, ld.dates[ld.dates.length - 1]); }
  const set = new Set();
  for (const ld of LD) for (const d of ld.dates) if (d >= lo && d <= hi) set.add(d);
  const master = [...set].sort((a, b) => a - b);

  // 월 첫 거래일마다 종목별 가격 샘플
  const ptr = LD.map(() => -1);
  const months = [], mpx = [];
  let prevMk = null;
  for (const t of master) {
    for (let k = 0; k < legs.length; k++) { const ld = LD[k]; while (ptr[k] + 1 < ld.dates.length && ld.dates[ptr[k] + 1] <= t) ptr[k]++; }
    const dObj = new Date(t), mk = dObj.getUTCFullYear() * 12 + dObj.getUTCMonth();
    if (mk !== prevMk) { prevMk = mk; months.push(t); mpx.push(legs.map((_, k) => LD[k].prices[ptr[k]])); }
  }

  const H = 36; // 3년(36개월)
  if (months.length < H + 6) return null;

  // 롤링 3년 단순 DCA 결과배수 분포
  const mults = [];
  for (let s = 0; s + H < months.length; s++) {
    const sh = new Array(legs.length).fill(0);
    let contributed = 0;
    for (let m = s; m < s + H; m++) {
      contributed += 1;
      for (let k = 0; k < legs.length; k++) sh[k] += (w[k] * 1) / mpx[m][k];
    }
    let val = 0;
    for (let k = 0; k < legs.length; k++) val += sh[k] * mpx[s + H][k];
    mults.push(val / contributed);
  }
  mults.sort((a, b) => a - b);
  const pct = (p) => mults[Math.min(mults.length - 1, Math.max(0, Math.round(p * (mults.length - 1))))];

  const perYear = params.freq === "weekly" ? 52 : 12;
  const contribCount = perYear * 3;
  const futureContrib = params.base * contribCount;
  const scen = (mult) => ({ mult, value: mult * futureContrib, gain: mult * futureContrib - futureContrib, cagr: Math.pow(mult, 1 / 3) - 1 });

  return {
    windows: mults.length,
    contributed: futureContrib,
    bear: scen(pct(0.20)),
    avg: scen(pct(0.50)),
    bull: scen(pct(0.80)),
    worst: scen(mults[0]),
    best: scen(mults[mults.length - 1]),
  };
}

// ---------- 렌더링 ----------
let equityChart, signalChart, effChart, costChart;
function metricCard(k, v, d, cls) {
  return `<div class="card"><div class="k">${k}</div><div class="v ${cls || ""}">${v}</div>${d ? `<div class="d">${d}</div>` : ""}</div>`;
}
function render(res) {
  lastRes = res;
  const m = res.metrics, extra = res.extra;
  const irrEdge = m.irrDyn - m.irrMech;
  const cards = [];
  cards.push(metricCard("구성", m.composition, m.months + "회차 · " + m.period));
  if (extra) cards.push(metricCard("투입 원금", fmtK(m.investedD), `기계식 ${fmtK(m.investedM)} 대비 ${(m.investedD / m.investedM).toFixed(2)}배`));
  else cards.push(metricCard("총 적립 원금", fmtMoney(m.investedM), "기계식·동적 동일"));
  cards.push(metricCard("기계식 IRR", fmtPct(m.irrMech), `최종 ${fmtK(m.finalMech)} · 달러당 ${m.effMech.toFixed(2)}배`));
  cards.push(metricCard("동적 IRR", fmtPct(m.irrDyn), `최종 ${fmtK(m.finalDyn)} · 달러당 ${m.effDyn.toFixed(2)}배`, irrEdge >= 0 ? "pos" : "neg"));
  cards.push(metricCard("IRR 우위 (동적−기계)", fmtPp(irrEdge), extra ? "달러당 수익률 기준" : "총원금 동일 기준", irrEdge >= 0 ? "pos" : "neg"));
  cards.push(metricCard("최대낙폭 MDD", fmtPct(m.mddDyn) + " / " + fmtPct(m.mddMech), "동적 / 기계식"));
  document.getElementById("metrics").innerHTML = cards.join("");

  renderWeights(res);
  renderReco(res);
  renderProjection(res);

  const s = res.series;
  const grid = { color: "#20262e" }, tick = { color: "#8b949e", maxTicksLimit: 10 };
  const eqDatasets = [
    { label: "동적 자산", data: s.dyn, borderColor: "#58a6ff", backgroundColor: "#58a6ff22", borderWidth: 2, pointRadius: 0, fill: true, tension: 0.1 },
    { label: "기계식 자산", data: s.mech, borderColor: "#3fb950", borderWidth: 2, pointRadius: 0, tension: 0.1 },
    { label: "기계식 원금", data: s.contribM, borderColor: "#8b949e", borderWidth: 1, borderDash: [5, 4], pointRadius: 0 },
  ];
  if (extra) eqDatasets.push({ label: "동적 원금", data: s.contribD, borderColor: "#d29922", borderWidth: 1, borderDash: [5, 4], pointRadius: 0 });
  equityChart?.destroy();
  equityChart = new Chart(document.getElementById("equityChart"), {
    type: "line", data: { labels: s.labels, datasets: eqDatasets },
    options: { responsive: true, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "#e6edf3" } }, tooltip: { callbacks: { label: (c) => c.dataset.label + ": " + fmtMoney(c.parsed.y) } } },
      scales: { x: { grid, ticks: tick }, y: { grid, ticks: { color: "#8b949e", callback: (v) => "$" + v / 1000 + "k" } } } },
  });

  const secLabel = extra ? "누적 투입배율 (동적/기계)" : "리저브 비중", secColor = "#f85149";
  signalChart?.destroy();
  signalChart = new Chart(document.getElementById("signalChart"), {
    data: { labels: s.labels, datasets: [
      { type: "bar", label: "매수 배수", data: s.mult, backgroundColor: "#d2992288", borderColor: "#d29922", yAxisID: "y", barPercentage: 1, categoryPercentage: 1 },
      { type: "line", label: secLabel, data: s.second, borderColor: secColor, borderWidth: 1.5, pointRadius: 0, yAxisID: "y1" },
    ] },
    options: { responsive: true, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "#e6edf3" } }, tooltip: { callbacks: { label: (c) => c.dataset.label + ": " + (c.dataset.yAxisID === "y1" ? (extra ? c.parsed.y?.toFixed(2) + "배" : fmtPct(c.parsed.y)) : (c.parsed.y?.toFixed(2) ?? "-") + "배") } } },
      scales: { x: { grid, ticks: tick },
        y: { grid, ticks: { color: "#d29922" }, title: { display: true, text: "매수 배수", color: "#d29922" }, beginAtZero: true },
        y1: { position: "right", grid: { drawOnChartArea: false }, ticks: { color: secColor, callback: (v) => extra ? v.toFixed(1) : (v * 100).toFixed(0) + "%" }, title: { display: true, text: secLabel, color: secColor }, beginAtZero: true } } },
  });

  effChart?.destroy();
  effChart = new Chart(document.getElementById("effChart"), {
    type: "line", data: { labels: s.labels, datasets: [
      { label: "동적 달러효율", data: s.effD, borderColor: "#a371f7", backgroundColor: "#a371f722", borderWidth: 2, pointRadius: 0, fill: true, tension: 0.1 },
      { label: "기계식 달러효율", data: s.effM, borderColor: "#3fb950", borderWidth: 2, pointRadius: 0, tension: 0.1 },
    ] },
    options: { responsive: true, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "#e6edf3" } }, tooltip: { callbacks: { label: (c) => c.dataset.label + ": " + c.parsed.y.toFixed(3) + "배" } } },
      scales: { x: { grid, ticks: tick }, y: { grid, ticks: { color: "#8b949e", callback: (v) => v.toFixed(1) + "x" } } } },
  });

  // 주가 & 평단
  const single = res.singleTicker;
  const priceLabel = single ? `${m.composition} 주가` : "포트폴리오 지수";
  const yFmt = single ? (v) => "$" + Math.round(v) : (v) => v.toFixed(0);
  document.getElementById("costChartTitle").textContent = single ? `주가 & 평단 (${m.composition})` : "포트폴리오 지수 & 평단 (기준=100)";
  costChart?.destroy();
  costChart = new Chart(document.getElementById("costChart"), {
    type: "line",
    data: { labels: s.labels, datasets: [
      { label: priceLabel, data: s.price, borderColor: "#8b949e", borderWidth: 1.5, pointRadius: 0, tension: 0.1 },
      { label: "동적 DCA 평단", data: s.avgD, borderColor: "#58a6ff", backgroundColor: "#58a6ff22", borderWidth: 2, pointRadius: 0, tension: 0.1, fill: false },
      { label: "기계식 평단", data: s.avgM, borderColor: "#3fb950", borderWidth: 2, pointRadius: 0, tension: 0.1 },
    ] },
    options: { responsive: true, interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "#e6edf3" } }, tooltip: { callbacks: { label: (c) => c.dataset.label + ": " + (single ? "$" + c.parsed.y.toFixed(2) : c.parsed.y.toFixed(1)) } } },
      scales: { x: { grid, ticks: tick }, y: { grid, ticks: { color: "#8b949e", callback: yFmt } } } },
  });
}

const WT_PALETTE = ["#58a6ff", "#3fb950", "#d29922", "#a371f7", "#f85149", "#39c5cf", "#db61a2", "#e3b341"];
function renderWeights(res) {
  const el = document.getElementById("weights");
  const info = res.legInfo;
  if (!info || info.length < 2) { el.innerHTML = ""; return; }
  const totDyn = info.reduce((s, l) => s + l.finalDyn, 0) || 1;
  const seg = (w, i, sym, pct) => `<div class="wt-seg" style="width:${(w * 100).toFixed(2)}%;background:${WT_PALETTE[i % WT_PALETTE.length]}" title="${sym} ${(pct * 100).toFixed(1)}%">${w > 0.08 ? sym : ""}</div>`;
  const targetBar = info.map((l, i) => seg(l.targetPct, i, l.symbol, l.targetPct)).join("");
  const curBar = info.map((l, i) => seg(l.finalDyn / totDyn, i, l.symbol, l.finalDyn / totDyn)).join("");
  const rows = info.map((l, i) => {
    const cur = l.finalDyn / totDyn, diff = cur - l.targetPct;
    return `<tr>
      <td><span class="wt-dot" style="background:${WT_PALETTE[i % WT_PALETTE.length]}"></span>${l.symbol}</td>
      <td>${(l.targetPct * 100).toFixed(1)}%</td>
      <td>${(cur * 100).toFixed(1)}%</td>
      <td class="${diff >= 0 ? "wt-over" : "wt-under"}">${diff >= 0 ? "+" : ""}${(diff * 100).toFixed(1)}%p</td>
      <td>${fmtMoney(l.finalDyn)}</td>
    </tr>`;
  }).join("");
  el.innerHTML = `
    <div class="wt-head"><h2>📊 포트폴리오 비중</h2><button class="mini" id="equalW" style="flex:0 0 auto;padding:5px 10px">동일비중으로</button></div>
    <div class="wt-legend">목표 비중 (설정값)</div>
    <div class="wt-bar">${targetBar}</div>
    <div class="wt-legend">현재 평가 비중 (동적 자산 기준) — 목표에서 벗어난 만큼이 리밸런스 대상</div>
    <div class="wt-bar">${curBar}</div>
    <table class="reco-table wt-table">
      <thead><tr><th>종목</th><th>목표비중</th><th>현재비중</th><th>차이(리밸런스)</th><th>평가액</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  const eq = document.getElementById("equalW");
  if (eq) eq.addEventListener("click", () => { legs.forEach((l) => (l.weight = 1)); renderTickerList(); compute(); });
}

function renderReco(res) {
  const el = document.getElementById("reco");
  const recos = res.recos || [];
  const cash = res.recoCash;
  if (!recos.length || !cash) { el.innerHTML = ""; return; }
  const wk = currentFreq === "weekly";
  const perLabel = wk ? "주" : "월";
  const days = wk ? 5 : 21;

  // '배당금만으로 조정' 활성 시 이번 기간 배당 유입액
  const divIn = divAnnualForPlan > 0 ? divAnnualForPlan / (wk ? 52 : 12) : 0;
  const dts = holdings.filter((h) => h.divTarget);          // 배당수령(배당 전용) 지정 종목
  const dtW = dts.reduce((s, h) => s + (h.target || 0), 0);
  const dtShare = (sym) => { const h = dts.find((x) => x.symbol === sym); if (!h) return 0; return dtW > 0 ? (h.target || 0) / dtW : 1 / dts.length; };
  const useTargets = divIn > 0 && dts.length > 0;           // 지정 있으면 그 종목에만 별도 배분
  const baseBuyTot = recos.reduce((s, r) => s + r.invest, 0);
  const divAddFor = (sym, invest) => {
    if (divIn <= 0) return 0;
    if (useTargets) return dtShare(sym) * divIn;            // 배당수령 종목에만 별도 산정
    return baseBuyTot > 0 ? divIn * (invest / baseBuyTot) : divIn / recos.length; // 미지정 폴백: 신호 비례
  };
  const badgeOf = (mult) => mult >= 1.5 ? `<span class="reco-badge badge-fear">적극매수</span>`
    : mult >= 1 ? `<span class="reco-badge badge-buy">매수</span>`
    : `<span class="reco-badge badge-normal">절약</span>`;

  let totBuy = 0;
  const rows = recos.map((r) => {
    const divAdd = divAddFor(r.symbol, r.invest);
    const buy = r.invest + divAdd;
    totBuy += buy;
    return `<tr>
      <td>${r.symbol}</td><td>${badgeOf(r.mult)}</td>
      <td>${r.mult.toFixed(2)}배</td>
      <td>−${(r.dd * 100).toFixed(1)}%</td>
      <td class="buy"><b>${fmtMoney(buy / days)}</b>/일</td>
      <td>${fmtMoney(buy)}${divAdd > 0 ? ` <span class="dep">(배당 +${fmtMoney(divAdd)})</span>` : ""}</td>
    </tr>`;
  }).join("");

  // 배당수령 지정 종목이 전략 종목에 없으면 별도 배당전용 행으로 추가
  const legSyms = new Set(recos.map((r) => r.symbol));
  const extras = [];
  if (useTargets) {
    for (const h of dts) {
      if (legSyms.has(h.symbol)) continue;
      const px = currentPrice(h.symbol); if (px == null) continue;
      const amt = dtShare(h.symbol) * divIn; if (amt <= 0) continue;
      totBuy += amt; extras.push({ symbol: h.symbol, amt });
    }
  }
  const extraRows = extras.map((e) => `<tr>
      <td>${e.symbol}</td><td><span class="reco-badge badge-buy">배당전용</span></td>
      <td>-</td><td>-</td>
      <td class="buy"><b>${fmtMoney(e.amt / days)}</b>/일</td>
      <td><span class="dep">배당 +${fmtMoney(e.amt)}</span></td>
    </tr>`).join("");

  const sgovDeposit = cash.sgovFlow >= 0;
  const sgovLabel = sgovDeposit ? "SGOV 예치" : "SGOV 인출";
  const sgovVal = sgovDeposit ? `<span class="dep">+${fmtMoney(cash.sgovFlow)}</span>` : `<span class="wd">−${fmtMoney(-cash.sgovFlow)}</span>`;
  const buyLines = recos.map((r) => `${r.symbol} <b class="buy">${fmtMoney((r.invest + divAddFor(r.symbol, r.invest)) / days)}</b>/일`)
    .concat(extras.map((e) => `${e.symbol} <b class="buy">${fmtMoney(e.amt / days)}</b>/일`)).join(" · ");
  const inflow = fmtMoney(cash.base) + (divIn > 0 ? ` <span class="dep">+ 배당 ${fmtMoney(divIn)}</span>` : "");
  const divNote = divIn > 0 ? (useTargets ? ` (배당 ${fmtMoney(divIn)}은 배당수령 종목 ${dts.map((h) => h.symbol).join(", ")}에 별도 투입)` : " (배당은 신호 강한 종목에 우선)") : "";
  const divStep = divIn > 0 ? `
      <div class="flow-step"><span class="flow-k">배당 유입 (${perLabel})${useTargets ? " → " + dts.map((h) => h.symbol).join(", ") : ""}</span><span class="flow-v"><span class="dep">+${fmtMoney(divIn)}</span></span></div>
      <div class="flow-arrow">→</div>` : "";

  el.innerHTML = `
    <h2>📌 실행 플랜</h2>
    <div class="reco-sub">최신 신호(${cash.date}) 기준 · ${perLabel} 적립금 ${inflow} → 최적 효율로 배분${divNote}</div>
    <div class="reco-flow">
      <div class="flow-step"><span class="flow-k">${perLabel} 적립금</span><span class="flow-v">${fmtMoney(cash.base)}</span></div>
      <div class="flow-arrow">→</div>
      ${divStep}
      <div class="flow-step"><span class="flow-k">${sgovLabel} (잔고 ${fmtMoney(cash.balance)})</span><span class="flow-v">${sgovVal}</span></div>
      <div class="flow-arrow">→</div>
      <div class="flow-step wide"><span class="flow-k">매일 매수 (약 ${days}거래일)</span><span class="flow-v">${buyLines}</span></div>
    </div>
    <table class="reco-table">
      <thead><tr>
        <th>종목</th><th>신호</th><th>매수배수</th><th>전고점대비</th>
        <th>매일 매수액</th><th>${perLabel}간 총매수</th>
      </tr></thead>
      <tbody>${rows}${extraRows}</tbody>
      <tfoot><tr>
        <td>합계</td><td></td><td></td><td></td>
        <td class="buy"><b>${fmtMoney(totBuy / days)}</b>/일</td><td>${fmtMoney(totBuy)}</td>
      </tr></tfoot>
    </table>`;
}

function renderProjection(res) {
  const el = document.getElementById("projection");
  const p = res.projection;
  if (!p) { el.innerHTML = ""; return; }
  const col = (title, cls, sc) => `
    <div class="proj-col ${cls}">
      <div class="proj-title">${title}</div>
      <div class="proj-val">${fmtMoney(sc.value)}</div>
      <div class="proj-d">손익 ${sc.gain >= 0 ? "+" : ""}${fmtMoney(sc.gain)} (${sc.gain >= 0 ? "+" : ""}${((sc.value / p.contributed - 1) * 100).toFixed(0)}%)</div>
      <div class="proj-d">연 ${(sc.cagr * 100).toFixed(1)}%</div>
    </div>`;
  el.innerHTML = `
    <div class="wt-head"><h2>🔮 신규 진입 3년 전망</h2><span class="legend-hint">지금부터 3년 적립 시 · 역사적 3년 DCA ${p.windows}개 구간 분포</span></div>
    <div class="proj-sub">3년간 총 ${fmtMoney(p.contributed)} 적립 가정 · 과거 데이터 기반 시나리오 (미래 수익 보장 아님)</div>
    <div class="proj-grid">
      ${col("📉 하락장 (하위 20%)", "proj-bear", p.bear)}
      ${col("➖ 평균 (중앙값)", "proj-avg", p.avg)}
      ${col("📈 상승장 (상위 20%)", "proj-bull", p.bull)}
    </div>
    <div class="proj-sub">참고 범위: 역대 최악 ${fmtMoney(p.worst.value)} ~ 최고 ${fmtMoney(p.best.value)}</div>`;
}

// ---------- 내 현재 포트폴리오 (보유 + 평단 + 도넛 + 조정) ----------
let holdings = [
  { symbol: "QQQ", qty: 10, avg: 400, target: 50 },
  { symbol: "VOO", qty: 15, avg: 350, target: 50 },
];
let donutChart;

function currentPrice(sym) {
  const d = window.DATA && window.DATA[sym];
  return d && d.length ? d[d.length - 1][1] : null;
}

function renderHoldRows() {
  const tb = document.getElementById("holdBody");
  tb.innerHTML = holdings.map((h, i) => `
    <tr data-i="${i}">
      <td class="sym">${h.symbol}</td>
      <td><input class="hq" type="number" min="0" step="1" value="${h.qty}" data-i="${i}"/></td>
      <td><input class="ha" type="number" min="0" step="0.01" value="${h.avg}" data-i="${i}"/></td>
      <td class="px">-</td><td class="val">-</td><td class="wt">-</td><td class="pl">-</td>
      <td><input class="ht" type="number" min="0" step="1" value="${h.target}" data-i="${i}"/></td>
      <td><input class="hd" type="checkbox" data-i="${i}" ${h.divTarget ? "checked" : ""} ${(document.getElementById("hrMode") || {}).value === "div" ? "" : "disabled"} title="'배당금만으로 조정' 모드에서만 사용"/></td>
      <td><button class="rm" data-i="${i}">×</button></td>
    </tr>`).join("");
  tb.querySelectorAll(".hq").forEach((el) => el.addEventListener("input", () => { holdings[+el.dataset.i].qty = Math.max(0, +el.value || 0); updateMyPort(); }));
  tb.querySelectorAll(".ha").forEach((el) => el.addEventListener("input", () => { holdings[+el.dataset.i].avg = Math.max(0, +el.value || 0); updateMyPort(); }));
  tb.querySelectorAll(".ht").forEach((el) => el.addEventListener("input", () => { holdings[+el.dataset.i].target = Math.max(0, +el.value || 0); updateMyPort(); }));
  tb.querySelectorAll(".hd").forEach((el) => el.addEventListener("change", () => { holdings[+el.dataset.i].divTarget = el.checked; updateMyPort(); }));
  tb.querySelectorAll(".rm").forEach((b) => b.addEventListener("click", () => { holdings.splice(+b.dataset.i, 1); renderHoldRows(); updateMyPort(); }));
}

function updateMyPort() {
  const items = holdings.map((h) => {
    const px = currentPrice(h.symbol);
    return { ...h, px, val: px != null ? h.qty * px : 0, cost: h.qty * h.avg };
  });
  const totVal = items.reduce((s, x) => s + x.val, 0);
  const totCost = items.reduce((s, x) => s + x.cost, 0);
  let totW = items.reduce((s, x) => s + x.target, 0);
  const useEqual = totW <= 0;

  // 행별 계산 셀 업데이트
  document.querySelectorAll("#holdBody tr").forEach((tr) => {
    const i = +tr.dataset.i, x = items[i];
    const set = (cls, html) => { const c = tr.querySelector(cls); if (c) c.innerHTML = html; };
    if (!x || x.px == null) { set(".px", "<span class='status-err'>미로드</span>"); set(".val", "-"); set(".wt", "-"); set(".pl", "-"); return; }
    set(".px", fmtMoney(x.px));
    set(".val", fmtMoney(x.val));
    set(".wt", totVal > 0 ? (x.val / totVal * 100).toFixed(1) + "%" : "-");
    if (x.avg > 0 && x.cost > 0) {
      const pl = x.val - x.cost, plp = pl / x.cost * 100;
      set(".pl", `<span class="${pl >= 0 ? "buy" : "wd"}">${pl >= 0 ? "+" : ""}${plp.toFixed(1)}%</span>`);
    } else set(".pl", "-");
  });

  // 요약
  const pl = totVal - totCost;
  document.getElementById("holdSummary").innerHTML =
    `<div>총 평가액 <b>${fmtMoney(totVal)}</b></div>` +
    (totCost > 0 ? `<div>총 원금 <b>${fmtMoney(totCost)}</b></div><div>평가손익 <b class="${pl >= 0 ? "buy" : "wd"}">${pl >= 0 ? "+" : ""}${fmtMoney(pl)} (${(pl / totCost * 100).toFixed(1)}%)</b></div>` : "");

  // 도넛
  const shown = items.filter((x) => x.val > 0);
  const ctx = document.getElementById("donut");
  donutChart?.destroy();
  if (shown.length && ctx) {
    donutChart = new Chart(ctx, {
      type: "doughnut",
      data: { labels: shown.map((x) => x.symbol), datasets: [{ data: shown.map((x) => x.val), backgroundColor: shown.map((_, i) => WT_PALETTE[i % WT_PALETTE.length]), borderColor: "#0d1117", borderWidth: 2 }] },
      options: { cutout: "62%", plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${fmtMoney(c.parsed)} (${(c.parsed / totVal * 100).toFixed(1)}%)` } } } },
    });
    document.getElementById("donutLegend").innerHTML = shown.map((x, i) => `
      <div class="dl-row"><div class="dl-left"><span class="dl-dot" style="background:${WT_PALETTE[i % WT_PALETTE.length]}"></span>${x.symbol}</div><div>${(x.val / totVal * 100).toFixed(1)}%</div></div>`).join("");
  } else {
    document.getElementById("donutLegend").innerHTML = "<div class='proj-sub'>수량을 입력하면 도넛이 표시됩니다.</div>";
  }

  // 연 배당 합계
  let annualTot = 0;
  for (const x of items) { if (x.px != null && x.qty > 0) { const d = divInfo(x.symbol); if (d.has) annualTot += x.qty * d.annual; } }

  // 조정안
  renderRebalPlan(items, totVal, useEqual, annualTot);
  // 배당 & 재투자 (정보)
  renderDividends(items, totVal, annualTot);

  // '배당금만으로 조정' 활성 시 → 실행 플랜에 배당 유입 합산
  const hrMode = (document.getElementById("hrMode") || {}).value;
  divAnnualForPlan = (hrMode === "div" && annualTot > 0) ? annualTot : 0;
  if (lastRes) renderReco(lastRes);
}

// '배당금만으로 조정' — 목표 비중으로 조정 섹션에 표시되는 배당 재투자 플랜 + 도달 시간
function renderDivPlan(el, items, valid, totVal, useEqual, annualTot) {
  const targets = items.filter((x) => x.divTarget && x.px != null);
  let planRows, note;
  if (targets.length) {
    const tw = targets.reduce((s, x) => s + (x.target || 0), 0);
    planRows = targets.map((x) => {
      const share = tw > 0 ? (x.target / tw) : 1 / targets.length;
      const amt = annualTot * share;
      return `<tr><td class="sym">${x.symbol}</td>
        <td>${totVal > 0 ? (x.val / totVal * 100).toFixed(1) : "0.0"}%</td>
        <td>배당전용</td><td class="buy">+${fmtMoney(amt)}</td><td>+${(amt / x.px).toFixed(2)}주</td></tr>`;
    }).join("");
    note = `연 배당 <b>${fmtMoney(annualTot)}</b> 전액을 <b>${targets.map((x) => x.symbol).join(", ")}</b>${targets.length > 1 ? " (목표% 비율)" : ""} 매수에 사용`;
  } else {
    const totW = useEqual ? valid.length : valid.reduce((s, x) => s + x.target, 0) || valid.length;
    const wOf = (x) => useEqual || totW === valid.length ? 1 / valid.length : (x.target / totW);
    const newV = totVal + annualTot;
    const need = valid.map((x) => Math.max(0, wOf(x) * newV - x.val));
    const needSum = need.reduce((s, v) => s + v, 0);
    planRows = valid.map((x, i) => {
      const amt = needSum > 0 ? annualTot * need[i] / needSum : annualTot * wOf(x);
      return `<tr><td class="sym">${x.symbol}</td>
        <td>${(x.val / totVal * 100).toFixed(1)}%</td>
        <td>${(wOf(x) * 100).toFixed(1)}%</td>
        <td class="buy">+${fmtMoney(amt)}</td><td>+${(amt / x.px).toFixed(2)}주</td></tr>`;
    }).join("");
    note = `연 배당 <b>${fmtMoney(annualTot)}</b>을 목표 비중 맞춰 저비중 종목에 재투자. 특정 종목에만 몰아주려면 위 표에서 <b>배당수령</b>을 체크하세요.`;
  }

  // 도달 시간
  const allT = items.filter((x) => x.px != null);
  const sumTgt = allT.reduce((s, x) => s + (x.target || 0), 0);
  const wAll = (x) => (sumTgt > 0 ? (x.target || 0) / sumTgt : 1 / allT.length);
  let years, timeNote, extraNote = "";
  if (annualTot <= 0) { years = Infinity; timeNote = "배당이 없어 도달 불가"; }
  else if (targets.length) {
    const Wt = targets.reduce((s, x) => s + wAll(x), 0);
    const Vt = targets.reduce((s, x) => s + x.val, 0);
    years = Wt >= 1 ? 0 : Math.max(0, (Wt * totVal - Vt) / (annualTot * (1 - Wt)));
    timeNote = `배당수령 종목(${targets.map((x) => x.symbol).join(", ")}) 비중이 목표(${(Wt * 100).toFixed(0)}%)에 도달`;
  } else {
    let vFin = totVal;
    for (const x of allT) { const w = wAll(x); if (w > 0) vFin = Math.max(vFin, x.val / w); }
    const needCash = Math.max(0, vFin - totVal);
    years = needCash / annualTot;
    timeNote = "저비중 종목이 목표 비중에 도달 (매도 없이 배당만)";
    if (needCash > 0) extraNote = ` · 필요 누적배당 ${fmtMoney(needCash)}`;
  }

  el.innerHTML = `
    <div class="div-eta">
      <span class="eta-k">⏳ 배당금만으로 목표 비중 도달</span>
      <span class="eta-v">${fmtDur(years)}</span>
      <span class="eta-note">${timeNote}${extraNote}<br>(현재가·현재 연배당 ${fmtMoney(annualTot)} 고정 가정, 배당 성장·복리 미반영)</span>
    </div>
    <div class="proj-sub">${note}</div>
    <table class="reco-table">
      <thead><tr><th>종목</th><th>현재비중</th><th>${targets.length ? "구분" : "목표비중"}</th><th>배당 재투자 배분</th><th>주수</th></tr></thead>
      <tbody>${planRows}</tbody>
      <tfoot><tr><td>합계</td><td></td><td></td><td class="buy">+${fmtMoney(annualTot)}</td><td></td></tr></tfoot>
    </table>`;
}

// 배당 정보(주기·배당률·내 배당) — 항상 표시되는 참고 패널
function renderDividends(items, totVal, annualTot) {
  const el = document.getElementById("divPanel");
  const info = items.filter((x) => x.px != null && x.qty > 0).map((x) => ({ x, d: divInfo(x.symbol) })).filter((r) => r.d.has);
  if (!info.length) { el.innerHTML = ""; return; }
  const fmt2 = (v) => "$" + v.toFixed(2);
  const rows = info.map(({ x, d }) => `<tr>
      <td class="sym">${x.symbol}</td>
      <td>${d.label}</td>
      <td>${fmt2(d.perShare)}/주</td>
      <td>${fmt2(x.qty * d.perShare)}</td>
      <td class="buy">${fmtMoney(x.qty * d.annual)}</td>
      <td>${(d.yield * 100).toFixed(2)}%</td>
    </tr>`).join("");
  const annualYield = totVal > 0 ? annualTot / totVal : 0;
  el.innerHTML = `
    <div class="wt-head"><h3 style="margin:0;font-size:14px">💵 배당 정보</h3>
      <span class="legend-hint">연 배당 합계 ${fmtMoney(annualTot)} · 포트폴리오 배당률 ${(annualYield * 100).toFixed(2)}% · 재투자 플랜은 위 '목표 비중으로 조정'에서 <b>배당금만으로 조정</b> 선택</span></div>
    <table class="reco-table">
      <thead><tr><th>종목</th><th>지급주기</th><th>회당(주당)</th><th>내 회당 배당</th><th>내 연 배당</th><th>배당률</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderRebalPlan(items, totVal, useEqual, annualTot) {
  const el = document.getElementById("rebalPlan");
  const valid = items.filter((x) => x.px != null);
  if (!valid.length || totVal <= 0) { el.innerHTML = "<div class='proj-sub'>보유 수량·평단을 입력하세요.</div>"; return; }
  const totW = useEqual ? valid.length : valid.reduce((s, x) => s + x.target, 0);
  const wOf = (x) => useEqual ? 1 / valid.length : (x.target / totW);
  const mode = document.getElementById("hrMode").value;
  const cash = Math.max(0, +document.getElementById("hrCash").value || 0);

  // 배당금만으로 조정 (배당 재투자)
  if (mode === "div") { renderDivPlan(el, items, valid, totVal, useEqual, annualTot || 0); return; }

  let plan = [];
  if (mode === "contrib") {
    const newV = totVal + cash;
    const need = valid.map((x) => Math.max(0, wOf(x) * newV - x.val));
    const needSum = need.reduce((s, v) => s + v, 0);
    plan = valid.map((x, i) => ({ x, amt: needSum > 0 ? cash * need[i] / needSum : cash * wOf(x) }));
  } else {
    const f = mode === "shift" ? 0.5 : 1;
    plan = valid.map((x) => ({ x, amt: (wOf(x) * totVal - x.val) * f }));
  }

  const rows = plan.map(({ x, amt }) => {
    const cur = x.val / totVal, tgt = wOf(x);
    const shares = amt / x.px;
    const act = Math.abs(amt) < 0.5 ? `<span class="status-ok">유지</span>`
      : amt > 0 ? `<span class="buy">매수 +${fmtMoney(amt)}</span>`
      : `<span class="wd">매도 −${fmtMoney(-amt)}</span>`;
    const sh = Math.abs(amt) < 0.5 ? "-" : `${amt > 0 ? "+" : "−"}${Math.abs(shares).toFixed(2)}주`;
    return `<tr>
      <td class="sym">${x.symbol}</td>
      <td>${(cur * 100).toFixed(1)}%</td>
      <td>${(tgt * 100).toFixed(1)}%</td>
      <td>${act}</td>
      <td>${sh}</td>
    </tr>`;
  }).join("");
  const totBuy = plan.reduce((s, p) => s + Math.max(0, p.amt), 0);
  const totSell = plan.reduce((s, p) => s + Math.max(0, -p.amt), 0);
  const note = mode === "contrib" ? `신규 투입 ${fmtMoney(cash)}을 저비중 종목에 배분 (매도 없음)` :
    mode === "shift" ? "목표와의 격차를 50%만 좁힘 (부분 조정)" : "초과분 매도→목표 비중 완전 복원";
  el.innerHTML = `
    <div class="proj-sub">${note}</div>
    <table class="reco-table">
      <thead><tr><th>종목</th><th>현재비중</th><th>목표비중</th><th>조정</th><th>주수</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>합계</td><td></td><td></td><td><span class="buy">매수 ${fmtMoney(totBuy)}</span> / <span class="wd">매도 ${fmtMoney(totSell)}</span></td><td></td></tr></tfoot>
    </table>`;
}

async function addHolding(str) {
  const syms = str.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const status = document.getElementById("holdStatus");
  for (const sym of syms) {
    if (holdings.some((h) => h.symbol === sym)) { status.innerHTML = `<span class="status-err">${sym} 이미 있음</span>`; continue; }
    status.innerHTML = `<span class="status-ok">${sym} 불러오는 중…</span>`;
    const r = await loadSymbol(sym);
    if (r.ok) { holdings.push({ symbol: r.key, qty: 0, avg: 0, target: 0 }); status.innerHTML = `<span class="status-ok">${r.key} 추가됨 (${r.name})</span>`; }
    else { status.innerHTML = `<span class="status-err">${sym} 실패: ${r.error} — 로컬 file://은 사전저장 티커만</span>`; }
  }
  document.getElementById("holdInput").value = "";
  renderHoldRows(); updateMyPort();
}

// ---------- 상태 & 컨트롤 ----------
let legs = [{ symbol: "QQQ", name: NAMES.QQQ, weight: 1 }];
let currentMode = "extra";
let currentFreq = "monthly";
let divAnnualForPlan = 0; // '배당금만으로 조정' 활성 시 실행 플랜에 합산할 연 배당액
let lastRes = null;       // 최근 백테스트 결과 (실행 플랜 재렌더용)

function readParams() {
  return {
    base: Math.max(1, +document.getElementById("baseAmt").value || 1000),
    smaWin: +document.getElementById("smaWin").value,
    k: +document.getElementById("kDev").value,
    ddScale: +document.getElementById("ddScale").value,
    mMax: +document.getElementById("mMax").value,
    mMin: +document.getElementById("mMin").value,
    rsvInterest: document.getElementById("rsvInterest").checked,
    startDate: document.getElementById("startSel").value || null,
    endDate: document.getElementById("endSel").value || null,
    mode: currentMode,
    freq: currentFreq,
    rebalOn: document.getElementById("rebalOn").checked,
    rebalMode: document.getElementById("rebalMode").value,
    rebalPeriod: +document.getElementById("rebalPeriod").value || 12,
  };
}

async function compute() {
  if (!legs.length) { document.getElementById("metrics").innerHTML = metricCard("종목 없음", "티커를 추가하세요", ""); return; }
  await ensureRates();
  const params = readParams();
  const res = runPortfolio(legs, params);
  res.projection = projectFuture(legs, params);
  render(res);
}

function updatePct() {
  const total = legs.reduce((s, l) => s + l.weight, 0) || 1;
  document.querySelectorAll("#tickerList .tk-row").forEach((row, i) => {
    const pct = row.querySelector(".pct");
    if (pct && legs[i]) pct.textContent = (legs[i].weight / total * 100).toFixed(0) + "%";
  });
}
function renderTickerList() {
  const el = document.getElementById("tickerList");
  const total = legs.reduce((s, l) => s + l.weight, 0) || 1;
  el.innerHTML = legs.map((l, i) => `
    <div class="tk-row">
      <span class="sym">${l.symbol}</span>
      <span class="nm" title="${l.name || ""}">${l.name || ""}</span>
      ${legs.length > 1 ? `<input class="w" type="number" min="0" step="1" value="${l.weight}" data-i="${i}"/><span class="pct">${(l.weight / total * 100).toFixed(0)}%</span>` : ""}
      <button class="rm" data-i="${i}" title="삭제">×</button>
    </div>`).join("");
  el.querySelectorAll("input.w").forEach((inp) => inp.addEventListener("input", () => {
    legs[+inp.dataset.i].weight = Math.max(0, +inp.value || 0); updatePct(); compute();
  }));
  el.querySelectorAll(".rm").forEach((b) => b.addEventListener("click", () => {
    legs.splice(+b.dataset.i, 1); refreshDateBounds(false); renderTickerList(); compute();
  }));
}

async function addTickers(str) {
  const syms = str.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const status = document.getElementById("tickerStatus");
  for (const sym of syms) {
    if (legs.some((l) => l.symbol === sym)) { status.innerHTML = `<span class="status-err">${sym} 이미 추가됨</span>`; continue; }
    status.innerHTML = `<span class="status-ok">${sym} 불러오는 중…</span>`;
    const r = await loadSymbol(sym);
    if (r.ok) { legs.push({ symbol: r.key, name: r.name, weight: 1 }); status.innerHTML = `<span class="status-ok">${r.key} 추가됨 (${r.name})</span>`; }
    else { status.innerHTML = `<span class="status-err">${sym} 실패: ${r.error} — 로컬 file://에선 사전 저장된 티커만 가능 (vercel dev 또는 배포 필요)</span>`; }
  }
  document.getElementById("tickerInput").value = "";
  refreshDateBounds(false); renderTickerList(); compute();
}

function minusYears(dateStr, years) { const d = new Date(parseDate(dateStr)); d.setUTCFullYear(d.getUTCFullYear() - years); return d.toISOString().slice(0, 10); }
function clampDate(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function portfolioBounds() {
  let first = "0000-00-00", last = "9999-99-99";
  for (const l of legs) { const d = window.DATA[l.symbol]; if (!d) continue; if (d[0][0] > first) first = d[0][0]; if (d[d.length - 1][0] < last) last = d[d.length - 1][0]; }
  return { first, last };
}
function refreshDateBounds(resetToFull) {
  if (!legs.length) return;
  const { first, last } = portfolioBounds();
  const st = document.getElementById("startSel"), en = document.getElementById("endSel");
  st.min = first; st.max = last; en.min = first; en.max = last;
  if (resetToFull || !st.value) st.value = first;
  if (resetToFull || !en.value) en.value = last;
  st.value = clampDate(st.value, first, last);
  en.value = clampDate(en.value, first, last);
  if (st.value > en.value) st.value = first;
  updateRangeHint();
}
function updateRangeHint() {
  const st = document.getElementById("startSel").value, en = document.getElementById("endSel").value;
  if (!st || !en) return;
  const yrs = (parseDate(en) - parseDate(st)) / (365.25 * 864e5);
  document.getElementById("rangeHint").textContent = `${st} ~ ${en} (${yrs.toFixed(1)}년)`;
}
function applyPreset(preset) {
  const { first, last } = portfolioBounds();
  const st = document.getElementById("startSel"), en = document.getElementById("endSel");
  en.value = last;
  st.value = preset === "all" ? first : clampDate(minusYears(last, preset === "10y" ? 10 : 5), first, last);
  updateRangeHint(); compute();
}

function bindLive(id, valId, fmt) {
  const el = document.getElementById(id), out = document.getElementById(valId);
  el.addEventListener("input", () => { out.textContent = fmt(el.value); compute(); });
}
function updateFreqLabel() {
  const wk = currentFreq === "weekly";
  document.getElementById("baseLabel").textContent = (wk ? "주" : "월") + " 적립금 (기본 B)";
  document.getElementById("baseUnit").textContent = "$/" + (wk ? "주" : "월");
}
function updateRebalUI() {
  const on = document.getElementById("rebalOn").checked;
  const mode = document.getElementById("rebalMode").value;
  document.getElementById("rebalOpts").style.display = on ? "block" : "none";
  document.getElementById("rebalPeriodWrap").style.display = (mode === "trim" || mode === "shift") ? "flex" : "none";
  const hints = {
    contrib: "매도 없이 신규 적립금을 저비중 종목에 우선 배분해 목표에 근접시킵니다.",
    trim: "지정 주기마다 초과 비중을 매도해 목표 비중으로 완전 복원합니다(이득 실현).",
    shift: "지정 주기마다 목표와의 격차를 절반만큼 좁혀 점진적으로 이동합니다.",
  };
  document.getElementById("rebalHint").textContent = hints[mode] || "";
}
function updateModeHint() {
  document.getElementById("modeHint").textContent = currentMode === "extra"
    ? "하락 시 여유자금을 추가 투입 · 원금이 달라져 IRR로 비교"
    : "총원금 동일 · 남는 현금은 SGOV(국채) 이자로 운용";
  document.getElementById("rsvInterest").parentElement.parentElement.style.opacity = currentMode === "extra" ? 0.4 : 1;
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("dataNote").innerHTML =
    "데이터: Yahoo Finance (adjClose 총수익). 리저브 이자=13주 국채(^IRX). 로컬 file://은 사전저장 티커만, 임의 티커는 <code>vercel dev</code>/배포 필요.";

  document.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#modeSeg button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active"); currentMode = b.dataset.mode; updateModeHint(); compute();
  }));
  document.querySelectorAll("#freqSeg button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("#freqSeg button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active"); currentFreq = b.dataset.freq; updateFreqLabel(); compute();
  }));
  document.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => applyPreset(b.dataset.preset)));
  document.querySelectorAll("[data-quick]").forEach((b) => b.addEventListener("click", () => addTickers(b.dataset.quick)));
  document.getElementById("addTicker").addEventListener("click", () => addTickers(document.getElementById("tickerInput").value));
  document.getElementById("tickerInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addTickers(e.target.value); });

  bindLive("smaWin", "smaVal", (v) => v);
  bindLive("kDev", "kVal", (v) => (+v).toFixed(1));
  bindLive("ddScale", "ddVal", (v) => (+v).toFixed(2));
  bindLive("mMax", "mmaxVal", (v) => (+v).toFixed(1));
  bindLive("mMin", "mminVal", (v) => (+v).toFixed(1));
  document.getElementById("rsvInterest").addEventListener("change", compute);
  document.getElementById("baseAmt").addEventListener("change", compute);
  document.getElementById("rebalOn").addEventListener("change", () => { updateRebalUI(); compute(); });
  document.getElementById("rebalMode").addEventListener("change", () => { updateRebalUI(); compute(); });
  document.getElementById("rebalPeriod").addEventListener("change", compute);
  document.getElementById("startSel").addEventListener("change", () => { updateRangeHint(); compute(); });
  document.getElementById("endSel").addEventListener("change", () => { updateRangeHint(); compute(); });
  document.getElementById("runBtn").addEventListener("click", compute);

  // 내 현재 포트폴리오 이벤트
  document.getElementById("addHold").addEventListener("click", () => addHolding(document.getElementById("holdInput").value));
  document.getElementById("holdInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addHolding(e.target.value); });
  document.getElementById("hrMode").addEventListener("change", () => {
    document.getElementById("hrCashWrap").style.display = document.getElementById("hrMode").value === "contrib" ? "flex" : "none";
    renderHoldRows(); // 배당수령 체크박스 활성/비활성 갱신
    updateMyPort();
  });
  document.getElementById("hrCash").addEventListener("input", updateMyPort);
  document.getElementById("tgtEqual").addEventListener("click", () => { holdings.forEach((h) => (h.target = 1)); renderHoldRows(); updateMyPort(); });
  document.getElementById("tgtStrategy").addEventListener("click", () => {
    const totW = legs.reduce((s, l) => s + l.weight, 0) || 1;
    holdings.forEach((h) => { const leg = legs.find((l) => l.symbol === h.symbol); h.target = leg ? Math.round(leg.weight / totW * 100) : 0; });
    renderHoldRows(); updateMyPort();
  });

  await loadSymbol("QQQ");
  await loadSymbol("VOO");
  legs[0].name = NAMES.QQQ;
  renderTickerList();
  refreshDateBounds(true);
  updateModeHint();
  updateFreqLabel();
  updateRebalUI();
  renderHoldRows();
  updateMyPort();
  compute();
});
