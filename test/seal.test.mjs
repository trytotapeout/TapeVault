import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const S = await import('../src/seal.js');
const { deriveKeys, deriveSecret, keysFromSecret } = await import('../src/crypto.js');
const fx = (n) => readFileSync(new URL('./fixtures/' + n, import.meta.url), 'utf8');

test('openssl 生成的 SEC1 / PKCS#8 私钥与公钥指纹一致', async () => {
  const pub = await S.parsePublicKey(fx('p256-pub.pem'));
  const sec1 = await S.parsePrivateKey(fx('p256-sec1.pem'));
  const pk8 = await S.parsePrivateKey(fx('p256-pkcs8.pem'));
  assert.equal(sec1.fingerprint, pub.fingerprint);
  assert.equal(pk8.fingerprint, pub.fingerprint);
});

test('parsePrivateKey 拒绝公钥和乱码', async () => {
  await assert.rejects(S.parsePrivateKey(fx('p256-pub.pem')), /没有找到私钥/);
  await assert.rejects(S.parsePrivateKey('-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----'), /不是有效的 P-256 私钥/);
  await assert.rejects(S.parsePublicKey(fx('p256-sec1.pem')), /这不是公钥/);
});

test('seal / unseal：正确私钥能解，换私钥、换 info、篡改都解不开', async () => {
  const pub = await S.parsePublicKey(fx('p256-pub.pem'));
  const priv = await S.parsePrivateKey(fx('p256-sec1.pem'));
  const msg = crypto.getRandomValues(new Uint8Array(64));
  const box = await S.seal(pub.key, msg, 'heir:0xabc');
  assert.equal(box.length, S.SEAL_OVERHEAD + 64);
  assert.deepEqual(await S.unseal(priv.key, box, 'heir:0xabc'), msg);
  await assert.rejects(S.unseal(priv.key, box, 'heir:0xdef'), /解不开/);
  const other = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  await assert.rejects(S.unseal(other.privateKey, box, 'heir:0xabc'), /解不开/);
  const bad = box.slice(); bad[bad.length - 1] ^= 1;
  await assert.rejects(S.unseal(priv.key, bad, 'heir:0xabc'), /解不开/);
});

test('Shamir：任意 m 份复原，少于 m 份得不到原值', () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  for (const [n, m] of [[1, 1], [3, 2], [5, 3], [7, 7]]) {
    const shares = S.split(secret, n, m);
    assert.equal(shares.length, n);
    // 所有 m 元组合都能复原
    const combos = (arr, k) => k === 0 ? [[]] : arr.flatMap((v, i) => combos(arr.slice(i + 1), k - 1).map((c) => [v, ...c]));
    for (const c of combos(shares, m)) assert.deepEqual(S.combine(c), secret);
    if (m > 1) assert.notDeepEqual(S.combine(shares.slice(0, m - 1)), secret);
  }
  assert.throws(() => S.split(secret, 2, 3), /门限参数不对/);
  const sh = S.split(secret, 3, 2);
  assert.throws(() => S.combine([sh[0], sh[0]]), /重复/);
});

test('deriveKeys 拆分后 keyCheck 不变；keysFromSecret 还原出相同密钥', async () => {
  const sig = '0x' + 'ab'.repeat(64) + '1b';
  const c = '0x86ddaef00401e3f10418398d67d7189fc458ea95';
  const a = await deriveKeys(sig, c);
  const b = await keysFromSecret(await deriveSecret(sig, c));
  assert.equal(a.keyCheck, b.keyCheck);
  const iv = new Uint8Array(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a.aes, new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b.aes, ct)), new Uint8Array([1, 2, 3]));
});
