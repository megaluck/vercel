// /api/x-count.js
// Env var: X_BEARER_TOKEN

const FIFTEEN_MIN = 15 * 60 * 1000; // 15 min
const STALE_REVALIDATE_SEC = 60;    // background refresh hint
const BUFFER_MS = 15 * 1000;        // 15s safety for end_time

// Simple per-query cache + rate info
const cache = new Map(); // q -> { timestamp, payload, rateLockedUntil? }

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'x-vercel-cache, age, retry-after');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // CDN cache (Vercel)
  res.setHeader('Cache-Control', `public, s-maxage=${FIFTEEN_MIN / 1000}, stale-while-revalidate=${STALE_REVALIDATE_SEC}`);
  res.setHeader('CDN-Cache-Control', `public, s-maxage=${FIFTEEN_MIN / 1000}`);

  const q = (req.query.q ?? '#21MWITHPRIVACY').toString();
  const now = Date.now();
  const entry = cache.get(q);

  // If we’re within our 15-min freshness window OR under a rate lock, serve cache if we have it
  if (entry?.payload) {
    const fresh = now - entry.timestamp < FIFTEEN_MIN;
    const rateLocked = entry.rateLockedUntil && now < entry.rateLockedUntil;
    if (fresh || rateLocked) {
      if (rateLocked) {
        // Tell clients when it's safe to try again (best-effort)
        const retrySec = Math.max(1, Math.ceil((entry.rateLockedUntil - now) / 1000));
        res.setHeader('Retry-After', String(retrySec));
      }
      return res.status(200).json(entry.payload);
    }
  }

  // Build 24h window with a small buffer
  const end = new Date(now - BUFFER_MS);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    query: q,
    granularity: 'hour',
    start_time: start.toISOString(),
    end_time: end.toISOString()
  });

  try {
    const r = await fetch(`https://api.x.com/2/tweets/counts/recent?${params}`, {
      headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }
    });

    if (r.status === 429) {
      // Respect X rate limit reset if provided; otherwise back off 15 min
      const retryAfterHdr = r.headers.get('retry-after');
      const resetHdr = r.headers.get('x-rate-limit-reset'); // unix seconds (if present)
      let retryMs = FIFTEEN_MIN;

      if (retryAfterHdr && !Number.isNaN(Number(retryAfterHdr))) {
        retryMs = Math.max(5_000, Number(retryAfterHdr) * 1000);
      } else if (resetHdr && !Number.isNaN(Number(resetHdr))) {
        const resetMs = Number(resetHdr) * 1000 - now;
        if (resetMs > 0) retryMs = Math.max(5_000, resetMs);
      }

      // Set/extend rate lock and serve stale if we have it
      const rateLockedUntil = now + retryMs;
      if (entry) {
        entry.rateLockedUntil = rateLockedUntil;
        cache.set(q, entry);
        res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));
        return res.status(200).json(entry.payload); // stale-but-usable
      }

      // No cache to fall back to — return a friendly 429 with guidance
      res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));
      return res.status(429).json({
        error: 'rate_limited',
        detail: 'X API rate limit hit. Try again later.',
        retry_after_seconds: Math.ceil(retryMs / 1000)
      });
    }

    if (!r.ok) {
      // Non-429 error: serve stale if possible
      if (entry?.payload) return res.status(200).json(entry.payload);
      const text = await r.text();
      return res.status(r.status).json({ error: 'X API error', status: r.status, detail: text });
    }

    const data = await r.json();
    const perHour = (data.data ?? []).map(b => ({
      start: b.start,
      end: b.end,
      count: b.tweet_count
    }));
    const total = perHour.reduce((a, b) => a + (b.count || 0), 0);

    const payload = {
      query: q,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      total,
      per_hour: perHour
    };

    cache.set(q, { timestamp: now, payload, rateLockedUntil: null });
    return res.status(200).json(payload);
  } catch (e) {
    // Network or other error: serve stale if available
    if (entry?.payload) return res.status(200).json(entry.payload);
    return res.status(500).json({ error: 'server_error', detail: String(e) });
  }
}
