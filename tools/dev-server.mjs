// Локальный сервер для разработки: статика + приём демо-данных (POST /__save?name=файл → demo/).
// Слушает только 127.0.0.1 и ::1. На опубликованном сайте его нет.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8123);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png' };
const handler = async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  try {
    if (req.method === 'POST' && url.pathname === '/__save') {
      if (req.headers.origin && req.headers.origin !== `http://localhost:${port}`) { res.writeHead(403).end(); return; }
      const name = path.basename(url.searchParams.get('name') || '');
      if (!/^[\w.-]+\.(json|wav|mp3)$/.test(name)) { res.writeHead(400).end('bad name'); return; }
      const chunks = []; for await (const c of req) chunks.push(c);
      const dir = path.join(root, url.searchParams.get('dir') === 'local' ? 'local' : 'demo');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, name), Buffer.concat(chunks));
      res.writeHead(200).end('ok'); return;
    }
    let p = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (p !== root && !p.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    if (url.pathname.includes('/.git')) { res.writeHead(403).end(); return; }
    if (url.pathname.endsWith('/')) p = path.join(p, 'index.html');
    const data = await readFile(p);
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
  } catch { res.writeHead(404).end('not found'); }
};
for (const host of ['127.0.0.1', '::1']) http.createServer(handler).on('error', e => console.error(host, e.message)).listen(port, host, () => console.log(`http://localhost:${port} (${host})`));
