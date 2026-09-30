import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { decodeResult, hexToBytes, bytesToHex } = await import('../src/abi.js');
const { SEL, CHUNK_SIZE, VAULT_META } = await import('../src/config.js');
const { encryptFile, openHeader, decryptBody, deriveKeys, sha256Hex, OVERHEAD, HEADER_READ } = await import('../src/crypto.js');
const vault = await import('../src/vault.js');

const CONTAINER = '0x86ddaef00401e3f10418398d67d7189fc458ea95';

/** 模拟钱包签名：同一钱包对同一消息给出同一签名（RFC 6979 的效果） */
const fakeSigner = (seed) => async (msg) => {
  const h = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(seed + msg)));
  const sig = new Uint8Array(65);
  sig.set(h, 0); sig.set(h, 32); sig[64] = 27;
  return bytesToHex(sig);
};

/** 内存里的 SiteRegistry：执行 putFile / appendChunk 交易，提供 chain.js 同名的读方法 */
function fakeChain() {
  const files = new Map();
  let now = 1000;
  const exec = (tx) => {
    const args = '0x' + tx.data.slice(10);
    if (tx.data.startsWith(SEL.putFile)) {
      const [, path, contentType, sha, data] = decodeResult(['address', 'string', 'string', 'bytes32', 'bytes'], args);
      files.set(path, { bytes: hexToBytes(data), contentType, sha256: sha, updatedAt: ++now });
    } else if (tx.data.startsWith(SEL.appendChunk)) {
      const [, path, idx, data] = decodeResult(['address', 'string', 'uint', 'bytes'], args);
      const f = files.get(path);
      const chunks = Math.ceil(f.bytes.length / CHUNK_SIZE);
      assert.equal(Number(idx), chunks, 'expectIndex 必须等于当前块数');
      const add = hexToBytes(data);
      const merged = new Uint8Array(f.bytes.length + add.length);
      merged.set(f.bytes); merged.set(add, f.bytes.length);
      f.bytes = merged; f.updatedAt = ++now;
    } else throw new Error('unknown tx');
  };
  const info = (path) => {
    const f = files.get(path);
    return { path, size: f.bytes.length, contentType: f.contentType, sha256: f.sha256, updatedAt: f.updatedAt, chunkCount: Math.ceil(f.bytes.length / CHUNK_SIZE) };
  };
  return {
    files, exec,
    async vaultListing() {
      const all = [...files.keys()].filter((p) => p.startsWith('_tapevault/'));
      return { initialized: files.has(VAULT_META), meta: files.has(VAULT_META) ? info(VAULT_META) : null, files: all.filter((p) => p !== VAULT_META).map(info), otherFileCount: 0 };
    },
    async readHeads(_c, paths, len) { return new Map(paths.map((p) => [p, files.get(p).bytes.slice(0, len)])); },
    async readVerified(_c, path, i) {
      const b = files.get(path).bytes.slice();
      if (b.length !== i.size || (await sha256Hex(b)) !== i.sha256) throw new Error('SHA-256 校验失败');
      return b;
    },
  };
}

test('encrypt / decrypt roundtrip and tamper detection', async () => {
  const keys = await deriveKeys(await fakeSigner('a')('m'), CONTAINER);
  const body = new TextEncoder().encode('秘密内容'.repeat(100));
  const blob = await encryptFile(keys, 'ab'.repeat(16), { name: '遗嘱.txt', type: 'text/plain', mtime: 5 }, body);
  assert.equal(blob.length, body.length + OVERHEAD);
  const h = await openHeader(keys, 'ab'.repeat(16), blob.subarray(0, HEADER_READ));
  assert.equal(h.name, '遗嘱.txt');
  assert.equal(h.size, body.length);
  assert.deepEqual(await decryptBody(h, 'ab'.repeat(16), blob), body);
  // 挪到别的 ID（AAD 不同）解不开
  await assert.rejects(openHeader(keys, 'cd'.repeat(16), blob.subarray(0, HEADER_READ)));
  // 改一个字节解不开
  const bad = blob.slice(); bad[bad.length - 1] ^= 1;
  await assert.rejects(decryptBody(h, 'ab'.repeat(16), bad));
  // 别的钱包解不开
  const other = await deriveKeys(await fakeSigner('b')('m'), CONTAINER);
  await assert.rejects(openHeader(other, 'ab'.repeat(16), blob.subarray(0, HEADER_READ)));
});

test('keys differ per container and ignore v byte', async () => {
  const sig = await fakeSigner('a')('m');
  const k1 = await deriveKeys(sig, CONTAINER);
  const k2 = await deriveKeys(sig, '0x' + '22'.repeat(20));
  assert.notEqual(k1.keyCheck, k2.keyCheck);
  const sigV0 = sig.slice(0, -2) + '00';
  assert.equal((await deriveKeys(sigV0, CONTAINER)).keyCheck, k1.keyCheck);
});

test('unlock: init requires deterministic signer; later requires same wallet', async () => {
  const keys = await vault.unlock(fakeSigner('a'), CONTAINER, 56, null);
  let n = 0;
  const flaky = async (m) => fakeSigner('x' + n++)(m);
  await assert.rejects(vault.unlock(flaky, CONTAINER, 56, null), /两次签名结果不同/);
  const meta = vault.parseMeta(vault.buildMeta(keys.keyCheck));
  await vault.unlock(fakeSigner('a'), CONTAINER, 56, meta);
  await assert.rejects(vault.unlock(fakeSigner('b'), CONTAINER, 56, meta), (e) => /另一个钱包/.test(e.message) && e.code === 'key-mismatch');
});

test('reset: new holder rewrites _meta.json, old files become locked', async () => {
  const chain = fakeChain();
  const oldKeys = await vault.unlock(fakeSigner('old'), CONTAINER, 56, null);
  for (const tx of await vault.metaWriteTxs(CONTAINER, oldKeys.keyCheck)) chain.exec(tx);
  (await vault.prepareUpload(oldKeys, CONTAINER, { name: 'old.txt', bytes: new TextEncoder().encode('x') })).txs.forEach(chain.exec);

  const before = await vault.readMeta(chain, CONTAINER, await chain.vaultListing());
  await assert.rejects(vault.unlock(fakeSigner('new'), CONTAINER, 56, before), (e) => e.code === 'key-mismatch');
  // 重置 = 按首次初始化派生新密钥，再覆盖 _meta.json
  const keys = await vault.unlock(fakeSigner('new'), CONTAINER, 56, null);
  for (const tx of await vault.metaWriteTxs(CONTAINER, keys.keyCheck)) chain.exec(tx);

  const listing = await chain.vaultListing();
  const meta = await vault.readMeta(chain, CONTAINER, listing);
  assert.equal(meta.keyCheck, keys.keyCheck);
  await vault.unlock(fakeSigner('new'), CONTAINER, 56, meta);
  const r = await vault.decodeListing(chain, keys, CONTAINER, listing);
  assert.equal(r.entries.length, 0);
  assert.equal(r.locked, 1);
});

test('upload → list → download, with chunking and same-name versions', async () => {
  const chain = fakeChain();
  const keys = await vault.unlock(fakeSigner('a'), CONTAINER, 56, null);
  for (const tx of await vault.metaWriteTxs(CONTAINER, keys.keyCheck)) chain.exec(tx);

  const big = webcrypto.getRandomValues(new Uint8Array(60000));   // 加密后 3 块
  const up1 = await vault.prepareUpload(keys, CONTAINER, { name: '合同.pdf', type: 'application/pdf', bytes: big });
  assert.equal(up1.txs.length, 3);
  assert.ok(up1.txs[0].data.startsWith(SEL.putFile) && up1.txs[1].data.startsWith(SEL.appendChunk));
  up1.txs.forEach(chain.exec);

  const small = new TextEncoder().encode('v1');
  const a1 = await vault.prepareUpload(keys, CONTAINER, { name: 'note.txt', type: 'text/plain', bytes: small });
  a1.txs.forEach(chain.exec);
  const a2 = await vault.prepareUpload(keys, CONTAINER, { name: 'note.txt', type: 'text/plain', bytes: new TextEncoder().encode('v2') });
  a2.txs.forEach(chain.exec);

  // 半途而废的上传：只写了第一块
  const half = await vault.prepareUpload(keys, CONTAINER, { name: '合同.pdf', type: 'application/pdf', bytes: big });
  chain.exec(half.txs[0]);

  // 容器的上一任持有人留下的文件
  const oldOwner = await vault.unlock(fakeSigner('old'), CONTAINER, 56, null);
  (await vault.prepareUpload(oldOwner, CONTAINER, { name: 'x', bytes: small })).txs.forEach(chain.exec);

  const listing = await chain.vaultListing();
  const meta = await vault.readMeta(chain, CONTAINER, listing);
  assert.equal(meta.keyCheck, keys.keyCheck);
  const { entries, locked, broken } = await vault.decodeListing(chain, keys, CONTAINER, listing);
  assert.equal(locked, 1);
  assert.equal(broken, 0);
  assert.deepEqual(entries.map((e) => e.name), ['合同.pdf', 'note.txt'].sort((a, b) => a.localeCompare(b, 'zh-CN')));
  const note = entries.find((e) => e.name === 'note.txt');
  assert.equal(note.fileId, a2.fileId);          // 最新版本
  assert.equal(note.versions.length, 1);
  assert.deepEqual(await vault.downloadEntry(chain, keys, CONTAINER, note), new TextEncoder().encode('v2'));
  const pdf = entries.find((e) => e.name === '合同.pdf');
  assert.equal(pdf.fileId, up1.fileId);          // 完整的版本优先于未完成的新版本
  assert.equal(pdf.pending, false);
  assert.equal(pdf.versions[0].pending, true);
  assert.deepEqual(await vault.downloadEntry(chain, keys, CONTAINER, pdf), big);
});

test('upload limits and name normalization', async () => {
  const keys = await vault.unlock(fakeSigner('a'), CONTAINER, 56, null);
  await assert.rejects(vault.prepareUpload(keys, CONTAINER, { name: 'a', bytes: new Uint8Array(512 * 1024 + 1) }), /最大 512 KB/);
  const max = await vault.prepareUpload(keys, CONTAINER, { name: 'max', bytes: new Uint8Array(512 * 1024) });
  assert.equal(max.txs.length, 22);
  assert.equal(vault.normalizeName('café.txt'), 'café.txt');
  assert.throws(() => vault.normalizeName('  '), /不能为空/);
  await assert.rejects(vault.prepareUpload(keys, CONTAINER, { name: 'x'.repeat(700), bytes: new Uint8Array(1) }), /太长/);
});
