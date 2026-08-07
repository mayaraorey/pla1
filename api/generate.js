import crypto from 'crypto';

export default function handler(req, res) {
  try {
    if (req.headers['x-api-key'] !== process.env.API_SECRET) {
      return res.status(404).json({ error: "Not found" });
    }
    const { hours } = req.query;
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
    const url = `https://serverfile-sigma.vercel.app/api/playlist?token=${token}&expires=${expires}`;
    res.status(200).json({
      success: true,
      type: 'playlist',
      channel: 'all',
      url: url,
      expires: new Date(expires).toISOString(),
      valid_for_hours: validHours
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
}
