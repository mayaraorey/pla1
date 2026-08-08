import crypto from 'crypto';

export default function handler(req, res) {
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
    
    // Select server (default: chillbox)
    const selectedServer = server && servers[server] ? servers[server] : servers.chillbox;
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
