import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { parsePublicKey } = await import('../src/legacy.js');

async function spki(curve = 'P-256') {
  const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: curve }, true, ['deriveBits']);
  return Buffer.from(await crypto.subtle.exportKey('spki', k.publicKey)).toString('base64');
}

test('parsePublicKey 接受 PEM 与裸 base64，指纹一致', async () => {
  const b64 = await spki();
  const pem = '-----BEGIN PUBLIC KEY-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END PUBLIC KEY-----\n';
  const a = await parsePublicKey(pem);
  const b = await parsePublicKey(b64);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.match(a.fingerprint, /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
});

test('parsePublicKey 拒绝空值、乱码和其他曲线', async () => {
  await assert.rejects(parsePublicKey('  '), /请填写公钥/);
  await assert.rejects(parsePublicKey('not a key!!'), /格式不对|不是有效/);
  await assert.rejects(parsePublicKey(await spki('P-384')), /不是有效的 P-256 公钥/);
});
