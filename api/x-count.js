// /api/x-count.js
// Env var: X_BEARER_TOKEN  (your X/Twitter API v2 Bearer token)

const FIFTEEN_MIN = 15 * 60 * 1000; // 15 min
const STALE_REVALIDATE_SEC = 60;    // background refresh hint
const BUFFER_MS = 15 * 1000;        // 15s safety for end_time
const MIN_LOCK = 5 * 60 * 1000;     // minimum 5 min lock after 429

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

  // 1) Read query and sanitize
  let q = (req.query.q ?? '#21MWITHPRIVACY -is:retweet').toString().trim();

  // Auto-rewrite pure cashtags like "$ZEN" to a safe fallback (no $ operator)
  if (/^\$[A-Za-z0-9_]+$/.test(q)) {
    const sym = q.slice(1).toUpperCase();
    q = `(#${sym} OR ${sym} OR "Horizen" OR Zcash) -is:retweet`;
  }

  const now = Date.now();
  const entry = cache.get(q);

  // 2) Serve cache if fresh OR under a rate lock
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

  // 3) Build 24h window with a buffer (X requires end_time ≥10s before now)
  const end = new Date(now - BUFFER_MS);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

  const params = new URLSearchParams({
    query: q,
    granularity: 'hour',
    start_time: start.toISOString(),
    end_time: end.toISOString()
  });

  try {
    // Use the stable Twitter domain
    const r = await fetch(`https://api.twitter.com/2/tweets/counts/recent?${params}`, {
      headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }
    });

    // 4) Handle rate limits with a circuit breaker
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
      retryMs = Math.max(MIN_LOCK, retryMs); // clamp to MIN_LOCK
      const until = now + retryMs;
      res.setHeader('Retry-After', String(Math.ceil(retryMs / 1000)));

      if (entry?.payload) {
        entry.rateLockedUntil = until;
        cache.set(q, entry);
        return res.status(200).json(entry.payload);
      }

      // Cache a stub so we don't hammer X during the lock
      const stub = {
        query: q,
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        total: null,
        per_hour: [],
        note: 'Rate-limited by X; showing no data until retry window passes.'
      };
      cache.set(q, { timestamp: now, payload: stub, rateLockedUntil: until });
      return res.status(200).json(stub);
    }

    // 5) If 400 and query contains a $ (someone passed more complex cashtag), auto-fallback
    if (r.status === 400 && /\$/.test(q)) {
      const fallbackQ = q.replace(/\$([A-Za-z0-9_]+)/g, '#$1'); // convert $ZEN -> #ZEN (rough fallback)
      const r2 = await fetch(`https://api.twitter.com/2/tweets/counts/recent?${new URLSearchParams({
        query: fallbackQ,
        granularity: 'hour',
        start_time: start.toISOString(),
        end_time: end.toISOString()
      })}`, { headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } });

      if (r2.ok) {
        const json2 = await r2.json();
        const payload2 = toPayload(json2, fallbackQ, start, end, {
          note: `Fell back from "${q}" to "${fallbackQ}" because cashtags are restricted on this API tier.`
        });
        cache.set(q, { timestamp: now, payload: payload2, rateLockedUntil: null });
        return res.status(200).json(payload2);
      }
      // Fall through to generic error handling
    }

    // 6) Other upstream errors → serve stale if possible
    if (!r.ok) {
      if (entry?.payload) return res.status(200).json(entry.payload);
      const text = await r.text();
      return res.status(r.status).json({ error: 'X API error', status: r.status, detail: text });
    }

    // 7) Success
    const data = await r.json();
    const payload = toPayload(data, q, start, end);
    cache.set(q, { timestamp: now, payload, rateLockedUntil: null });
    return res.status(200).json(payload);
  } catch (e) {
    if (entry?.payload) return res.status(200).json(entry.payload);
    const until = now + MIN_LOCK;
    res.setHeader('Retry-After', String(Math.ceil(MIN_LOCK / 1000)));
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

function toPayload(apiJson, q, start, end, extra = {}) {
  const perHour = (apiJson.data ?? []).map(b => ({
    start: b.start,
    end: b.end,
    count: b.tweet_count
  }));
  const total = perHour.reduce((a, b) => a + (b.count || 0), 0);
  return {
    query: q,
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    total,
    per_hour: perHour,
    ...extra
  };
}
