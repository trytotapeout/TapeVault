import { t } from './i18n.js';
// 客户端加密（WebCrypto，零依赖）。链上只存密文，文件名、类型、大小都在加密头里。
//
// 密钥：钱包对固定消息签名 → 取 r‖s 作为输入 → HKDF-SHA256（salt = tapevault/v1，info = 容器地址）
//      → 前 32 字节是主密钥（AES-256-GCM），后 32 字节只用来算 keyCheck（写进 _meta.json，核对签名是否一致）。
// 文件：每个文件一把随机密钥，用主密钥包裹后放在文件开头，便于以后做密钥交接而不必重新加密内容。
//
// TVF1 文件格式（定长头，列表时只需读前 HEADER_READ 字节）：
//   0     4   魔数 "TVF1"
//   4     12  包裹密钥用的 nonce
//   16    48  包裹后的文件密钥（32 + 16 标签）
//   64    12  头部 nonce
//   76    1024 加密头（JSON 补空格到 1008 字节 + 16 标签）
//   1100  12  正文 nonce
//   1112  …   加密正文（原文长度 + 16 标签）
// 所有 AES-GCM 的附加数据（AAD）都是 "TVF1:" + 文件 ID，密文被挪到别的路径就无法解密。

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export const MAGIC = 'TVF1';
export const HEADER_PLAIN = 1008;
export const HEADER_READ = 1100;
export const BODY_OFFSET = 1112;
export const OVERHEAD = BODY_OFFSET + 16;
export const MAX_NAME_BYTES = 600;

const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function unhex(h) {
  const s = String(h).replace(/^0x/i, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('crypto: bad hex');
  return Uint8Array.from(s.match(/../g) || [], (x) => parseInt(x, 16));
}

/** 派生密钥时让钱包签的消息。绑定容器和链，不同文件夹得到不同密钥。 */
export function keyMessage(container, chainId) {
  return [
    'TapeVault 加密密钥',
    '',
    '这次签名只在本机用于生成文件加密密钥，不会发送交易，也不花费 gas。',
    '只在 TapeVault 页面签署这条消息；其他网站请求签署同样内容时请拒绝。',
    '',
    '容器：' + String(container).toLowerCase(),
    '链：' + chainId,
    '版本：1',
  ].join('\n');
}

/**
 * 由签名得到文件夹的 64 字节密钥材料（HKDF 输出）：前 32 字节是主密钥，后 32 字节只用来算 keyCheck。
 * 遗产托付交给继承人的就是这 64 字节，继承人用 keysFromSecret 还原出和持有人完全相同的密钥。
 */
export async function deriveSecret(signatureHex, container) {
  const sig = unhex(signatureHex);
  if (sig.length !== 65) throw new Error(t('签名长度不对，当前钱包可能不是普通 EOA 钱包'));
  // 只用 r‖s：不同钱包对 v 的写法不同（0/1 或 27/28），不能让它影响密钥
  const ikm = await subtle().importKey('raw', sig.subarray(0, 64), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('tapevault/v1'), info: enc.encode('container:' + String(container).toLowerCase()) },
    ikm, 512));
}

/** 由 64 字节密钥材料得到 {aes: CryptoKey, keyCheck: hex}。不会清零传入的 secret */
export async function keysFromSecret(secret) {
  if (!(secret instanceof Uint8Array) || secret.length !== 64) throw new Error(t('密钥材料长度不对'));
  const aes = await subtle().importKey('raw', secret.subarray(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const mac = await subtle().importKey('raw', secret.subarray(32, 64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const check = new Uint8Array(await subtle().sign('HMAC', mac, enc.encode('tapevault/keycheck/v1')));
  return { aes, keyCheck: hex(check.subarray(0, 16)) };
}

/** 由签名派生密钥：返回 {aes: CryptoKey, keyCheck: hex} */
export async function deriveKeys(signatureHex, container) {
  const secret = await deriveSecret(signatureHex, container);
  try { return await keysFromSecret(secret); } finally { secret.fill(0); }
}

export function randomFileId() {
  return hex(random(16));
}

export async function sha256Hex(bytes) {
  return '0x' + hex(new Uint8Array(await subtle().digest('SHA-256', bytes)));
}

const aad = (fileId) => enc.encode(MAGIC + ':' + fileId);

async function gcm(op, key, iv, data, fileId) {
  const out = await subtle()[op]({ name: 'AES-GCM', iv, additionalData: aad(fileId) }, key, data);
  return new Uint8Array(out);
}

/**
 * 加密一个文件。meta = {name, type, mtime}；返回完整的 TVF1 字节。
 * 名字必须已做 NFC 归一化；超过 MAX_NAME_BYTES 抛错。
 */
export async function encryptFile(keys, fileId, meta, bytes) {
  const header = enc.encode(JSON.stringify({ n: meta.name, t: meta.type || '', s: bytes.length, m: meta.mtime || 0, c: Date.now() }));
  if (enc.encode(meta.name).length > MAX_NAME_BYTES || header.length > HEADER_PLAIN) throw new Error(t('文件名太长'));
  const padded = new Uint8Array(HEADER_PLAIN).fill(0x20);
  padded.set(header);

  const fileKeyRaw = random(32);
  const fileKey = await subtle().importKey('raw', fileKeyRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const wrapNonce = random(12);
  const wrapped = await gcm('encrypt', keys.aes, wrapNonce, fileKeyRaw, fileId);
  fileKeyRaw.fill(0);
  const headerNonce = random(12);
  const headerCt = await gcm('encrypt', fileKey, headerNonce, padded, fileId);
  const bodyNonce = random(12);
  const bodyCt = await gcm('encrypt', fileKey, bodyNonce, bytes, fileId);

  const out = new Uint8Array(BODY_OFFSET + bodyCt.length);
  out.set(enc.encode(MAGIC), 0);
  out.set(wrapNonce, 4);
  out.set(wrapped, 16);
  out.set(headerNonce, 64);
  out.set(headerCt, 76);
  out.set(bodyNonce, HEADER_READ);
  out.set(bodyCt, BODY_OFFSET);
  return out;
}

/** 解开文件头：head 至少 HEADER_READ 字节。返回 {name, type, size, mtime, created, fileKey}；密钥不对或被篡改时抛错 */
export async function openHeader(keys, fileId, head) {
  if (head.length < HEADER_READ || dec.decode(head.subarray(0, 4)) !== MAGIC) throw new Error(t('不是 TapeVault 文件'));
  const fileKeyRaw = await gcm('decrypt', keys.aes, head.subarray(4, 16), head.subarray(16, 64), fileId);
  const fileKey = await subtle().importKey('raw', fileKeyRaw, 'AES-GCM', false, ['decrypt']);
  fileKeyRaw.fill(0);
  const h = JSON.parse(dec.decode(await gcm('decrypt', fileKey, head.subarray(64, 76), head.subarray(76, HEADER_READ), fileId)));
  if (typeof h.n !== 'string' || !Number.isSafeInteger(h.s) || h.s < 0) throw new Error(t('文件头格式不对'));
  return { name: h.n, type: typeof h.t === 'string' ? h.t : '', size: h.s, mtime: Number(h.m) || 0, created: Number(h.c) || 0, fileKey };
}

/** 解密正文。blob 是完整的 TVF1 字节，header 是 openHeader 的结果 */
export async function decryptBody(header, fileId, blob) {
  if (blob.length !== OVERHEAD + header.size) throw new Error(t('文件长度与文件头不符'));
  return gcm('decrypt', header.fileKey, blob.subarray(HEADER_READ, BODY_OFFSET), blob.subarray(BODY_OFFSET), fileId);
}
