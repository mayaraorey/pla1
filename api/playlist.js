import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-api-key, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

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
    if (fs.existsSync(filterPath)) { try { filter = JSON.parse(fs.readFileSync(filterPath, 'utf-8')); } catch(e) {} }

    let channelMap = {};
    let debugInfo = [];

    if (fs.existsSync(sourcesPath)) {
      const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf-8'));
      const enabledSources = sources.filter(s => s.enabled);

      const results = await Promise.all(enabledSources.map(async (source) => {
        try { const { content, error } = await fetchUrl(source.url); return { source, content, fetchError: error }; }
        catch (e) { return { source, content: null, fetchError: e.message }; }
      }));

      for (const { source, content, fetchError } of results) {
        if (fetchError) { debugInfo.push(`${source.name}: FETCH FAILED`); continue; }
        debugInfo.push(`${source.name}: ${content.length} bytes`);
        if (!content || content.length < 10) { debugInfo.push(`${source.name}: EMPTY`); continue; }

        let parsed = [];
        try {
          const json = JSON.parse(content);
          const list = json.channels || (Array.isArray(json) ? json : []);
          if (list.length > 0) {
            parsed = list.map(ch => ({
              name: ch.name || 'Unknown', logo: ch.logo || null,
              group: ch.category || ch.group || 'General', language: ch.language || '',
              servers: [{ name: 'HD', url: ch.mpd || ch.stream_url || ch.url,
                drm: (ch.keyId || ch.key_id) ? 'clearkey' : '',
                license: (ch.keyId || ch.key_id) + ':' + (ch.key || ''),
                cookie: ch.cookie || '', referer: 'https://www.jiotv.com/', origin: 'https://www.jiotv.com/' }]
            }));
          }
        } catch {
          if (content.includes('#EXTINF') || content.includes('#EXTM3U')) { parsed = parseM3U(content); }
          else if (content.includes('<!DOCTYPE') || content.includes('<html')) { debugInfo.push(`${source.name}: HTML`); continue; }
        }
        debugInfo.push(`${source.name}: ${parsed.length} channels`);

        for (const ch of parsed) {
          if (!ch.servers || ch.servers.length === 0) continue;
          for (const srv of ch.servers) {
            if (!srv.url || srv.url.length < 5) continue;
            // Skip geo-blocked Astro streams
            if (srv.url.includes('linearjitp-playback.astro.com.my')) continue;
            const flat = { name: ch.name, logo: ch.logo, group: ch.group, language: ch.language,
              clearKey: srv.drm ? srv.license : null, cookie: srv.cookie || '', referer: srv.referer || '', origin: srv.origin || '', url: srv.url };
            if (!shouldKeep(flat, filter)) continue;
            addCh(channelMap, flat);
          }
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
          if (srv.cookie) playlist += `#EXTVLCOPT:http-cookie=${srv.cookie}\n`;
          if (srv.referer) playlist += `#EXTVLCOPT:http-referrer=${srv.referer}\n`;
          if (srv.origin) playlist += `#EXTVLCOPT:http-origin=${srv.origin}\n`;
          playlist += `${srv.url}\n`;
        }
      }
    }

    res.setHeader('Content-Type', 'audio/x-mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(playlist);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

function extractName(line) {
  const stdMatch = line.match(/,([^,]+)$/);
  if (stdMatch && stdMatch[1].trim().length > 1) return stdMatch[1].trim();
  const quotes = line.split('"');
  if (quotes.length >= 2) { const after = quotes[quotes.length - 1].trim(); if (after && after.length > 1 && !after.startsWith('http')) return after; }
  return 'Unknown';
}

function fetchUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'IPTVPlayer/1.0', 'Accept': '*/*' }, timeout: 20000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) { fetchUrl(response.headers.location).then(resolve); return; }
      if (response.statusCode !== 200) { resolve({ content: '', error: `HTTP ${response.statusCode}` }); return; }
      let data = ''; response.on('data', chunk => data += chunk); response.on('end', () => resolve({ content: data, error: null }));
      response.on('error', (err) => resolve({ content: '', error: err.message }));
    });
    req.on('error', (err) => resolve({ content: '', error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ content: '', error: 'timeout' }); });
  });
}

function parseM3U(content) {
  const lines = content.split('\n'); const channels = {};
  let cur = { name: '', logo: null, group: 'Chill Box', language: '', clearKey: null, cookie: null, referer: null, origin: null, url: null };
  let pendingClearKey = null, pendingCookie = null, pendingReferer = null, pendingOrigin = null;

  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;

    // KODIPROP - ClearKey
    if (l.startsWith('#KODIPROP:') && l.includes('license_key=')) { pendingClearKey = l.split('license_key=')[1]?.trim(); continue; }
    // EXTVLCOPT headers
    if (l.startsWith('#EXTVLCOPT:http-cookie=')) { pendingCookie = l.split('http-cookie=')[1]?.trim(); continue; }
    if (l.startsWith('#EXTVLCOPT:http-referrer=')) { pendingReferer = l.split('http-referrer=')[1]?.trim(); continue; }
    if (l.startsWith('#EXTVLCOPT:http-origin=')) { pendingOrigin = l.split('http-origin=')[1]?.trim(); continue; }
    // EXTHTTP JSON format
    if (l.startsWith('#EXTHTTP:')) {
      try { const json = JSON.parse(l.substring(9)); if (json.cookie) pendingCookie = json.cookie; if (json.Referer) pendingReferer = json.Referer; if (json.Origin) pendingOrigin = json.Origin; } catch {} 
      continue;
    }

    if (l.startsWith('#EXTINF:')) {
      if (cur.url && cur.name && cur.url.length > 5) addCh(channels, cur);
      cur = { name: extractName(l), logo: (l.match(/tvg-logo="([^"]+)"/) || [])[1] || null,
        group: (l.match(/group-title="([^"]+)"/) || [])[1] || 'Chill Box',
        language: (l.match(/tvg-language="([^"]+)"/) || [])[1] || '',
        clearKey: pendingClearKey, cookie: pendingCookie, referer: pendingReferer, origin: pendingOrigin, url: null };
      pendingClearKey = null; pendingCookie = null; pendingReferer = null; pendingOrigin = null;
    } else if ((l.startsWith('https://') || l.startsWith('http://')) && !l.startsWith('#')) {
      cur.url = l;
      if (cur.name && cur.url.length > 5) { addCh(channels, cur); cur = { name: '', logo: null, group: 'Chill Box', language: '', clearKey: null, cookie: null, referer: null, origin: null, url: null }; }
    }
  }
  if (cur.url && cur.name && cur.url.length > 5) addCh(channels, cur);
  return Object.values(channels);
}

function shouldKeep(channel, filter) {
  if (!filter || filter.mode === 'none') return true;
  const name = (channel.name || '').toLowerCase().trim();
  if (!filter.groups || Object.keys(filter.groups).length === 0) return true;
  for (const g of Object.values(filter.groups)) { for (const kw of (g.keywords || [])) { if (name.includes(kw.toLowerCase().trim())) return true; } }
  return false;
}

function addCh(dict, ch) {
  if (!ch.url || ch.url.length < 5) return;
  let cleanUrl = ch.url;
  if (cleanUrl.includes('|')) cleanUrl = cleanUrl.substring(0, cleanUrl.indexOf('|'));
  let base = ch.name.replace(/\s+(HD|SD|4K|FHD|UHD)\s*$/gi, '').trim();
  if (!base) base = ch.name.trim();
  const srv = { name: 'SD', url: cleanUrl, drm: ch.clearKey ? 'clearkey' : '', license: ch.clearKey || '', cookie: ch.cookie || '', referer: ch.referer || '', origin: ch.origin || '' };
  const id = base.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!dict[id]) { dict[id] = { id, name: base, language: ch.language, logo: ch.logo, group: ch.group || 'Chill Box', servers: [srv] }; }
  else { if (!dict[id].servers.some(s => s.url === cleanUrl)) dict[id].servers.push(srv); }
}
