// /api/x-count.js
// Env var required: X_BEARER_TOKEN (X/Twitter API v2 Bearer token)

const FIFTEEN_MIN = 15 * 60 * 1000;
const STALE_REVALIDATE_SEC = 60;

// simple per-query in-memory cache { [q]: { timestamp, payload } }
const cache = new Map();

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'x-vercel-cache, age');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // HTTP cache for Vercel CDN (15 min)
  // s-maxage is respected by Vercel's CDN; stale-while-revalidate allows brief background revalidation
  res.setHeader('Cache-Control', `public, s-maxage=${FIFTEEN_MIN / 1000}, stale-while-revalidate=${STALE_REVALIDATE_SEC}`);
  res.setHeader('CDN-Cache-Control', `public, s-maxage=${FIFTEEN_MIN / 1000}`);

  const q = (req.query.q ?? '#21MWITHPRIVACY').toString(); // cashtag by default
  const now = Date.now();
  const cached = cache.get(q);

  // Serve warm in-memory cache (avoid hitting X within 15 min)
  if (cached && now - cached.timestamp < FIFTEEN_MIN) {
    return res.status(200).json(cached.payload);
  }

  // Compute 24h window
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);

  // Build query for X v2 counts
  const params = new URLSearchParams({
    query: q,                // e.g. "$ZEN" or "#ZEN -is:retweet"
    granularity: 'hour',
    start_time: start.toISOString(),
    end_time: end.toISOString()
  });

  try {
    const r = await fetch(`https://api.x.com/2/tweets/counts/recent?${params}`, {
      headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }
    });

    if (!r.ok) {
      // fallback to stale cache if we have it
      if (cached) return res.status(200).json(cached.payload);
      const text = await r.text();
      return res.status(r.status).json({ error: 'X API error', status: r.status, detail: text });
    }

    const data = await r.json(); // { data: [{start, end, tweet_count}], meta: { ... } }
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
    // fallback to stale cache if network fails
    if (cached) return res.status(200).json(cached.payload);
    return res.status(500).json({ error: 'server_error', detail: String(e) });
  }
}
