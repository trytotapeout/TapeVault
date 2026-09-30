import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const L = await import('../src/legacy-store.js');
const S = await import('../src/seal.js');
const { deriveSecret, keysFromSecret } = await import('../src/crypto.js');
const { personalSign, addressOf, randomPriv, recoverPersonal } = await import('./secp256k1.mjs');

const C = '0x86ddaef00401e3f10418398d67d7189fc458ea95';
const DAY = 86400;

/** 内存链：path → {bytes, updatedAt}；recoverSigner 用纯 JS ecrecover */
function fakeChain() {
  const files = new Map();
  return {
    files,
    put(path, bytes, updatedAt) { files.set(path, { bytes, updatedAt }); },
    listing() { return { files: [...files].map(([path, f]) => ({ path, updatedAt: f.updatedAt, size: f.bytes.length })) }; },
    async readVerified(_c, path) { return files.get(path).bytes; },
    async recoverSigner(text, sig) { return recoverPersonal(text, sig); },
  };
}

async function pair() {
  const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', k.publicKey));
  const pk8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', k.privateKey));
  const pem = '-----BEGIN PRIVATE KEY-----\n' + S.b64(pk8) + '\n-----END PRIVATE KEY-----';
  return { spki, priv: await S.parsePrivateKey(pem) };
}

async function setupFixture({ n = 3, m = 2, days = 30 } = {}) {
  const ownerPriv = randomPriv();
  const owner = addressOf(ownerPriv);
  const sign = async (text) => personalSign(ownerPriv, text);
  const secret = await deriveSecret('0x' + 'cd'.repeat(64) + '1c', C);
  const heir = await pair();
  const guardians = await Promise.all(Array.from({ length: n }, pair));
  const t0 = 1_800_000_000;
  const rec = await L.buildSetup({ secret, container: C, chainId: 56, owner, days, threshold: m, heir: { spki: heir.spki }, guardians: guardians.map((g) => ({ spki: g.spki })), sign, now: t0 });
  const chain = fakeChain();
  chain.put(rec.path, rec.bytes, t0);
  return { chain, owner, ownerPriv, sign, secret, heir, guardians, t0, rec };
}

test('完整流程：设置 → 守护人放行 → 继承人解开，密钥与持有人一致', async () => {
  const f = await setupFixture({ n: 5, m: 3 });
  const recs = await L.loadLegacy(f.chain, C, f.chain.listing());
  assert.equal(recs.setups.length, 1);
  const st = L.legacyStatus(recs, f.owner, f.t0 + 31 * DAY);
  assert.equal(st.released, true);
  const shares = [];
  for (const i of [4, 0, 2]) shares.push((await L.guardianRelease(st.setup, f.guardians[i].priv)).text);
  const keys = await L.heirOpen(st.setup, f.heir.priv, shares);
  assert.equal(keys.keyCheck, (await keysFromSecret(f.secret)).keyCheck);
});

test('单靠继承人私钥、碎片不够、私钥不对都解不开', async () => {
  const f = await setupFixture();
  const { setups: [setup] } = await L.loadLegacy(f.chain, C, f.chain.listing());
  const one = (await L.guardianRelease(setup, f.guardians[1].priv)).text;
  await assert.rejects(L.heirOpen(setup, f.heir.priv, []), /还差 2 份/);
  await assert.rejects(L.heirOpen(setup, f.heir.priv, [one, one]), /还差 1 份/);
  await assert.rejects(L.heirOpen(setup, f.guardians[0].priv, [one]), /指纹不符/);
  const outsider = await pair();
  await assert.rejects(L.guardianRelease(setup, outsider.priv), /不是这份托付里的任何一位守护人/);
});

test('报平安推迟放行；别人签的记录和篡改过的记录被忽略', async () => {
  const f = await setupFixture({ days: 30 });
  const ci = await L.buildCheckin({ container: C, chainId: 56, owner: f.owner, sign: f.sign, now: f.t0 + 20 * DAY });
  f.chain.put(ci.path, ci.bytes, f.t0 + 20 * DAY);
  // 新持有人（另一把钥匙）冒充写报平安
  const mallory = randomPriv();
  const fake = await L.buildCheckin({ container: C, chainId: 56, owner: f.owner, sign: async (t) => personalSign(mallory, t), now: f.t0 + 40 * DAY });
  f.chain.put(fake.path, fake.bytes, f.t0 + 40 * DAY);
  // 篡改天数
  const tampered = JSON.parse(new TextDecoder().decode(f.rec.bytes));
  tampered.days = 3650;
  f.chain.put('_tapevault/legacy/s-1800000001-deadbeef.json', new TextEncoder().encode(JSON.stringify(tampered)), f.t0 + 1);

  const recs = await L.loadLegacy(f.chain, C, f.chain.listing());
  assert.equal(recs.ignored, 2);
  const st = L.legacyStatus(recs, f.owner, f.t0 + 45 * DAY);
  assert.equal(st.lastAlive, f.t0 + 20 * DAY);
  assert.equal(st.released, false);
  assert.equal(st.daysLeft, 5);
  assert.equal(L.legacyStatus(recs, f.owner, f.t0 + 50 * DAY).released, true);
});

test('重放旧报平安不能把时间往后推', async () => {
  const f = await setupFixture({ days: 30 });
  const ci = await L.buildCheckin({ container: C, chainId: 56, owner: f.owner, sign: f.sign, now: f.t0 + 5 * DAY });
  // 同一份签名在很久以后被复制到新路径
  f.chain.put(ci.path.replace(/-(\d+)-/, `-${f.t0 + 90 * DAY}-`), ci.bytes, f.t0 + 90 * DAY);
  const st = L.legacyStatus(await L.loadLegacy(f.chain, C, f.chain.listing()), f.owner, f.t0 + 40 * DAY);
  assert.equal(st.lastAlive, f.t0 + 5 * DAY);
  assert.equal(st.released, true);
});

test('参数校验', async () => {
  const base = { secret: new Uint8Array(64), container: C, chainId: 56, owner: C, heir: { spki: (await pair()).spki }, guardians: [{ spki: (await pair()).spki }], sign: async () => '0x', now: 1 };
  await assert.rejects(L.buildSetup({ ...base, days: 6, threshold: 1 }), /至少 7 天/);
  await assert.rejects(L.buildSetup({ ...base, days: 7, threshold: 2 }), /门限不对/);
});
