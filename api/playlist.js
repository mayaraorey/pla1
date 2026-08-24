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

  const { token, expires, validate } = req.query;
  const SECRET = process.env.API_SECRET;
  const shouldValidate = validate === 'true' || validate === '1';

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
      const enabledSources = sources.filter(s => s.enabled);

      const results = await Promise.all(enabledSources.map(async (source) => {
        try { 
          const { content, error } = await fetchUrl(source.url); 
          return { source, content, fetchError: error }; 
        }
        catch (e) { 
          return { source, content: null, fetchError: e.message }; 
        }
      }));

      for (const { source, content, fetchError } of results) {
        if (fetchError) { 
          debugInfo.push(`${source.name}: FETCH FAILED`); 
          continue; 
        }
        if (!content || content.length < 10) { 
          debugInfo.push(`${source.name}: EMPTY`); 
          continue; 
        }

        let parsed = [];
        try {
          const json = JSON.parse(content);
          const list = json.channels || (Array.isArray(json) ? json : []);
          if (list.length > 0) {
            parsed = list.map(ch => ({
              name: ch.name || 'Unknown', 
              logo: ch.logo || null,
              group: ch.category || ch.group || 'General', 
              language: ch.language || '',
              servers: [{ 
                name: 'HD', 
                url: ch.mpd || ch.stream_url || ch.url,
                drm: (ch.keyId || ch.key_id) ? 'clearkey' : '',
                license: (ch.keyId || ch.key_id) + ':' + (ch.key || ''),
                cookie: ch.cookie || '', 
                referer: ch.referer || 'https://www.jiotv.com/', 
                origin: ch.origin || 'https://www.jiotv.com/' 
              }]
            }));
          }
        } catch {
          if (content.includes('#EXTINF') || content.includes('#EXTM3U')) { 
            parsed = parseM3U(content); 
          }
        }
        debugInfo.push(`${source.name}: ${parsed.length} channels parsed`);

        const sourceFilter = source.filter || null;

        for (const ch of parsed) {
          if (!ch.servers || ch.servers.length === 0) continue;
          for (const srv of ch.servers) {
            if (!srv.url || srv.url.length < 5) continue;
            if (srv.url.includes('linearjitp-playback.astro.com.my')) continue;
            
            const flat = { 
              name: ch.name, 
              logo: ch.logo, 
              group: ch.group, 
              language: ch.language,
              clearKey: srv.drm ? srv.license : null, 
              cookie: srv.cookie || '', 
              referer: srv.referer || '', 
              origin: srv.origin || '', 
              url: srv.url 
            };
            
            if (!shouldKeep(flat, filter)) continue;
            if (sourceFilter && !shouldKeepBySourceFilter(flat, sourceFilter)) continue;
            
            addCh(channelMap, flat);
          }
        }
      }
    }

    let channels = Object.values(channelMap);
    let totalBeforeValidate = channels.length;

    // Validate servers - only return working ones
    if (shouldValidate) {
      debugInfo.push(`Validating ${channels.length} channels...`);
      
      const batchSize = 10;
      const validatedChannels = [];
      
      for (let i = 0; i < channels.length; i += batchSize) {
        const batch = channels.slice(i, i + batchSize);
        
        const results = await Promise.all(batch.map(async (ch) => {
          // Test all servers for this channel
          const workingServers = [];
          
          for (const server of ch.servers) {
            if (!server.url) continue;
            
            const alive = await isStreamAlive(server.url);
            if (alive) {
              workingServers.push(server);
            }
          }
          
          // Only return channel if at least one server works
          if (workingServers.length > 0) {
            return {
              ...ch,
              servers: workingServers // Only working servers
            };
          }
          return null;
        }));
        
        const validResults = results.filter(Boolean);
        validatedChannels.push(...validResults);
        debugInfo.push(`Batch ${Math.floor(i/batchSize)+1}: ${validResults.length}/${batch.length} channels with working servers`);
      }
      
      channels = validatedChannels;
      debugInfo.push(`Validation complete: ${channels.length}/${totalBeforeValidate} channels have working servers`);
    }

    let playlist = '#EXTM3U\n';
    playlist += `# CHILL BOX - ${channels.length} channels`;
    if (shouldValidate) playlist += ` (validated)`;
    playlist += '\n';
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
  } catch (e) { 
    res.status(500).json({ error: e.message }); 
  }
}

// Updated isStreamAlive with DRM support
function isStreamAlive(url, clearKey = null) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: { 'User-Agent': 'IPTVPlayer/1.0' },
      timeout: 8000
    }, (res) => {
      if (res.statusCode === 200 || res.statusCode === 302 || res.statusCode === 301) {
        resolve(true);
      } else {
        // For DRM streams, 403 might still work with proper headers
        if (res.statusCode === 403 && clearKey) {
          resolve(true);
        } else {
          resolve(false);
        }
      }
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
