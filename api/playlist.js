import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

export default async function handler(req, res) {
  const { token, expires } = req.query;
  const SECRET = process.env.API_SECRET;

  if (token && expires) {
    const expected = crypto.createHmac('sha256', SECRET).update(`playlist:${expires}`).digest('hex');
    if (token !== expected) return res.status(403).send('Invalid token');
    if (Date.now() > parseInt(expires)) return res.status(403).send('Token expired');
  } else if (req.headers['x-api-key'] === SECRET) {
    // Valid
  } else {
    return res.status(404).send('Not found');
  }

  try {
    const sourcesPath = path.join(process.cwd(), 'data', 'sources.json');
    const filterPath = path.join(process.cwd(), 'data', 'filter.json');

    let filter = null;
    if (fs.existsSync(filterPath)) {
      try { filter = JSON.parse(fs.readFileSync(filterPath, 'utf-8')); } catch(e) {}
    }

    let channelMap = {};
    let debugInfo = [];

    if (fs.existsSync(sourcesPath)) {
      const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf-8'));

      for (const source of sources) {
        if (!source.enabled) continue;

        try {
          const content = await fetchUrl(source.url);
          debugInfo.push(`${source.name}: fetched ${content.length} bytes`);

          if (!content || content.length < 10) {
            debugInfo.push(`${source.name}: EMPTY response`);
            continue;
          }

          if (content.includes('<!DOCTYPE') || content.includes('<html')) {
            debugInfo.push(`${source.name}: Got HTML instead of M3U`);
            continue;
          }

          const parsed = parseM3U(content);
          debugInfo.push(`${source.name}: parsed ${parsed.length} channels`);

          // FIX: parseM3U() returns channels shaped as
          // { name, logo, group, language, servers: [{ name, url, drm, license }] }
          // — there is NO top-level `ch.url`. The old code checked `ch.url` here,
          // which is always undefined, so every channel was silently dropped.
          // We now flatten each channel's servers back into the flat shape
          // that addCh() expects, and merge those instead.
          for (const ch of parsed) {
            if (!ch.servers || ch.servers.length === 0) continue;
            for (const srv of ch.servers) {
              if (!srv.url || srv.url.length < 5) continue;
              const flat = {
                name: ch.name,
                logo: ch.logo,
                group: ch.group,
                language: ch.language,
                clearKey: srv.drm ? srv.license : null,
                url: srv.url
              };
              // if (!shouldKeep(flat, filter)) continue;
              addCh(channelMap, flat);
            }
          }
        } catch (e) {
          debugInfo.push(`${source.name}: ERROR - ${e.message}`);
        }
      }
    }

    const channels = Object.values(channelMap);

    let playlist = '#EXTM3U\n';
    playlist += `# CHILL BOX - ${channels.length} channels\n`;
    playlist += `# Debug: ${debugInfo.join(' | ')}\n`;

    for (const ch of channels) {
      if (ch.servers && ch.servers.length > 0) {
        for (const srv of ch.servers) {
          if (!srv.url || srv.url.length < 5) continue;
          playlist += `#EXTINF:-1 tvg-language="${ch.language||''}" tvg-logo="${ch.logo||''}" group-title="${ch.group||'Chill Box'}" server-name="${srv.name}",${ch.name}\n`;
          if (srv.drm) playlist += `#KODIPROP:inputstream.adaptive.license_type=${srv.drm}\n`;
          if (srv.license) playlist += `#KODIPROP:inputstream.adaptive.license_key=${srv.license}\n`;
          playlist += `${srv.url}\n`;
        }
      }
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(playlist);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

function extractName(line) {
  const stdMatch = line.match(/,([^,]+)$/);
  if (stdMatch && stdMatch[1].trim().length > 1) return stdMatch[1].trim();
  const quotes = line.split('"');
  if (quotes.length >= 2) {
    const after = quotes[quotes.length - 1].trim();
    if (after && after.length > 1 && !after.startsWith('http')) return after;
  }
  return 'Unknown';
}

function fetchUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        fetchUrl(response.headers.location).then(resolve);
        return;
      }
      if (response.statusCode !== 200) {
        resolve('');
        return;
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve(data));
      response.on('error', () => resolve(''));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

function parseM3U(content) {
  const lines = content.split('\n');
  const channels = {};
  let cur = { name: '', logo: null, group: 'Chill Box', language: '', clearKey: null, url: null, serverName: null };
  let pendingClearKey = null;

  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith('#KODIPROP:') && l.includes('license_key=')) {
      pendingClearKey = l.split('license_key=')[1]?.trim();
      continue;
    }
    if (l.startsWith('#EXTINF:')) {
      if (cur.url && cur.name && cur.url.length > 5) addCh(channels, cur);
      cur = {
        name: extractName(l),
        logo: (l.match(/tvg-logo="([^"]+)"/) || [])[1] || null,
        group: (l.match(/group-title="([^"]+)"/) || [])[1] || 'Chill Box',
        language: (l.match(/tvg-language="([^"]+)"/) || [])[1] || '',
        clearKey: pendingClearKey,
        url: null,
        serverName: null
      };
      pendingClearKey = null;
    } else if ((l.startsWith('https://') || l.startsWith('http://')) && !l.startsWith('#')) {
      cur.url = l;
      if (cur.name && cur.url.length > 5) {
        addCh(channels, cur);
        cur = { name: '', logo: null, group: 'Chill Box', language: '', clearKey: null, url: null, serverName: null };
      }
    }
  }
  if (cur.url && cur.name && cur.url.length > 5) addCh(channels, cur);
  return Object.values(channels);
}

function shouldKeep(channel, filter) {
  if (!filter) return true;
  const name = (channel.name || '').toLowerCase().trim();
  if (!filter.groups || Object.keys(filter.groups).length === 0) return true;
  for (const g of Object.values(filter.groups)) {
    for (const kw of (g.keywords || [])) {
      if (name.includes(kw.toLowerCase().trim())) return true;
    }
  }
  return false;
}

function addCh(dict, ch) {
  if (!ch.url || ch.url.length < 5) return;
  let base = ch.name.replace(/\s+(HD|SD|4K|FHD|UHD)\s*$/gi, '').trim();
  if (!base) base = ch.name.trim();
  const srv = { name: 'SD', url: ch.url, drm: ch.clearKey ? 'clearkey' : '', license: ch.clearKey || '' };
  const id = base.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!dict[id]) {
    dict[id] = { id, name: base, language: ch.language, logo: ch.logo, group: ch.group || 'Chill Box', servers: [srv] };
  } else {
    if (!dict[id].servers.some(s => s.url === ch.url)) dict[id].servers.push(srv);
  }
}
