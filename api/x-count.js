// /api/x-count.js
// Env var: X_BEARER_TOKEN

const FIFTEEN_MIN = 15 * 60 * 1000; // 15 min
const STALE_REVALIDATE_SEC = 60;    // background refresh hint
const BUFFER_MS = 15 * 1000;        // 15s safety for end_time

// In-memory cache: q -> { timestamp, payload, rateLockedUntil }
const cache = new Map();

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'x-vercel-cache, age, retry-after');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // CDN cache (Vercel)
  res.setHeader('Cache-Control', `public, s-maxage=${FIFTEEN_MIN / 1000}, stale-while-revalidate=${STALE_REVALIDATE_SEC}`);
  res.setHeader('CDN-Cache-Control', `public, s-maxage=${FIFTEEN_MIN / 1000}`);

  // Default to your hashtag; you can override with ?q=%2321MWITHPRIVACY
  const q = (req.query.q ?? '#21MWITHPRIVACY -is:retweet').toString().trim();

  const now = Date.now();
  const entry = cache.get(q);

  // Serve cache if fresh OR under a rate lock
  if (entry?.payload) {
    const fresh = now - entry.timestamp < FIFTEEN_MIN;
    const rateLocked = entry.rateLockedUntil && now < entry.rateLockedUntil;
    if (fresh || rateLocked) {
      if (rateLocked) {
        const retrySec = Math.max(1, Math.ceil((entry.rateLockedUntil - now) / 1000));
        res.setHeader('Retry-After', String(retrySec));
      }
      return res.status(200).json(entry.payload);
    }
  }

  // Build 24h window with buffer
  const end = new Date(now - BUFFER_MS);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    query: q,
    granularity: 'hour',
    start_time: start.toISOString(),
    end_time: end.toISOString()
  });

  try {
    // NOTE: If api.x.com gives you grief, swap to https://api.twitter.com
    const r = await fetch(`https://api.x.com/2/tweets/counts/recent?${params}`, {
      headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }
    });

    // --- Hard circuit breaker for rate limits ---
    if (r.status === 429) {
      const retryAfterHdr = r.headers.get('retry-after');
      const resetHdr = r.headers.get('x-rate-limit-reset'); // unix seconds
      let retryMs = FIFTEEN_MIN;
      if (retryAfterHdr && !Number.isNaN(Number(retryAfterHdr))) {
        retryMs = Math.max(5_000, Number(retryAfterHdr) * 1000);
      } else if (resetHdr && !Number.isNaN(Number(resetHdr))) {
        const resetMs = Number(resetHdr) * 1000 - now;
        if (resetMs > 0) retryMs = Math.max(5_000, resetMs);
      }
      const until = now + retryMs;
      res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));

      // If we already had a good payload, keep serving it
      if (entry?.payload?.total != null) {
        entry.rateLockedUntil = until;
        cache.set(q, entry);
        return res.status(200).json(entry.payload);
      }

      // First call after cold start and we hit 429:
      // cache a stub so we don't re-hit X again for 15 min
      const stub = {
        query: q,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        total: null,                // null signals "unavailable"
        per_hour: [],
        note: 'Rate-limited by X; showing no data until retry window passes.'
      };
      cache.set(q, { timestamp: now, payload: stub, rateLockedUntil: until });
      return res.status(200).json(stub);
    }

    // Other upstream errors → serve stale if we have it
    if (!r.ok) {
      if (entry?.payload) return res.status(200).json(entry.payload);
      const text = await r.text();
      return res.status(r.status).json({ error: 'X API error', status: r.status, detail: text });
    }

    // Success
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
    // Network/other error → serve stale if possible, else stub (and avoid hammering)
    if (entry?.payload) return res.status(200).json(entry.payload);

    const until = now + FIFTEEN_MIN;
    res.setHeader('Retry-After', String(Math.ceil(FIFTEEN_MIN / 1000)));
    const stub = {
      query: q,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      total: null,
      per_hour: [],
      note: 'Upstream unavailable; temporary stub cached.'
    };
    cache.set(q, { timestamp: now, payload: stub, rateLockedUntil: until });
    return res.status(200).json(stub);
  }
}
