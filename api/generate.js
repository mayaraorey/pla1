import crypto from 'crypto';

export default function handler(req, res) {
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
    
    const expires = Date.now() + validHours * 3600000;
    const secret = process.env.API_SECRET;
    const token = crypto.createHmac('sha256', secret).update(`playlist:${expires}`).digest('hex');

    const servers = {
      primary: 'https://serverfile-sigma.vercel.app',
      backup: 'https://chillboxv1.vercel.app',
      chillbox: 'https://chillbox-one.vercel.app'
    };

    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const selfUrl = `${protocol}://${host}`;

    const selectedServer = server && servers[server] ? servers[server] : selfUrl;
    
    // Always validate - only return working servers
    const url = `${selectedServer}/api/playlist?token=${token}&expires=${expires}&validate=true`;

    res.status(200).json({
      success: true,
      type: 'playlist',
      channel: 'all',
      url: url,
      validated: true,
      expires: new Date(expires).toISOString(),
      valid_for_hours: validHours,
      servers: {
        primary: `${servers.primary}/api/playlist?token=${token}&expires=${expires}&validate=true`,
        backup: `${servers.backup}/api/playlist?token=${token}&expires=${expires}&validate=true`,
        chillbox: `${servers.chillbox}/api/playlist?token=${token}&expires=${expires}&validate=true`
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
}
