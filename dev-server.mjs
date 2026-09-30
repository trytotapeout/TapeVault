// 本地开发服务器（不上链）：node dev-server.mjs [端口]
// 静态托管本目录。另外提供 /__rpc 转发到 BSC 公共节点，并把页面 CSP 的 connect-src 放宽为 'self'，
// 仅用于在没有钱包扩展的浏览器里注入模拟钱包做测试。上链版本不包含这个文件，页面 CSP 仍是 connect-src 'none'。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 5178);
const RPC = process.env.RPC || 'https://bsc-dataseed.bnbchain.org';
const ALLOWED = new Set(['eth_call', 'eth_blockNumber', 'eth_chainId']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

createServer(async (req, res) => {
  try {
    if (req.url === '/__rpc' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 1e6) throw new Error('too large'); }
      const msg = JSON.parse(body);
      if (!ALLOWED.has(msg.method)) { res.writeHead(403).end(); return; }
      const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text());
      return;
    }
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT) || p.includes('/.')) { res.writeHead(404).end(); return; }
    let data = await readFile(file);
    if (extname(file) === '.html') data = Buffer.from(data.toString().replace("connect-src 'none'; base-uri", "connect-src 'self'; base-uri"));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
  } catch {
    res.writeHead(404).end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`TapeVault dev: http://127.0.0.1:${PORT}/`));
