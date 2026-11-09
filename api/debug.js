// Diagnostics: GET /api/debug
// Tries each Polymarket US call from the server and reports exactly what came back.

const US = "https://gateway.polymarket.us";

async function probe(name, url) {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "btc-edge/2.0", Accept: "application/json" } });
    clearTimeout(t);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { name, url, status: r.status, ms: Date.now() - started, contentType: r.headers.get("content-type"), json, text: json ? null : text.slice(0, 300) };
  } catch (e) {
    return { name, url, error: String(e.message || e), ms: Date.now() - started };
  }
}

function summarizeMarkets(json) {
  const list = (json && (json.markets || (json.events || []).flatMap((e) => e.markets || []))) || [];
  const withTerms = list.filter((m) => m.assetPriceTerms);
  const btc = withTerms.filter((m) => String(m.assetPriceTerms.asset && m.assetPriceTerms.asset.symbol).toLowerCase() === "btc");
  return {
    count: list.length,
    withAssetPriceTerms: withTerms.length,
    btc: btc.length,
    sampleKeys: list[0] ? Object.keys(list[0]).slice(0, 40) : [],
    samples: (btc.length ? btc : list).slice(0, 4).map((m) => ({
      slug: m.slug, title: m.title || m.question, startDate: m.startDate, endDate: m.endDate,
      active: m.active, closed: m.closed, categories: m.categories, tags: (m.tags || []).map((t) => t.slug || t.label || t).slice(0, 5),
      assetPriceTerms: m.assetPriceTerms || null,
    })),
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const now = Math.floor(Date.now() / 1000);
  const ws = Math.floor(now / 900) * 900;
  const qs = (o) => new URLSearchParams(o).toString();

  const probes = await Promise.all([
    probe("health", `${US}/v1/health`),
    probe("markets crypto", `${US}/v1/markets?${qs({ categories: "crypto", closed: "false", limit: "50" })}`),
    probe("markets all open", `${US}/v1/markets?${qs({ closed: "false", limit: "50" })}`),
    probe("search btc updown", `${US}/v1/search?${qs({ query: "btc-updown-15m" })}`),
    probe("search bitcoin up or down", `${US}/v1/search?${qs({ query: "Bitcoin Up or Down" })}`),
    probe("brti 1s", `${US}/v1/asset-prices/history?${qs({ assets: "crypto:btc", from: String(now - 30), to: String(now), bucket: "ASSET_PRICE_BUCKET_1S" })}`),
  ]);

  const out = { serverTimeUtc: new Date().toISOString(), windowStartUtc: new Date(ws * 1000).toISOString(), region: process.env.VERCEL_REGION || null, probes: [] };
  for (const p of probes) {
    const row = { name: p.name, status: p.status, ms: p.ms, error: p.error, contentType: p.contentType, nonJson: p.text };
    if (p.json && /markets|search/.test(p.name)) row.markets = summarizeMarkets(p.json);
    else if (p.json && p.name === "brti 1s") {
      const s = (p.json.series || [])[0];
      row.brti = { candles: s && s.candles ? s.candles.length : 0, last: s && s.candles ? s.candles[s.candles.length - 1] : null };
    } else if (p.json) row.json = JSON.stringify(p.json).slice(0, 300);
    out.probes.push(row);
  }
  res.status(200).json(out);
}
