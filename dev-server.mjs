// 本地开发服务器（不上链）：node dev-server.mjs [端口] [--dist]
// --dist：托管 npm run build 的产物（dist/），用来在发布前检查压缩版；dist 里没有的文件（/test/ 模拟钱包及其引用的源码模块）从源码目录读。
// 静态托管本目录。另外提供 /__rpc 转发到 BSC 公共节点，并把页面 CSP 的 connect-src 放宽为 'self'，
// 仅用于在没有钱包扩展的浏览器里注入模拟钱包做测试。上链版本不包含这个文件，页面 CSP 仍是 connect-src 'none'。

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const DIST_MODE = process.argv.includes('--dist');
const ROOT = DIST_MODE ? join(SRC, 'dist/') : SRC;
const PORT = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || process.env.PORT || 5178);
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
    if (p.includes('/.')) { res.writeHead(404).end(); return; }
    // dist 模式：先找 dist/；找不到再回源码目录（只给 /test/ 下的模拟钱包用，它引用了 src/abi.js 等源码模块）
    let file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(404).end(); return; }
    let data = await readFile(file).catch(() => null);
    if (!data && DIST_MODE) {
      file = normalize(join(SRC, p));
      if (!file.startsWith(SRC)) { res.writeHead(404).end(); return; }
      data = await readFile(file);
    }
    if (!data) throw new Error('not found');
    if (extname(file) === '.html') data = Buffer.from(data.toString().replace("connect-src 'none'; base-uri", "connect-src 'self'; base-uri"));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
  } catch {
    res.writeHead(404).end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`TapeVault dev${DIST_MODE ? ' (dist)' : ''}: http://127.0.0.1:${PORT}/`));
