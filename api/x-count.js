// /api/x-count.js
// Env var required in Vercel: X_BEARER_TOKEN (X/Twitter API v2 Bearer token)

const FIFTEEN_MIN = 15 * 60 * 1000;      // 15 minutes (ms)
const STALE_REVALIDATE_SEC = 60;         // allow brief background refresh
const BUFFER_MS = 15 * 1000;             // 15-second safety buffer for end_time

// Simple per-query in-memory cache { q: { timestamp, payload } }
const cache = new Map();

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'x-vercel-cache, age');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // HTTP cache (Vercel Edge/CDN)
  res.setHeader(
    'Cache-Control',
    `public, s-maxage=${FIFTEEN_MIN / 1000}, stale-while-revalidate=${STALE_REVALIDATE_SEC}`
  );
  res.setHeader('CDN-Cache-Control', `public, s-maxage=${FIFTEEN_MIN / 1000}`);

  // Query to count (default is cashtag $ZEN). Examples:
  //   q=$ZEN                      (cashtag)
  //   q=#ZEN                      (hashtag)
  //   q=$ZEN -is:retweet          (exclude retweets)
  const q = (req.query.q ?? '#21MWITHPRIVACY').toString();

  // Use in-memory cache if still fresh
  const now = Date.now();
  const cached = cache.get(q);
  if (cached && now - cached.timestamp < FIFTEEN_MIN) {
    return res.status(200).json(cached.payload);
  }

  // Build 24h window with a small buffer for end_time (API requires >=10s in the past)
  const end = new Date(Date.now() - BUFFER_MS);
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

    if (!r.ok) {
      // If API fails but we have stale cache, serve that instead
      if (cached) return res.status(200).json(cached.payload);
      const text = await r.text();
      return res
        .status(r.status)
        .json({ error: 'X API error', status: r.status, detail: text });
    }

    const data = await r.json(); // { data: [{start,end,tweet_count}], meta: {...} }
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

    cache.set(q, { timestamp: now, payload });
    return res.status(200).json(payload);
  } catch (e) {
    // Network/other error: fall back to stale cache if available
    if (cached) return res.status(200).json(cached.payload);
    return res.status(500).json({ error: 'server_error', detail: String(e) });
  }
}
