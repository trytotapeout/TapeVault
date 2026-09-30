import { t } from './i18n.js';
// 遗产托付用的密码学工具（WebCrypto + 纯 JS，零依赖）。与界面无关，可在 Node 里测试。
//
// - P-256 公私钥导入：公钥接受 SPKI（PEM / base64）；私钥接受 openssl 默认的 SEC1（EC PRIVATE KEY）和 PKCS#8。
// - ECIES：临时 ECDH 密钥 + HKDF-SHA256 + AES-256-GCM。格式 0x01 ‖ 临时公钥(65) ‖ IV(12) ‖ 密文+标签。
// - Shamir 秘密分享：GF(256)，逐字节独立。少于门限数量的碎片得不到密钥的任何信息。

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const EC = { name: 'ECDH', namedCurve: 'P-256' };

// ---------------------------------------------------------------- 编码

export function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function unb64(text) {
  const clean = String(text).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  let bin;
  try { bin = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4)); } catch { throw new Error(t('格式不对，应为 PEM 或 base64')); }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 从 PEM 文本里取出指定类型的块；没有 PEM 头时把整段当 base64 */
function pemBody(text, labels) {
  const raw = String(text || '').trim();
  for (const label of labels) {
    const m = raw.match(new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`));
    if (m) return { label, der: unb64(m[1]) };
  }
  if (/-----BEGIN/.test(raw)) return null;
  return { label: '', der: unb64(raw) };
}

/** 16 字节 → 8 组 4 位十六进制，方便当面或电话核对 */
function fingerprintOf(bytes) {
  return [...bytes.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(' ');
}

export async function spkiFingerprint(spki) {
  return fingerprintOf(new Uint8Array(await subtle().digest('SHA-256', spki)));
}

// ---------------------------------------------------------------- 公钥 / 私钥

/** 解析 P-256 公钥。返回 {key: CryptoKey, spki: Uint8Array, fingerprint} */
export async function parsePublicKey(text) {
  if (!String(text || '').trim()) throw new Error(t('请填写公钥'));
  const body = pemBody(text, ['PUBLIC KEY']);
  if (!body) throw new Error(t('这不是公钥。请粘贴 -----BEGIN PUBLIC KEY----- 开头的内容'));
  let key;
  try { key = await subtle().importKey('spki', body.der, EC, true, []); } catch { throw new Error(t('不是有效的 P-256 公钥')); }
  const spki = new Uint8Array(await subtle().exportKey('spki', key));
  return { key, spki, fingerprint: await spkiFingerprint(spki) };
}

/** 从公钥 SPKI 字节重新导入（链上记录里存的是 base64 SPKI） */
export async function importSpki(spki) {
  return subtle().importKey('spki', spki, EC, true, []);
}

/**
 * 解析 P-256 私钥。接受：
 *   -----BEGIN EC PRIVATE KEY-----（openssl ecparam -genkey 的默认输出，SEC1）
 *   -----BEGIN PRIVATE KEY-----（PKCS#8）
 * 返回 {key: CryptoKey, fingerprint}，fingerprint 是对应公钥的指纹，用来和链上记录核对。
 */
export async function parsePrivateKey(text) {
  if (!String(text || '').trim()) throw new Error(t('请导入私钥'));
  const body = pemBody(text, ['EC PRIVATE KEY', 'PRIVATE KEY']);
  if (!body) throw new Error(t('没有找到私钥。请粘贴 -----BEGIN EC PRIVATE KEY----- 或 -----BEGIN PRIVATE KEY----- 开头的内容'));
  let key;
  try {
    if (body.label === 'PRIVATE KEY') {
      key = await subtle().importKey('pkcs8', body.der, EC, true, ['deriveBits']);
    } else {
      key = await importSec1(body.der);
    }
  } catch (e) {
    throw new Error((e && e.message && e.message.startsWith('SEC1') ? t('不是有效的 P-256 私钥（{0}）', [e.message]) : t('不是有效的 P-256 私钥')));
  }
  const jwk = await subtle().exportKey('jwk', key);
  const pub = await subtle().importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, EC, true, []);
  const spki = new Uint8Array(await subtle().exportKey('spki', pub));
  return { key, fingerprint: await spkiFingerprint(spki) };
}

// SEC1：SEQUENCE { INTEGER 1, OCTET STRING d, [0] OID?, [1] BIT STRING 公钥? }
async function importSec1(der) {
  const r = derReader(der);
  const seq = r.read(0x30);
  const inner = derReader(seq);
  const ver = inner.read(0x02);
  if (ver.length !== 1 || ver[0] !== 1) throw new Error(t('SEC1 版本不对'));
  const d = inner.read(0x04);
  let pub = null;
  while (!inner.done()) {
    const { tag, value } = inner.next();
    if (tag === 0xa0) {
      // prime256v1 = 1.2.840.10045.3.1.7
      const oid = derReader(value).read(0x06);
      if (b64(oid) !== 'KoZIzj0DAQc=') throw new Error(t('SEC1 不是 P-256 曲线'));
    } else if (tag === 0xa1) {
      const bits = derReader(value).read(0x03);
      pub = bits.subarray(1);   // 去掉「未用位数」字节
    }
  }
  if (d.length !== 32) throw new Error(t('SEC1 私钥长度不对'));
  if (!pub || pub.length !== 65 || pub[0] !== 0x04) throw new Error(t('SEC1 缺少公钥，请用 openssl 默认参数生成'));
  const jwk = { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), ext: true };
  return subtle().importKey('jwk', jwk, EC, true, ['deriveBits']);
}

function derReader(buf) {
  let i = 0;
  const next = () => {
    if (i + 2 > buf.length) throw new Error(t('SEC1 数据截断'));
    const tag = buf[i++];
    let len = buf[i++];
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n < 1 || n > 2 || i + n > buf.length) throw new Error(t('SEC1 长度字段不对'));
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | buf[i++];
    }
    if (i + len > buf.length) throw new Error(t('SEC1 数据截断'));
    const value = buf.subarray(i, i + len);
    i += len;
    return { tag, value };
  };
  return {
    next,
    done: () => i >= buf.length,
    read(tag) { const item = next(); if (item.tag !== tag) throw new Error(t('SEC1 结构不对')); return item.value; },
  };
}

// ---------------------------------------------------------------- ECIES

const SEAL_V = 1;
export const SEAL_OVERHEAD = 1 + 65 + 12 + 16;

async function sealKey(shared, ephRaw, info) {
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: ephRaw, info: enc.encode('tapevault/seal/v1:' + info) }, ikm, 256);
  return subtle().importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * 用接收人公钥加密。info 是用途标签（例如 "heir:<容器>"），同时作为 AAD：
 * 挪到别的用途或别的文件夹就解不开。
 */
export async function seal(publicKey, plaintext, info) {
  const eph = await subtle().generateKey(EC, true, ['deriveBits']);
  const ephRaw = new Uint8Array(await subtle().exportKey('raw', eph.publicKey));
  const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: publicKey }, eph.privateKey, 256));
  const key = await sealKey(shared, ephRaw, info);
  shared.fill(0);
  const iv = random(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(info) }, key, plaintext));
  const out = new Uint8Array(1 + 65 + 12 + ct.length);
  out[0] = SEAL_V;
  out.set(ephRaw, 1);
  out.set(iv, 66);
  out.set(ct, 78);
  return out;
}

/** 用接收人私钥解开 seal 的结果。私钥不对、info 不对或数据被改动时抛错 */
export async function unseal(privateKey, sealed, info) {
  if (!(sealed instanceof Uint8Array) || sealed.length < SEAL_OVERHEAD || sealed[0] !== SEAL_V) throw new Error(t('密文格式不对'));
  const ephRaw = sealed.subarray(1, 66);
  let eph;
  try { eph = await subtle().importKey('raw', ephRaw, EC, false, []); } catch { throw new Error(t('密文格式不对')); }
  const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: eph }, privateKey, 256));
  const key = await sealKey(shared, ephRaw, info);
  shared.fill(0);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: sealed.subarray(66, 78), additionalData: enc.encode(info) }, key, sealed.subarray(78)));
  } catch {
    throw new Error(t('解不开：私钥不对，或者数据不属于这个文件夹'));
  }
}

// ---------------------------------------------------------------- Shamir（GF(256)）

// 以 0x11b（AES 的不可约多项式）为模，生成元 3
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);   // x * 3
    x &= 0xff;
  }
  for (let i = 255; i < 510; i++) EXP[i] = EXP[i - 255];
})();

const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const gdiv = (a, b) => { if (!b) throw new Error(t('除零')); return a ? EXP[LOG[a] + 255 - LOG[b]] : 0; };

/**
 * 把 secret 拆成 n 份，任意 m 份可以复原。返回 [{x: 1..n, y: Uint8Array}]。
 * 每个字节独立用一个 m-1 次随机多项式，常数项是这个字节。
 */
export function split(secret, n, m) {
  if (!Number.isInteger(n) || !Number.isInteger(m) || m < 1 || n < m || n > 255) throw new Error(t('门限参数不对'));
  const coeffs = random(secret.length * (m - 1));
  const shares = [];
  for (let x = 1; x <= n; x++) {
    const y = new Uint8Array(secret.length);
    for (let i = 0; i < secret.length; i++) {
      // 霍纳法：((a_{m-1} x + a_{m-2}) x + …) x + secret[i]
      let acc = 0;
      for (let k = m - 2; k >= 0; k--) acc = gmul(acc, x) ^ coeffs[i * (m - 1) + k];
      y[i] = gmul(acc, x) ^ secret[i];
    }
    shares.push({ x, y });
  }
  coeffs.fill(0);
  return shares;
}

/** 用至少 m 份碎片复原（拉格朗日插值求 f(0)）。碎片不够时得到的是错误结果，调用方要另行校验 */
export function combine(shares) {
  if (!shares.length) throw new Error(t('没有碎片'));
  const xs = shares.map((s) => s.x);
  if (new Set(xs).size !== xs.length || xs.some((x) => !Number.isInteger(x) || x < 1 || x > 255)) throw new Error(t('碎片编号重复或不对'));
  const len = shares[0].y.length;
  if (shares.some((s) => s.y.length !== len)) throw new Error(t('碎片长度不一致'));
  const out = new Uint8Array(len);
  for (let j = 0; j < shares.length; j++) {
    // l_j(0) = Π_{k≠j} x_k / (x_k ⊕ x_j)
    let l = 1;
    for (let k = 0; k < shares.length; k++) if (k !== j) l = gmul(l, gdiv(xs[k], xs[k] ^ xs[j]));
    for (let i = 0; i < len; i++) out[i] ^= gmul(shares[j].y[i], l);
  }
  return out;
}
