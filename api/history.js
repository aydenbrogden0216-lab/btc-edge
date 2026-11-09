// GET /api/history?from=UNIX&to=UNIX
// Proxies Polymarket US's BRTI 1-minute history (max 3600 candles per call).
const US = "https://gateway.polymarket.us";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=60");
  const from = Math.floor(Number(req.query.from));
  const to = Math.floor(Number(req.query.to));
  if (!(from > 0 && to > from && to - from <= 3600 * 60)) return res.status(400).json({ error: "bad range" });
  const url = `${US}/v1/asset-prices/history?assets=crypto:btc&from=${from}&to=${to}&bucket=ASSET_PRICE_BUCKET_1M`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "btc-edge/3.0", Accept: "application/json" } });
    clearTimeout(t);
    if (r.status === 429) {
      res.setHeader("Retry-After", r.headers.get("retry-after") || "10");
      return res.status(429).json({ error: "rate limited" });
    }
    if (!r.ok) return res.status(502).json({ error: `upstream HTTP ${r.status}` });
    res.status(200).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
}
