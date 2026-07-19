/* FinTrack price proxy — a tiny Cloudflare Worker that relays stock/ETF quotes
   from Yahoo Finance to the FinTrack web app.

   Why this exists: FinTrack is a static page, so every request runs in your
   browser — and Yahoo Finance doesn't send CORS headers, which means browsers
   refuse to read its responses directly. This Worker fetches the quote
   server-side (where CORS doesn't apply) and returns it WITH a CORS header.
   Mutual fund NAVs don't need it (api.mfapi.in allows browser calls natively);
   only stock/ETF quotes and the USD→INR rate come through here.

   It is deliberately NOT a general-purpose proxy: the only upstream it will
   ever call is Yahoo's chart endpoint, with a capped symbol count — so even if
   someone discovers your Worker URL, all they can do is look up stock quotes.

   Endpoints:
     GET /            -> { ok: true, service: "fintrack-price-proxy" }   (used by "Test connection")
     GET /quote?symbols=RELIANCE.NS,AAPL,USDINR=X
                      -> { "RELIANCE.NS": { price, currency, name, time }, "AAPL": {...}, ... }
                         (per-symbol failures come back as { error: "..." } without failing the batch)

   Setup instructions: see README.md next to this file. */

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";
const MAX_SYMBOLS = 25;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS)
  });
}

async function fetchQuote(symbol) {
  const url = YAHOO_CHART + encodeURIComponent(symbol) + "?interval=1d&range=1d";
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (fintrack-price-proxy)" },
    cf: { cacheTtl: 300, cacheEverything: true } // quotes are 15-min delayed anyway; cache 5 min
  });
  const body = await resp.json();
  const result = body && body.chart && body.chart.result && body.chart.result[0];
  const meta = result && result.meta;
  if (meta && typeof meta.regularMarketPrice === "number") {
    return {
      price: meta.regularMarketPrice,
      currency: meta.currency || null,
      name: meta.longName || meta.shortName || null,
      time: meta.regularMarketTime || null
    };
  }
  const errDesc = body && body.chart && body.chart.error && body.chart.error.description;
  return { error: errDesc || "symbol not found" };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return json({ ok: true, service: "fintrack-price-proxy" });
    }

    if (url.pathname === "/quote") {
      const symbols = (url.searchParams.get("symbols") || "")
        .split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_SYMBOLS);
      if (symbols.length === 0) return json({ error: "no symbols given" }, 400);
      const out = {};
      await Promise.all(symbols.map(async (sym) => {
        try {
          out[sym] = await fetchQuote(sym);
        } catch (e) {
          out[sym] = { error: String((e && e.message) || e) };
        }
      }));
      return json(out);
    }

    return json({ error: "not found" }, 404);
  }
};
