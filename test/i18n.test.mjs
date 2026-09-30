// 核对英文词典：界面里每一条 t('中文') 都要有英文，占位符一致；index.html 的 data-i18n 文案也要有英文。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import EN from '../src/i18n-en.js';
import { t } from '../src/i18n.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const unquote = (q) => q.slice(1, -1).replace(/\\n/g, '\n').replace(/\\(['"\\])/g, '$1');

function sourceKeys() {
  const keys = new Set();
  for (const f of readdirSync(new URL('src/', root))) {
    if (!f.endsWith('.js') || f.startsWith('i18n')) continue;
    for (const m of read('src/' + f).matchAll(/\bt\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g)) keys.add(unquote(m[1]));
  }
  return keys;
}

function htmlKeys() {
  const html = read('index.html');
  const keys = new Set([html.match(/<title>(.*?)<\/title>/)[1]]);
  for (const m of html.matchAll(/<(\w+)[^>]*\sdata-i18n(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) keys.add(m[2].trim());
  for (const m of html.matchAll(/data-i18n-(?:aria|title|placeholder)="([^"]*)"/g)) keys.add(m[1]);
  return keys;
}

const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('每条界面文案都有英文翻译，占位符一致', () => {
  const missing = [];
  const bad = [];
  for (const k of [...sourceKeys(), ...htmlKeys()]) {
    if (!Object.hasOwn(EN, k)) missing.push(k);
    else if (holes(k) !== holes(EN[k])) bad.push(k);
  }
  assert.deepEqual(missing, [], '缺少英文：\n' + missing.join('\n'));
  assert.deepEqual(bad, [], '占位符不一致：\n' + bad.join('\n'));
});

test('英文翻译里不残留中文', () => {
  const cjk = Object.entries(EN).filter(([, v]) => /[\u4e00-\u9fff（），。：；「」]/.test(v)).map(([k]) => k);
  assert.deepEqual(cjk, []);
});

test('t() 默认返回中文原文并替换占位符', () => {
  assert.equal(t('碎片 {0} 内容不对', [3]), '碎片 3 内容不对');
  assert.equal(t('没有这条'), '没有这条');
});

test('签名文字不走翻译：keyMessage 与 signText 保持固定中文', async () => {
  const { keyMessage } = await import('../src/crypto.js');
  assert.match(keyMessage('0xAbC', 56), /^TapeVault 加密密钥\n/);
  assert.doesNotMatch(read('src/crypto.js').match(/export function keyMessage[\s\S]*?\n}\n/)[0], /\bt\(/);
  assert.doesNotMatch(read('src/legacy-store.js').match(/export async function signText[\s\S]*?\n}\n/)[0], /\bt\(/);
});
