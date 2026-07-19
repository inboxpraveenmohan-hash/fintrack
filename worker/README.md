# FinTrack price proxy — one-time setup (~10 minutes, free)

FinTrack can refresh the market value of your holdings with one click:

- **Indian mutual fund NAVs** work out of the box — no setup needed at all.
- **Stocks & ETFs (NSE / BSE / US)** and the **USD→INR rate** need this tiny
  relay, because Yahoo Finance (the quote source) doesn't allow direct browser
  requests. The relay runs on Cloudflare's free tier — no server, no cost, and
  your portfolio data never passes through it (it only ever sees ticker symbols).

## Setup steps

1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up
   (only an email is needed — no card, no domain).
2. In the dashboard, go to **Workers & Pages → Create → Create Worker**.
3. Give it any name (e.g. `my-price-proxy`) and click **Deploy** — this creates
   a "Hello World" worker.
4. Click **Edit code**, delete everything in the editor, and paste the full
   contents of [`price-proxy.js`](price-proxy.js) (the file next to this README).
5. Click **Deploy** (top right).
6. Copy your Worker's URL — it looks like
   `https://my-price-proxy.<your-subdomain>.workers.dev`.
7. In FinTrack's Portfolio page: **Data ▾ → Live Price Settings**, paste the
   URL, click **Test** (you should see a ✓), then **Save**.

That's it. The URL is saved with your FinTrack data (and syncs to your other
devices via Drive sync, if you use it), so this is a once-ever setup.

## Notes

- **Free-tier limits**: 100,000 requests/day — a price refresh uses one request
  total for all your stocks, so this is effectively unlimited for personal use.
- **Safety**: the worker is locked to Yahoo's quote endpoint with a capped
  symbol count. It cannot be used to fetch arbitrary URLs, so keeping the URL
  secret doesn't matter much — but there's also no reason to share it.
- **Quotes are 15-minute delayed** (standard for free sources) and cached for
  5 minutes at the edge. Mutual fund NAVs update once per day (published by
  AMFI in the evening).
