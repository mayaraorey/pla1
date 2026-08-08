import crypto from 'crypto';

export default function handler(req, res) {
  // CORS: allow browser-based fetch() calls, including preflight requests
  // triggered by custom headers like x-api-key. Native apps (NSPlayer, etc.)
  // never send preflight requests, which is why this only affected the
  // browser-based HTML page and not the direct M3U URL in a player app.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-api-key, Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    if (req.headers['x-api-key'] !== process.env.API_SECRET) {
      return res.status(404).json({ error: "Not found" });
    }

    const { hours, server } = req.query;
    const validHours = hours ? parseInt(hours, 10) : 720;
    if (isNaN(validHours) || validHours <= 0) {
      return res.status(400).json({ error: "Invalid hours parameter" });
    }

    const expires = Date.now() + validHours * 3600000;
    const secret = process.env.API_SECRET;
    if (!secret) {
      return res.status(500).json({ error: "API_SECRET not configured" });
    }

    const token = crypto.createHmac('sha256', secret).update(`playlist:${expires}`).digest('hex');

    // All available playlist servers
    const servers = {
      primary: 'https://serverfile-sigma.vercel.app',
      backup: 'https://chillboxv1.vercel.app',
      chillbox: 'https://chillbox-one.vercel.app'
    };

    // Default to whichever domain actually received this request, instead
    // of a hardcoded domain. This way each deployment defaults to serving
    // its own playlist rather than silently pointing at a domain that
    // might be down (e.g. chillbox-one). ?server= still works to force
    // a specific target for testing.
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const selfUrl = `${protocol}://${host}`;

    const selectedServer = server && servers[server] ? servers[server] : selfUrl;
    const url = `${selectedServer}/api/playlist?token=${token}&expires=${expires}`;

    // Return all server options
    res.status(200).json({
      success: true,
      type: 'playlist',
      channel: 'all',
      url: url,
      expires: new Date(expires).toISOString(),
      valid_for_hours: validHours,
      servers: {
        primary: `${servers.primary}/api/playlist?token=${token}&expires=${expires}`,
        backup: `${servers.backup}/api/playlist?token=${token}&expires=${expires}`,
        chillbox: `${servers.chillbox}/api/playlist?token=${token}&expires=${expires}`
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
}
