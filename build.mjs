// 发布构建：npm run build → dist/，里面就是要上传到 DeWEB 容器的全部文件。
//   dist/index.html        压缩后的页面
//   dist/style.css         压缩后的样式
//   dist/src/theme.js      <head> 里同步执行的普通脚本（主题 / 语言，必须单独一个文件）
//   dist/src/app.js        其余全部模块打包成一个 ES module
// 路径与源码目录一致，index.html 不用改引用；本地开发照旧直接用源码。
// 链上每个文件都要单独写入，打包成一个文件可以少很多笔交易。

import { build } from 'esbuild';
import { readFile, writeFile, rm, mkdir, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(ROOT, 'dist');
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

await rm(DIST, { recursive: true, force: true });
await mkdir(join(DIST, 'src'), { recursive: true });

const common = {
  minify: true,
  target: 'es2022',
  charset: 'utf8',      // 中文原样保留，不转成 \uXXXX（签名文字也是中文，体积小一半）
  legalComments: 'none',
  logLevel: 'warning',
};

await build({ ...common, entryPoints: [join(ROOT, 'src/app.js')], bundle: true, format: 'esm', outfile: join(DIST, 'src/app.js') });
await build({ ...common, entryPoints: [join(ROOT, 'src/theme.js')], bundle: false, outfile: join(DIST, 'src/theme.js') });
await build({ ...common, entryPoints: [join(ROOT, 'style.css')], loader: { '.css': 'css' }, outfile: join(DIST, 'style.css') });

// HTML：去注释，连续空白合并成一个空格（不整段删除：行内元素之间的空格会显示出来）。
// 页面里没有 <pre>/<textarea> 静态内容，合并空白不影响显示。
const html = (await readFile(join(ROOT, 'index.html'), 'utf8'))
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\s+/g, ' ')
  .replace(/> </g, (m, i, all) => (blockBoundary(all, i) ? '><' : m))
  .trim();
await writeFile(join(DIST, 'index.html'), html + '\n');

// ---------------------------------------------------------------- 自检
const files = await list(DIST);
const text = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(join(DIST, f), 'utf8')])));
const fail = (msg) => { console.error('build check failed: ' + msg); process.exit(1); };

// 页面引用的每个本地文件都要在 dist 里
for (const ref of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) if (!files.includes(ref[1])) fail('missing ' + ref[1]);
// CSP 必须原样保留
if (!html.includes("connect-src 'none'")) fail('CSP connect-src changed');
// 不能混进测试或开发代码
for (const [f, s] of Object.entries(text)) if (/browser-mock|__rpc|secp256k1\.mjs/.test(s)) fail('dev/test code in ' + f);
// 钱包签名的固定文字必须原样在包里（见 crypto.keyMessage / legacy-store.signText）
for (const s of ['TapeVault 加密密钥', 'TapeVault 遗产托付：设置', 'TapeVault 遗产托付：报平安']) if (!text['src/app.js'].includes(s)) fail('signed text missing: ' + s);
// data-i18n 文案压缩后仍要能在英文词典里找到（键是元素的 innerHTML）
const { default: EN } = await import('./src/i18n-en.js');
for (const m of html.matchAll(/<(\w+)[^>]*\sdata-i18n(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) {
  if (!Object.hasOwn(EN, m[2].trim())) fail('i18n key changed by minify: ' + m[2].trim().slice(0, 60));
}
// 版本号与 package.json 一致
if (!html.includes(`TapeVault v${pkg.version}`)) fail(`footer version is not v${pkg.version}`);

let total = 0;
console.log(`TapeVault v${pkg.version} → dist/`);
for (const f of files) {
  const size = (await stat(join(DIST, f))).size;
  total += size;
  const sha = createHash('sha256').update(await readFile(join(DIST, f))).digest('hex');
  console.log(`  ${f.padEnd(16)} ${String(size).padStart(7)} B  sha256 ${sha.slice(0, 16)}…`);
}
console.log(`  ${'total'.padEnd(16)} ${String(total).padStart(7)} B  (${files.length} files)`);

async function list(dir, prefix = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + e.name;
    if (e.isDirectory()) out.push(...await list(join(dir, e.name), rel + '/'));
    else out.push(rel);
  }
  return out.sort();
}

/** 空格两边都是块级标签时可以删掉（不会显示）；行内元素之间的空格保留 */
function blockBoundary(all, i) {
  const BLOCK = /^(html|head|body|meta|title|link|script|header|main|footer|section|div|p|h[1-6]|ul|ol|li|dl|dt|dd|form|dialog|details|summary|svg|path|circle|rect)$/;
  const before = all.slice(0, i + 1).match(/<\/?([a-z0-9]+)[^<]*>$/i);
  const after = all.slice(i + 2).match(/^<\/?([a-z0-9]+)/i);
  return !!(before && after && BLOCK.test(before[1].toLowerCase()) && BLOCK.test(after[1].toLowerCase()));
}
