// BTC 15-minute Up/Down snapshot.
//
// Primary source: Polymarket US (the app you trade on).
//   - market + official price to beat:  gateway.polymarket.us /v1/markets, /v1/market/slug/{slug}
//   - live Up price:                    /v1/markets/{slug}/bbo   (one book; Down = 1 - Up)
//   - settlement index (CF Benchmarks BRTI): /v1/asset-prices/history
// Fallback (only if the US market can't be found): global Polymarket book + Coinbase price.
//
// GET /api/snapshot                        -> live snapshot
// GET /api/snapshot?result=SLUG&src=us     -> outcome of a finished US window
// GET /api/snapshot?result=WS&src=global   -> outcome of a finished global window

const WINDOW = 900;          // 15 minutes
const AVG_SECS = 60;         // close and open are 60-second BRTI averages
const US = "https://gateway.polymarket.us";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const CB = "https://api.exchange.coinbase.com/products/BTC-USD";

// Warm serverless instances keep this between requests; cold starts just refetch.
const cache = { markets: new Map(), vol: null, volAt: 0, last: null };

// ---- helpers ---------------------------------------------------------------
async function getJSON(url, ms = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "btc-edge/2.0", Accept: "application/json" },
    });
    if (r.status === 429) throw new Error("rate limited");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}
const settle = async (p) => {
  try { return { ok: true, value: await p }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
};
const num = (x) => (x == null || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);
const amt = (a) => (a && typeof a === "object" ? num(a.value) : num(a));
const toSec = (d) => {
  if (d == null || d === "") return null;
  if (typeof d === "number" || /^\d+(\.\d+)?$/.test(String(d))) {
    const n = Number(d);
    return n > 1e12 ? n / 1000 : n;
  }
  const t = Date.parse(d);
  return Number.isFinite(t) ? t / 1000 : null;
};
const asList = (v) => {
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return []; } }
  return Array.isArray(v) ? v : [];
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---- model -----------------------------------------------------------------
// CDF of a Student-t with 4 degrees of freedom, rescaled to unit variance.
// Fatter tails than a normal curve, so sudden BTC jumps aren't treated as near-impossible.
export function tcdf4(z) {
  const t = z * Math.SQRT2;
  const u = 1 + (t * t) / 4;
  return 0.5 + (3 / 8) * (t / Math.sqrt(u)) * (1 - (t * t) / (12 * u));
}

// Per-second volatility. EWMA over 1-minute returns (recent minutes weigh more),
// blended with the last ~90 seconds so a sudden burst shows up right away.
export function volPerSec(closes1m, closes1s = []) {
  const rets = (xs) => {
    const r = [];
    for (let i = 1; i < xs.length; i++) if (xs[i] > 0 && xs[i - 1] > 0) r.push(Math.log(xs[i] / xs[i - 1]));
    return r;
  };
  const rm = rets(closes1m);
  if (rm.length < 10) return null;
  const seed = rm.slice(0, 20);
  let v = seed.reduce((a, x) => a + x * x, 0) / seed.length;
  for (const r of rm) v = 0.94 * v + 0.06 * r * r;
  const longSec = Math.max(Math.sqrt(v), 0.00005) / Math.sqrt(60);
  const rs = rets(closes1s);
  if (rs.length < 30) return longSec;
  const shortSec = Math.sqrt(rs.reduce((a, x) => a + x * x, 0) / rs.length);
  return Math.sqrt(0.7 * longSec ** 2 + 0.3 * shortSec ** 2);
}

// Chance the window closes Up. The close is the average of the last 60 one-second
// index prints, so near the end part of the answer is already locked in.
//   knownAvg/knownSecs: average of the prints already inside the final 60 seconds.
export function fairUp({ spot, ptb, sigmaSec, secondsLeft, knownAvg = null }) {
  if (!(spot > 0 && ptb > 0)) return null;
  let mean, varFactor;
  if (secondsLeft <= 0) {
    const close = knownAvg ?? spot;
    return close >= ptb ? 1 : 0;
  } else if (secondsLeft > AVG_SECS) {
    mean = spot;
    varFactor = secondsLeft - AVG_SECS + AVG_SECS / 3;
  } else {
    const t = secondsLeft, k = AVG_SECS - t;
    const A = knownAvg ?? spot;
    mean = (k * A + t * spot) / AVG_SECS;
    varFactor = (t / AVG_SECS) ** 2 * (t / 3);
  }
  if (!(sigmaSec > 0)) return null;
  const sd = spot * sigmaSec * Math.sqrt(varFactor);
  if (!(sd > 0)) return mean >= ptb ? 1 : 0;
  return clamp(tcdf4((mean - ptb) / sd), 0.001, 0.999);
}

// ---- Polymarket US ---------------------------------------------------------
function isBtc15(m) {
  const t = m && m.assetPriceTerms;
  if (!t || !/UP_DOWN/.test(t.marketType || "")) return false;
  if (String((t.asset && t.asset.symbol) || "").toLowerCase() !== "btc") return false;
  const a = toSec(t.windowStart), b = toSec(t.windowEnd);
  return a != null && b != null && Math.abs(b - a - WINDOW) < 2;
}
function usInfo(m) {
  const t = m.assetPriceTerms;
  return {
    slug: m.slug,
    windowStart: toSec(t.windowStart),
    windowEnd: toSec(t.windowEnd),
    ptb: amt(t.priceToBeat),
    settle: amt(t.settlementPrice),
    checkedAt: Date.now(),
  };
}
// Polymarket US names each window like "btc-updown-15m-2026-09-21-0015z" (start time, UTC).
export function slugStamp(ws) {
  const d = new Date(ws * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}z`;
}
export function slugGuesses(ws) {
  const s = slugStamp(ws);
  return [`btc-updown-15m-${s}`, `cpc-btc-updown-15m-${s}`, `aec-btc-updown-15m-${s}`];
}

async function findUsMarket(nowSec, tried = []) {
  const ws = Math.floor(nowSec / WINDOW) * WINDOW;
  if (cache.markets.has(ws)) return cache.markets.get(ws);
  const current = (i) => i && i.windowStart <= nowSec && nowSec < i.windowEnd;
  const fromMarket = (m) => (isBtc15(m) ? usInfo(m) : null);
  let found = null;

  // 1) Direct lookup by the window's name: one quick call, no listing needed.
  for (const slug of slugGuesses(ws)) {
    const r = await settle(getJSON(`${US}/v1/market/slug/${encodeURIComponent(slug)}`));
    tried.push(`${slug}: ${r.ok ? (r.value && r.value.market ? "found" : "empty") : r.error}`);
    const info = r.ok && r.value && r.value.market ? fromMarket(r.value.market) : null;
    if (current(info)) { found = info; break; }
  }

  // 2) Listings and search, each tried on its own so one failure doesn't stop the rest.
  const stamp = slugStamp(ws);
  const lookups = [
    ["crypto list", `${US}/v1/markets?${new URLSearchParams({ categories: "crypto", closed: "false", limit: "500" })}`],
    ["open list", `${US}/v1/markets?${new URLSearchParams({ closed: "false", limit: "500" })}`],
    ["search", `${US}/v1/search?${new URLSearchParams({ query: `btc-updown-15m-${stamp}` })}`],
  ];
  for (const [name, url] of found ? [] : lookups) {
    const r = await settle(getJSON(url));
    if (!r.ok) { tried.push(`${name}: ${r.error}`); continue; }
    const list = r.value.markets || (r.value.events || []).flatMap((e) => e.markets || []);
    tried.push(`${name}: ${list.length} markets`);
    found = list.map(fromMarket).find(current) || null;
    if (!found) {
      // Some listings leave out the price terms; match the name, then fetch the full market.
      const named = list.find((m) => m.slug && m.slug.includes("btc-updown-15m") && m.slug.includes(stamp));
      if (named) {
        const full = await settle(getJSON(`${US}/v1/market/slug/${encodeURIComponent(named.slug)}`));
        const info = full.ok && full.value && full.value.market ? fromMarket(full.value.market) : null;
        if (current(info)) found = info;
      }
    }
    if (found) break;
  }

  if (found) {
    cache.markets.set(ws, found);
    for (const k of cache.markets.keys()) if (k < ws - 7200) cache.markets.delete(k);
  }
  return found;
}
async function refreshUs(info) {
  const d = await getJSON(`${US}/v1/market/slug/${encodeURIComponent(info.slug)}`);
  if (d && d.market && d.market.assetPriceTerms) Object.assign(info, usInfo(d.market));
  info.checkedAt = Date.now();
  return info;
}
async function usBbo(slug) {
  const d = await getJSON(`${US}/v1/markets/${encodeURIComponent(slug)}/bbo`);
  const m = (d && d.marketData) || {};
  const bid = amt(m.bestBid), ask = amt(m.bestAsk);
  return {
    up: { bid, ask, bidSize: num(m.bidShares), askSize: num(m.askShares) },
    // One book: buying Down = selling Up, so Down's ask is 1 - Up's bid.
    down: {
      bid: ask == null ? null : +(1 - ask).toFixed(4),
      ask: bid == null ? null : +(1 - bid).toFixed(4),
      bidSize: num(m.askShares), askSize: num(m.bidShares),
    },
    state: m.state || null,
  };
}
async function brti(from, to, bucket) {
  const qs = new URLSearchParams({
    assets: "crypto:btc", from: String(Math.floor(from)), to: String(Math.floor(to)), bucket,
  });
  const d = await getJSON(`${US}/v1/asset-prices/history?${qs}`);
  const s = ((d && d.series) || [])[0];
  return ((s && s.candles) || [])
    .map((c) => ({ t: toSec(c.timestamp), c: num(c.close) }))
    .filter((c) => c.t != null && c.c > 0)
    .sort((a, b) => a.t - b.t);
}
async function brtiVolCandles(nowSec) {
  if (cache.vol && Date.now() - cache.volAt < 60000) return cache.vol;
  const rows = await brti(nowSec - 7200, nowSec, "ASSET_PRICE_BUCKET_1M");
  cache.vol = rows.map((r) => r.c);
  cache.volAt = Date.now();
  return cache.vol;
}

async function usSnapshot(now) {
  const tried = [];
  const info = await findUsMarket(now, tried);
  if (!info) throw new Error(`market not found (${tried.join("; ")})`);
  const errors = [];

  const needPtb = info.ptb == null && now > info.windowStart + 3 && Date.now() - info.checkedAt > 4000;
  const [bbo, recent, volC] = await Promise.all([
    settle(usBbo(info.slug)),
    settle(brti(now - 100, now, "ASSET_PRICE_BUCKET_1S")),
    settle(brtiVolCandles(now)),
    needPtb ? settle(refreshUs(info)) : null,
  ]);
  if (!bbo.ok) errors.push(`odds: ${bbo.error}`);
  if (!recent.ok) errors.push(`BTC index: ${recent.error}`);
  if (!volC.ok) errors.push(`volatility: ${volC.error}`);

  const ticks = recent.ok ? recent.value : [];
  const spot = ticks.length ? ticks[ticks.length - 1].c : null;
  const secondsLeft = Math.max(0, info.windowEnd - now);
  const avgFrom = info.windowEnd - AVG_SECS;
  const inside = ticks.filter((x) => x.t >= avgFrom && x.t < info.windowEnd);
  const knownAvg = inside.length ? inside.reduce((a, x) => a + x.c, 0) / inside.length : null;
  const sigmaSec = volC.ok ? volPerSec(volC.value, ticks.map((x) => x.c)) : null;

  const b = bbo.ok ? bbo.value : { up: null, down: null, state: null };
  return {
    source: "us",
    slug: info.slug,
    windowStart: info.windowStart,
    windowEnd: info.windowEnd,
    secondsLeft,
    spot, spotSource: "BRTI",
    ptb: info.ptb, ptbSource: info.ptb != null ? "official" : null,
    sigmaSec,
    fairUp: info.ptb != null ? fairUp({ spot, ptb: info.ptb, sigmaSec, secondsLeft, knownAvg }) : null,
    up: b.up, down: b.down, marketState: b.state,
    marketUrl: "https://polymarket.us",
    errors,
  };
}

// ---- global fallback -------------------------------------------------------
async function globalMarket(ws) {
  const events = await getJSON(`${GAMMA}/events?slug=btc-updown-15m-${ws}`);
  if (!Array.isArray(events) || !events.length) return null;
  const ev = events[0], m = ev.markets && ev.markets[0];
  if (!m) return null;
  const outs = asList(m.outcomes).map((o) => String(o).trim().toLowerCase());
  const toks = asList(m.clobTokenIds);
  const prices = asList(m.outcomePrices).map(Number);
  if (outs.length !== 2 || toks.length !== 2) return null;
  return {
    tokens: Object.fromEntries(outs.map((o, i) => [o, toks[i]])),
    final: Object.fromEntries(outs.map((o, i) => [o, prices[i]])),
    closed: Boolean(m.closed),
    url: `https://polymarket.com/event/${ev.slug || `btc-updown-15m-${ws}`}`,
  };
}
async function globalBook(token) {
  const b = await getJSON(`${CLOB}/book?token_id=${token}`);
  const bids = (b.bids || []).map((x) => [+x.price, +x.size]);
  const asks = (b.asks || []).map((x) => [+x.price, +x.size]);
  const bid = bids.length ? Math.max(...bids.map((x) => x[0])) : null;
  const ask = asks.length ? Math.min(...asks.map((x) => x[0])) : null;
  return {
    bid, ask,
    bidSize: Math.round(bids.filter((x) => x[0] === bid).reduce((a, x) => a + x[1], 0)),
    askSize: Math.round(asks.filter((x) => x[0] === ask).reduce((a, x) => a + x[1], 0)),
  };
}
async function globalSnapshot(now) {
  const ws = Math.floor(now / WINDOW) * WINDOW;
  const errors = [];
  const [mk, tick, candles] = await Promise.all([
    settle(globalMarket(ws)),
    settle(getJSON(`${CB}/ticker`)),
    settle(getJSON(`${CB}/candles?granularity=60&start=${new Date((now - 7260) * 1000).toISOString()}&end=${new Date(now * 1000).toISOString()}`)),
  ]);
  const market = mk.ok ? mk.value : null;
  if (!market) errors.push(mk.ok ? "market not listed yet" : `market: ${mk.error}`);
  let up = null, down = null;
  if (market) {
    const [u, d] = await Promise.all([settle(globalBook(market.tokens.up)), settle(globalBook(market.tokens.down))]);
    up = u.ok ? u.value : null; down = d.ok ? d.value : null;
    if (!u.ok || !d.ok) errors.push("order book unavailable");
  }
  const cs = candles.ok && Array.isArray(candles.value) ? candles.value.slice().sort((a, b) => a[0] - b[0]) : [];
  const spot = tick.ok ? num(tick.value.price) : null;
  const open = cs.find((c) => c[0] === ws);
  const ptb = open ? open[3] : null;
  const sigmaSec = cs.length ? volPerSec(cs.map((c) => c[4])) : null;
  const secondsLeft = Math.max(0, ws + WINDOW - now);
  return {
    source: "global",
    slug: `btc-updown-15m-${ws}`,
    windowStart: ws, windowEnd: ws + WINDOW, secondsLeft,
    spot, spotSource: "Coinbase",
    ptb, ptbSource: ptb != null ? "estimate" : null,
    sigmaSec,
    fairUp: fairUp({ spot, ptb, sigmaSec, secondsLeft }),
    up, down, marketState: null,
    marketUrl: market ? market.url : "https://polymarket.com/crypto",
    errors,
  };
}

// ---- results ---------------------------------------------------------------
async function result(req) {
  const src = req.query.src || "us";
  const key = String(req.query.result);
  if (src === "us") {
    const d = await getJSON(`${US}/v1/market/slug/${encodeURIComponent(key)}`);
    const t = d && d.market && d.market.assetPriceTerms;
    const s = t && amt(t.settlementPrice), p = t && amt(t.priceToBeat);
    return { key, outcome: s != null && p != null ? (s >= p ? "Up" : "Down") : null, settle: s, ptb: p };
  }
  const m = await globalMarket(Number(key));
  const outcome = m && m.closed ? (m.final.up === 1 ? "Up" : m.final.down === 1 ? "Down" : null) : null;
  return { key, outcome };
}

// ---- handler ---------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  req.query = req.query || {};

  if (req.query.result) {
    const r = await settle(result(req));
    return res.status(200).json(r.ok ? r.value : { key: req.query.result, outcome: null, error: r.error });
  }

  const now = Date.now() / 1000;
  const notes = [];
  const us = await settle(usSnapshot(now));
  let snap = us.ok ? us.value : null;
  const fresh = cache.last && cache.last.source === "us" && now - cache.last.now < 20 && cache.last.windowEnd > now;
  // Partial US data (usually a brief rate limit): reuse the last good reading if it's only seconds old.
  if (snap && (snap.spot == null || !snap.up || snap.up.ask == null) && fresh) {
    snap = { ...cache.last, stale: true, errors: snap.errors, secondsLeft: Math.max(0, cache.last.windowEnd - now) };
  }
  if (!snap) {
    notes.push(us.ok ? "US market for this window not found" : `US data: ${us.error}`);
    // If the US API is just rate limiting us, a few-seconds-old US snapshot beats switching books.
    if (cache.last && cache.last.source === "us" && now - cache.last.now < 20 && cache.last.windowEnd > now) {
      snap = { ...cache.last, stale: true };
      snap.secondsLeft = Math.max(0, snap.windowEnd - now);
    } else {
      const g = await settle(globalSnapshot(now));
      if (g.ok) snap = g.value;
      else return res.status(200).json({ now, errors: [...notes, `global data: ${g.error}`] });
    }
  }
  snap.now = now;
  snap.errors = [...notes, ...(snap.errors || [])];
  if (snap.source === "us" && !snap.stale && snap.spot != null && snap.up && snap.up.ask != null) cache.last = snap;
  res.status(200).json(snap);
}
