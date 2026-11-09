// BTC Edge Lab: rebuilds past 15-minute windows from Polymarket US's BRTI history,
// tunes the model on older data, confirms on newer data, and tests patterns.
(() => {
  const US = "https://gateway.polymarket.us";
  const DATA_KEY = "brti1m", RESULT_KEY = "labResult";
  const DAYS = 30, CHUNK = 3540 * 60, WIN = 900, CHECK_K = 5;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toSec = (d) => {
    if (d == null || d === "") return null;
    if (/^\d+(\.\d+)?$/.test(String(d))) { const x = Number(d); return x > 1e12 ? x / 1000 : x; }
    const t = Date.parse(d); return Number.isFinite(t) ? t / 1000 : null;
  };
  const clampP = (p) => Math.min(0.999, Math.max(0.001, p));
  function tcdf4(z) { const t = z * Math.SQRT2, u = 1 + t * t / 4; return 0.5 + 0.375 * (t / Math.sqrt(u)) * (1 - t * t / (12 * u)); }
  function invT(p) {                     // inverse of tcdf4 by bisection
    p = clampP(p); let lo = -12, hi = 12;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (tcdf4(m) < p) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }

  // ---------- data ----------
  // closes[i] = BRTI close of the 1-minute candle starting at start + 60*i (null if missing).
  let data = store.get(DATA_KEY, null);
  let windows = null;

  function parse(j) {
    const s = ((j && j.series) || [])[0];
    return ((s && s.candles) || []).map((c) => [toSec(c.timestamp), Number(c.close)]).filter((x) => x[0] != null && x[1] > 0);
  }
  async function fetchChunk(from, to) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let r = null;
      try { r = await fetch(`/api/history?from=${from}&to=${to}`, { cache: "no-store" }); } catch {}
      if (r && r.ok) return parse(await r.json());
      if (r && r.status === 429) { await sleep((Number(r.headers.get("retry-after")) || 10) * 1000 + 1000); continue; }
      try {   // server couldn't reach it: try straight from the phone
        const d = await fetch(`${US}/v1/asset-prices/history?assets=crypto:btc&from=${from}&to=${to}&bucket=ASSET_PRICE_BUCKET_1M`, { cache: "no-store" });
        if (d.ok) return parse(await d.json());
        if (d.status === 429) { await sleep(11000); continue; }
      } catch {}
      await sleep(2500);
    }
    throw new Error("Couldn't load price history from Polymarket US.");
  }

  async function update(onProgress) {
    const now = Math.floor(Date.now() / 60000) * 60;
    const want = now - DAYS * 86400;
    let start = data ? data.start : want, closes = data ? data.closes.slice() : [];
    if (start > want + 3600) { start = want; closes = []; }              // too short: rebuild
    if (start < want) { const drop = Math.floor((want - start) / 60); closes = closes.slice(drop); start += drop * 60; }
    while (closes.length && closes[closes.length - 1] == null) closes.pop(); // refetch unpublished tail
    let from = start + closes.length * 60;
    const chunks = Math.max(1, Math.ceil((now - from) / CHUNK));
    let done = 0;
    while (from < now - 60) {
      const to = Math.min(now, from + CHUNK);
      const rows = await fetchChunk(from, to);
      const byMin = new Map(rows.map(([t, c]) => [Math.round(t / 60) * 60, c]));
      for (let t = from; t < to; t += 60) closes.push(byMin.has(t) ? byMin.get(t) : null);
      from = to; done++;
      data = { start, closes };
      store.set(DATA_KEY, data);
      onProgress && onProgress(Math.min(1, done / chunks));
      if (from < now - 60) await sleep(4000);   // go easy so live odds keep getting through
    }
    data = { start, closes };
    store.set(DATA_KEY, data);
    windows = null;
    return data;
  }

  // ---------- rebuild past windows ----------
  const hourFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", weekday: "short", timeZone: "America/New_York" });
  function buildWindows() {
    if (windows) return windows;
    windows = [];
    if (!data || !data.closes.length) return windows;
    const { start, closes } = data, n = closes.length;
    const at = (T) => { const i = (T - 60 - start) / 60; return i >= 0 && i < n ? closes[i] : null; };
    const firstWs = Math.ceil((start + 3720) / WIN) * WIN;
    const lastWs = Math.floor((start + n * 60) / WIN) * WIN - WIN;
    for (let ws = firstWs; ws <= lastWs; ws += WIN) {
      const we = ws + WIN;
      const a = at(ws - 60), b = at(ws), c = at(we - 60), d = at(we);
      if (a == null || b == null || c == null || d == null) continue;
      const ptb = (a + b) / 2, close = (c + d) / 2;        // open and close are 60-second averages
      let ss = 0, cnt = 0;
      for (let k = 1; k <= 60; k++) {
        const p = at(ws - 60 * k), q = at(ws - 60 * (k - 1));
        if (p != null && q != null) { const r = Math.log(q / p); ss += r * r; cnt++; }
      }
      if (cnt < 40) continue;
      const sigMin = Math.sqrt(ss / cnt) * ptb;              // $ per minute
      if (!(sigMin > 0)) continue;
      const parts = Object.fromEntries(hourFmt.formatToParts(new Date(ws * 1000)).map((x) => [x.type, x.value]));
      const w = { ws, up: close >= ptb ? 1 : 0, sigMin, hour: Number(parts.hour) % 24, weekend: parts.weekday === "Sat" || parts.weekday === "Sun", cps: [] };
      for (let k = 1; k <= 13; k++) {
        const p = at(ws + 60 * k), p2 = at(ws + 60 * (k - 2));
        if (p == null || p2 == null) continue;
        w.cps.push({ k, z: (p - ptb) / (sigMin * Math.sqrt(14 - k + 0.25)), mz: (p - p2) / (sigMin * Math.SQRT2) });
      }
      if (w.cps.length) windows.push(w);
    }
    return windows;
  }

  // ---------- fitting ----------
  const rowsOf = (ws) => ws.flatMap((w) => w.cps.map((c) => ({ z: c.z, mz: c.mz, up: w.up })));
  function logloss(rows, c, b) {
    let s = 0;
    for (const r of rows) { const p = clampP(tcdf4(c * r.z + b * r.mz)); s -= r.up ? Math.log(p) : Math.log(1 - p); }
    return s / Math.max(1, rows.length);
  }
  function hitRate(rows, c, b) {
    let right = 0, n = 0;
    for (const r of rows) { const p = tcdf4(c * r.z + b * r.mz); if (Math.abs(p - 0.5) < 1e-6) continue; n++; if ((p > 0.5) === (r.up === 1)) right++; }
    return n ? right / n : null;
  }
  function fit(rows, withB) {
    let best = { c: 1, b: 0, ll: logloss(rows, 1, 0) };
    for (let c = 0.6; c <= 1.601; c += 0.05) {
      for (let b = withB ? -0.6 : 0; b <= (withB ? 0.601 : 0); b += 0.05) {
        const ll = logloss(rows, c, b);
        if (ll < best.ll) best = { c: +c.toFixed(2), b: +b.toFixed(2), ll };
      }
    }
    return best;
  }

  // ---------- patterns ----------
  // Each pattern looks at the 5-minute mark of each window (one reading per window) and measures
  // how much more often Up won than the model expected. Found on older windows, confirmed on newer ones.
  function patternStats(ws, filter, signed, c) {
    let s = 0, n = 0;
    for (const w of ws) {
      const cp = w.cps.find((x) => x.k === CHECK_K);
      if (!cp || !filter(w, cp)) continue;
      const res = w.up - tcdf4(c * cp.z);
      s += signed ? signed(w, cp) * res : res; n++;
    }
    return { n, res: n ? s / n : 0, se: n ? 0.5 / Math.sqrt(n) : 1 };
  }
  function verdict(tr, te) {
    if (tr.n < 60 || te.n < 30) return "more data needed";
    const same = Math.sign(tr.res) === Math.sign(te.res);
    if (same && Math.abs(tr.res) > 2 * tr.se && Math.abs(te.res) > 1.65 * te.se) return "confirmed";
    return "noise";
  }

  function run() {
    const ws = buildWindows();
    if (ws.length < 300) return null;
    const cut = Math.floor(ws.length * 2 / 3);
    const train = ws.slice(0, cut), test = ws.slice(cut);
    const trR = rowsOf(train), teR = rowsOf(test);

    const fc = fit(trR, false), fcb = fit(trR, true);
    const base = { ll: logloss(teR, 1, 0), hit: hitRate(teR, 1, 0) };
    const tunedC = { c: fc.c, ll: logloss(teR, fc.c, 0), hit: hitRate(teR, fc.c, 0) };
    const tunedCB = { c: fcb.c, b: fcb.b, ll: logloss(teR, fcb.c, fcb.b), hit: hitRate(teR, fcb.c, fcb.b) };
    const applyC = tunedC.ll < base.ll - 0.0005;
    const applyCB = tunedCB.ll < Math.min(base.ll, tunedC.ll) - 0.0005;

    // "favorite" = the side the model leans toward; signed residual > 0 means favorites win more than expected.
    const fav = (w, cp) => Math.sign(cp.z) || 1;
    const vols = ws.map((w) => w.sigMin).sort((a, b) => a - b);
    const lowV = vols[Math.floor(vols.length / 3)], highV = vols[Math.floor(vols.length * 2 / 3)];
    const defs = [
      { id: "cont", name: "Strong 2-min moves keep going", neg: "Strong 2-min moves snap back",
        f: (w, cp) => Math.abs(cp.mz) > 1, s: (w, cp) => Math.sign(cp.mz), kind: "side" },
      { id: "fav", name: "The leader wins more than the model says", neg: "The leader wins less than the model says",
        f: (w, cp) => Math.abs(cp.z) > 0.3, s: fav, kind: "side" },
      { id: "favHi", name: "In wild markets, leaders hold up better than expected", neg: "In wild markets, leaders blow it more than expected",
        f: (w, cp) => w.sigMin >= highV && Math.abs(cp.z) > 0.3, s: fav, kind: "side" },
      { id: "favLo", name: "In calm markets, leaders hold up better than expected", neg: "In calm markets, leaders blow it more than expected",
        f: (w, cp) => w.sigMin <= lowV && Math.abs(cp.z) > 0.3, s: fav, kind: "side" },
      { id: "night", name: "Overnight (12–6am ET) leans Up", neg: "Overnight (12–6am ET) leans Down", f: (w) => w.hour < 6, kind: "up" },
      { id: "morn", name: "Mornings (6am–12pm ET) lean Up", neg: "Mornings (6am–12pm ET) lean Down", f: (w) => w.hour >= 6 && w.hour < 12, kind: "up" },
      { id: "aft", name: "Afternoons (12–6pm ET) lean Up", neg: "Afternoons (12–6pm ET) lean Down", f: (w) => w.hour >= 12 && w.hour < 18, kind: "up" },
      { id: "eve", name: "Evenings (6pm–12am ET) lean Up", neg: "Evenings (6pm–12am ET) lean Down", f: (w) => w.hour >= 18, kind: "up" },
      { id: "wknd", name: "Weekends lean Up", neg: "Weekends lean Down", f: (w) => w.weekend, kind: "up" },
    ];
    const patterns = defs.map((d) => {
      const cRef = applyC ? tunedC.c : 1;
      const tr = patternStats(train, d.f, d.s, cRef), te = patternStats(test, d.f, d.s, cRef);
      const v = verdict(tr, te);
      const pos = (te.n ? te.res : tr.res) >= 0;
      return { id: d.id, name: pos ? d.name : d.neg, kind: d.kind, verdict: v, train: tr, test: te, size: te.res };
    });

    const result = {
      at: Date.now(), days: data ? Math.round(data.closes.length / 1440) : 0, windows: ws.length,
      trainN: train.length, testN: test.length,
      base, tunedC, tunedCB, applyC, applyCB, patterns,
    };
    store.set(RESULT_KEY, result);
    return result;
  }

  // ---------- live helpers ----------
  function result() { return store.get(RESULT_KEY, null); }
  // Tuned probability from the live model's own probability (and momentum, if known).
  function tuned(pUp, mz, forFinal) {
    const r = result();
    if (pUp == null || !r) return pUp;
    const z = invT(pUp);
    if (forFinal && r.applyCB && mz != null) return clampP(tcdf4(r.tunedCB.c * z + r.tunedCB.b * mz));
    if (r.applyC) return clampP(tcdf4(r.tunedC.c * z));
    return pUp;
  }
  // Past windows that looked like right now: same minute (±1), similar distance from the line, similar momentum.
  function similar(k, z, mz) {
    const ws = buildWindows();
    if (!ws.length) return null;
    for (const [dz, dm] of [[0.15, 0.5], [0.3, 0.8], [0.5, 1.2], [1.0, 2.0]]) {
      let n = 0, up = 0;
      for (const w of ws) for (const c of w.cps) {
        if (Math.abs(c.k - k) > 1 || Math.abs(c.z - z) > dz) continue;
        if (mz != null && Math.abs(c.mz - mz) > dm) continue;
        n++; up += w.up;
      }
      if (n >= 40) return { n, up: up / n };
    }
    return null;
  }

  window.Lab = { update, run, result, tuned, similar, invT, hasData: () => !!(data && data.closes.length), dataAge: () => data ? (Date.now() / 1000 - (data.start + data.closes.length * 60)) : Infinity };
})();
