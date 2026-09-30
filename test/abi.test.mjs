import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCall, decodeResult, decodeAggregate3, hexToBytes, bytesToHex } from '../src/abi.js';
import { SIG, SEL } from '../src/config.js';
import { parseFolderInput, folderLabel, loadCache, saveCache } from '../src/folders.js';
import { keccakHex } from '../src/keccak.js';

test('selectors match keccak256 of signatures', () => {
  for (const k of Object.keys(SIG)) {
    assert.equal(SEL[k], keccakHex(new TextEncoder().encode(SIG[k])).slice(0, 10), k);
  }
});

test('encode static args', () => {
  const d = encodeCall(SEL.accountOf, ['address', 'uint'], ['0x50A994E71615474B55559ff4f500928fbc339dd9', 4246]);
  assert.equal(d, SEL.accountOf
    + '00000000000000000000000050a994e71615474b55559ff4f500928fbc339dd9'
    + '0000000000000000000000000000000000000000000000000000000000001096');
});

test('encode string arg (fileInfo)', () => {
  const d = encodeCall(SEL.fileInfo, ['address', 'string'], ['0x' + '11'.repeat(20), 'ab']);
  const body = d.slice(10);
  assert.equal(body.slice(64, 128), '40'.padStart(64, '0'));   // offset
  assert.equal(body.slice(128, 192), '2'.padStart(64, '0'));   // length
  assert.equal(body.slice(192, 256), '6162'.padEnd(64, '0'));
});

test('encode aggregate3 matches reference layout', () => {
  // 两个调用：target=0x..01 allowFailure=true callData=0xaabbccdd；target=0x..02 callData=0x
  const d = encodeCall(SEL.aggregate3, ['call3[]'], [[
    { target: '0x' + '0'.repeat(39) + '1', allowFailure: true, callData: '0xaabbccdd' },
    { target: '0x' + '0'.repeat(39) + '2', allowFailure: true, callData: '0x' },
  ]]);
  const w = (d.slice(10).match(/.{64}/g));
  assert.equal(BigInt('0x' + w[0]), 0x20n);       // 数组偏移
  assert.equal(BigInt('0x' + w[1]), 2n);          // 长度
  assert.equal(BigInt('0x' + w[2]), 0x40n);       // 第 1 个元组偏移（相对数组元素区起点）
  assert.equal(BigInt('0x' + w[3]), 0x40n + 0xa0n); // 第 1 个元组 5 个字：addr,bool,off,len,data
  assert.equal(BigInt('0x' + w[4]), 1n);          // target
  assert.equal(BigInt('0x' + w[5]), 1n);          // allowFailure
  assert.equal(BigInt('0x' + w[6]), 0x60n);       // bytes 偏移（相对元组起点）
  assert.equal(BigInt('0x' + w[7]), 4n);
  assert.equal(w[8], 'aabbccdd'.padEnd(64, '0'));
  assert.equal(BigInt('0x' + w[9]), 2n);
  assert.equal(BigInt('0x' + w[11]), 0x60n);
  assert.equal(BigInt('0x' + w[12]), 0n);         // 空 bytes
  assert.equal(w.length, 13);
});

test('decode aggregate3 result', () => {
  // [(true, 0x…2a), (false, 0x)]
  const words = [
    '20', '2', '40', 'c0',
    '1', '40', '20', '2a'.padStart(64, '0'),
    '0', '40', '0',
  ].map((x) => x.length === 64 ? x : BigInt('0x' + x).toString(16).padStart(64, '0'));
  const r = decodeAggregate3('0x' + words.join(''));
  assert.equal(r.length, 2);
  assert.equal(r[0].success, true);
  assert.deepEqual(decodeResult(['uint'], r[0].returnData), [42n]);
  assert.equal(r[1].success, false);
  assert.equal(r[1].returnData, '0x');
});

test('decode string[]', () => {
  const words = ['20', '2', '40', '80', '1', '61'.padEnd(64, '0'), '2', '6263'.padEnd(64, '0')]
    .map((x) => x.length === 64 ? x : BigInt('0x' + x).toString(16).padStart(64, '0'));
  assert.deepEqual(decodeResult(['string[]'], '0x' + words.join('')), [['a', 'bc']]);
});

test('decode rejects dirty address', () => {
  assert.throws(() => decodeResult(['address'], '0x' + 'f'.repeat(64)));
});

test('hex roundtrip', () => {
  assert.equal(bytesToHex(hexToBytes('0x00ff10')), '0x00ff10');
  assert.throws(() => hexToBytes('0xabc'));
});

test('folder input parsing', () => {
  assert.deepEqual(parseFolderInput('4246.0'), { tokenId: 4246, cpu: 0 });
  assert.deepEqual(parseFolderInput(' 4246.0.tape '), { tokenId: 4246, cpu: 0 });
  assert.deepEqual(parseFolderInput('#12@3'), { tokenId: 12, cpu: 3 });
  assert.equal(parseFolderInput('0.0'), null);
  assert.equal(parseFolderInput('abc'), null);
  assert.equal(parseFolderInput('1.2.344'), null);   // 多链写法暂不支持（只做 BNB）
  assert.equal(folderLabel(4246, 0), '4246.0.tape');
});

test('folder cache roundtrip ignores junk', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  saveCache(storage, '0xABC', [{ tokenId: 1, cpu: 0, owner: 'x' }]);
  assert.deepEqual(loadCache(storage, '0xabc'), [{ tokenId: 1, cpu: 0 }]);
  mem.set('tapevault:folders:0xdef', '{bad');
  assert.deepEqual(loadCache(storage, '0xdef'), []);
});
