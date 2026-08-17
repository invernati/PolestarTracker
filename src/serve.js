#!/usr/bin/env node
// Servidor estático mínimo (sin dependencias) para public/.
// Uso: npm run serve  →  http://localhost:8787   (PORT=xxxx para cambiar puerto, HOST=0.0.0.0 para exponer en LAN)
// Sirve comprimido (brotli/gzip, zlib nativo) los ficheros de texto y responde 304 con ETag; los ficheros
// comprimidos se cachean en memoria y se invalidan al cambiar mtime/tamaño (p.ej. tras `npm run refresh`).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { brotliCompressSync, gzipSync, constants as Z } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { exec, spawn } from 'node:child_process';
import { MARKETS, MODELS } from './config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const NO_OPEN = process.argv.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']);
const MIN_COMPRESS = 1024;

// filePath → { mtimeMs, size, etag, raw, br, gzip }
const cache = new Map();

async function load(filePath, st) {
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const raw = await readFile(filePath);
  const entry = { mtimeMs: st.mtimeMs, size: st.size, etag: `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`, raw, br: null, gzip: null };
  if (COMPRESSIBLE.has(extname(filePath).toLowerCase()) && raw.length >= MIN_COMPRESS) {
    entry.br = brotliCompressSync(raw, { params: { [Z.BROTLI_PARAM_QUALITY]: 6, [Z.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    entry.gzip = gzipSync(raw, { level: 9 });
  }
  cache.set(filePath, entry);
  return entry;
}

function pickEncoding(req, entry) {
  const ae = String(req.headers['accept-encoding'] || '');
  if (entry.br && /\bbr\b/.test(ae)) return 'br';
  if (entry.gzip && /\bgzip\b/.test(ae)) return 'gzip';
  return null;
}

// ---------------------------------------------------------------------------
// Refresco bajo demanda desde la web (solo servidor local): POST /api/refresh lanza `node src/fetch.js`
// (uno a la vez) y GET /api/status devuelve el progreso (últimas líneas de la salida).
// En hosting estático (GitHub Pages…) estas rutas no existen y la web oculta el botón.
// ---------------------------------------------------------------------------
const refresh = { running: false, startedAt: null, finishedAt: null, exitCode: null, log: [], lastLine: '', scope: null };
const VALID_MARKETS = new Set(MARKETS.map((m) => m.api));
const VALID_MODELS = new Set(Object.values(MODELS).map((m) => m.short));
/** Convierte el alcance pedido por la web en argumentos de fetch.js (solo valores de la config: nada de inyección). */
function scopeArgs(scope) {
  const args = [];
  const markets = Array.isArray(scope?.markets) ? scope.markets.filter((m) => VALID_MARKETS.has(m)) : [];
  const models = Array.isArray(scope?.models) ? scope.models.filter((m) => VALID_MODELS.has(m)) : [];
  if (markets.length && markets.length < VALID_MARKETS.size) args.push('--market=' + markets.join(','));
  if (models.length && models.length < VALID_MODELS.size) args.push('--model=' + models.join(','));
  if (scope?.source === 'preowned' || scope?.source === 'stock') args.push('--only=' + scope.source);
  const delay = Number(scope?.delay);
  if (Number.isFinite(delay) && delay >= 500 && delay <= 10000) args.push('--delay=' + Math.round(delay));
  return { args, markets, models, source: scope?.source ?? null, partial: args.some((a) => !a.startsWith('--delay=')) };
}
function startRefresh(scope) {
  if (refresh.running) return false;
  const sc = scopeArgs(scope);
  Object.assign(refresh, { running: true, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, log: [], lastLine: '', scope: sc });
  const child = spawn(process.execPath, [join(ROOT, 'src', 'fetch.js'), ...sc.args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      refresh.log.push(line); if (refresh.log.length > 200) refresh.log.shift();
      refresh.lastLine = line;
    }
  };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.on('close', (code) => { refresh.running = false; refresh.exitCode = code; refresh.finishedAt = new Date().toISOString(); });
  child.on('error', (e) => { refresh.running = false; refresh.exitCode = -1; refresh.finishedAt = new Date().toISOString(); refresh.log.push('ERROR: ' + e.message); });
  return true;
}
function json(res, code, obj) { const body = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) }); res.end(body); }

const server = createServer(async (req, res) => {
  try {
    const pathname = (() => { try { return new URL(req.url, 'http://x').pathname; } catch { return ''; } })();
    if (pathname === '/api/status') return json(res, 200, { ...refresh, log: refresh.log.slice(-15) });
    if (pathname === '/api/refresh') {
      if (req.method !== 'POST') { res.writeHead(405); return res.end('method not allowed'); }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 10000) break; }
      let scope = null;
      try { scope = body ? JSON.parse(body) : null; } catch { return json(res, 400, { error: 'JSON inválido' }); }
      const started = startRefresh(scope);
      return json(res, started ? 202 : 409, { started, running: refresh.running, startedAt: refresh.startedAt, scope: refresh.scope });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end('bad request'); }
    if (urlPath === '/') urlPath = '/index.html';
    const base = normalize(join(ROOT, 'public'));
    const filePath = normalize(join(base, urlPath));
    // Solo ficheros dentro de public/ (ni "..", ni un directorio hermano cuyo nombre empiece por "public").
    if (filePath !== base && !filePath.startsWith(base + sep)) {
      res.writeHead(403); return res.end('forbidden');
    }
    const st = await stat(filePath).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    const entry = await load(filePath, st);
    const headers = {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      // Siempre revalidar (los datos cambian con cada refresco), pero con ETag el navegador recibe 304 sin cuerpo.
      'Cache-Control': 'no-cache',
      'ETag': entry.etag,
      'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      'Vary': 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
    const enc = pickEncoding(req, entry);
    const body = enc === 'br' ? entry.br : enc === 'gzip' ? entry.gzip : entry.raw;
    if (enc) headers['Content-Encoding'] = enc;
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`Polestar Tracker → ${url}${HOST !== '127.0.0.1' ? `  (escuchando en ${HOST})` : ''}   (Ctrl+C para parar)`);
  if (!NO_OPEN) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
