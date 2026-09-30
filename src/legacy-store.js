// 遗产托付的链上记录（与界面无关，可在 Node 里测试）。
//
// 目录（容器内，全部是明文 JSON，任何人都能读）：
//   _tapevault/legacy/s-<秒>-<随机>.json   设置记录：门限、各方公钥、加密后的主密钥与碎片
//   _tapevault/legacy/c-<秒>-<随机>.json   报平安记录
// 每条记录都带持有人钱包的 personal_sign 签名，读取时用 ecrecover 核对签名人，
// 只认签名人等于设置人（setup.owner）的记录。电路转手后新持有人写入的记录会被忽略。
//
// 加密结构（setup.sealed / setup.shares）：
//   secret = 文件夹的 64 字节密钥材料（crypto.deriveSecret）
//   inner  = seal(继承人公钥, secret, "heir:<容器>")
//   outer  = AES-GCM(外锁密钥 K, inner)，AAD = "tapevault/legacy/outer:<容器>"
//   shares = Shamir(K, n, m)，第 i 份用守护人 i 的公钥 seal，info = "guardian:<i>:<容器>"
// 继承人需要 m 份碎片复原 K，再用自己的私钥解开 inner。

import { VAULT_PREFIX } from './config.js';
import { sha256Hex, keysFromSecret } from './crypto.js';
import { fileWriteTxs } from './chain.js';
import * as S from './seal.js';

export const LEGACY_DIR = VAULT_PREFIX + 'legacy/';
export const MIN_DAYS = 7;
export const MAX_GUARDIANS = 7;
const DAY = 86400;
const enc = new TextEncoder();
const dec = new TextDecoder();
const lower = (a) => String(a).toLowerCase();
const subtle = () => globalThis.crypto.subtle;
const RECORD = /^_tapevault\/legacy\/([sc])-(\d{1,12})-([0-9a-f]{8})\.json$/;

const heirInfo = (c) => 'heir:' + lower(c);
const guardianInfo = (i, c) => `guardian:${i}:${lower(c)}`;
const outerAad = (c) => enc.encode('tapevault/legacy/outer:' + lower(c));
/** 守护人交给继承人的碎片：用继承人公钥加密，info 绑定碎片编号和容器 */
const releaseInfo = (i, c) => `release:${i}:${lower(c)}`;

function recordPath(kind, now) {
  const r = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${LEGACY_DIR}${kind}-${now}-${r}.json`;
}

/** 固定键顺序的 JSON，签名和校验都基于它 */
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

/** 让钱包签的文字：人能读懂签的是什么，末尾的摘要绑定整条记录 */
export async function signText(kind, body) {
  const digest = await sha256Hex(enc.encode(canonical(body)));
  const head = kind === 's'
    ? ['TapeVault 遗产托付：设置', '', `文件夹容器：${body.container}`, `放行条件：${body.days} 天未报平安`, `门限：${body.threshold} / ${body.guardians.length} 位守护人`]
    : ['TapeVault 遗产托付：报平安', '', `文件夹容器：${body.container}`, `时间：${new Date(body.time * 1000).toISOString()}`];
  return [...head, `链：${body.chainId}`, `记录摘要：${digest}`, '', '签名不花费 gas。只在 TapeVault 页面签署这条消息。'].join('\n');
}

// ---------------------------------------------------------------- 设置

/**
 * 生成设置记录。
 * p = {secret(64 字节), container, chainId, owner, days, threshold, heir:{spki}, guardians:[{spki}], sign(text)→签名, now(秒)}
 * 返回 {path, body, bytes, txs}。secret 不会被清零，调用方用完自己清。
 */
export async function buildSetup(p) {
  if (!Number.isInteger(p.days) || p.days < MIN_DAYS) throw new Error(`放行天数至少 ${MIN_DAYS} 天`);
  const n = p.guardians.length;
  if (n < 1 || n > MAX_GUARDIANS) throw new Error(`守护人 1–${MAX_GUARDIANS} 位`);
  if (!Number.isInteger(p.threshold) || p.threshold < 1 || p.threshold > n) throw new Error('门限不对');
  const c = lower(p.container);

  const heirKey = await S.importSpki(p.heir.spki);
  const inner = await S.seal(heirKey, p.secret, heirInfo(c));
  const K = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const kKey = await subtle().importKey('raw', K, 'AES-GCM', false, ['encrypt']);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const outer = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: outerAad(c) }, kKey, inner));
  const parts = S.split(K, n, p.threshold);
  K.fill(0);
  const shares = [];
  for (let i = 0; i < n; i++) {
    const g = await S.importSpki(p.guardians[i].spki);
    const plain = new Uint8Array(33);
    plain[0] = parts[i].x;
    plain.set(parts[i].y, 1);
    shares.push(S.b64(await S.seal(g, plain, guardianInfo(i + 1, c))));
    plain.fill(0);
    parts[i].y.fill(0);
  }

  const body = {
    app: 'tapevault', type: 'legacy-setup', v: 1,
    chainId: p.chainId, container: c, owner: lower(p.owner), time: p.now,
    days: p.days, threshold: p.threshold,
    keyCheck: (await keysFromSecret(p.secret)).keyCheck,
    heir: { spki: S.b64(p.heir.spki), fingerprint: await S.spkiFingerprint(p.heir.spki) },
    guardians: await Promise.all(p.guardians.map(async (g) => ({ spki: S.b64(g.spki), fingerprint: await S.spkiFingerprint(g.spki) }))),
    sealed: S.b64(new Uint8Array([...iv, ...outer])),
    shares,
  };
  return finish('s', body, p);
}

/** 生成报平安记录。p = {container, chainId, owner, sign, now} */
export async function buildCheckin(p) {
  const body = { app: 'tapevault', type: 'legacy-checkin', v: 1, chainId: p.chainId, container: lower(p.container), owner: lower(p.owner), time: p.now };
  return finish('c', body, p);
}

async function finish(kind, body, p) {
  const sig = await p.sign(await signText(kind, body));
  const bytes = enc.encode(JSON.stringify({ ...body, sig }) + '\n');
  const path = recordPath(kind, p.now);
  return { path, body, bytes, txs: fileWriteTxs(p.container, path, 'application/json', await sha256Hex(bytes), bytes) };
}

// ---------------------------------------------------------------- 读取与核对

function parseRecord(bytes) {
  const r = JSON.parse(dec.decode(bytes));
  if (r.app !== 'tapevault' || r.v !== 1 || typeof r.sig !== 'string') throw new Error('不是 TapeVault 遗产记录');
  const { sig, ...body } = r;
  return { body, sig };
}

function validSetup(b, container) {
  const n = Array.isArray(b.guardians) ? b.guardians.length : 0;
  return b.type === 'legacy-setup' && b.container === lower(container)
    && Number.isInteger(b.days) && b.days >= MIN_DAYS
    && n >= 1 && n <= MAX_GUARDIANS && Number.isInteger(b.threshold) && b.threshold >= 1 && b.threshold <= n
    && Array.isArray(b.shares) && b.shares.length === n
    && typeof b.sealed === 'string' && b.heir && typeof b.heir.spki === 'string' && /^[0-9a-f]{32}$/.test(b.keyCheck);
}

/**
 * 读取容器里的遗产记录。listing 来自 chain.vaultListing。
 * 返回 {setups:[{…body, path, at}], checkins:[…], ignored}，只包含签名核对通过的记录，新的在前。
 * at = min(签名里的时间, 链上写入时间)：把旧签名复制到新文件里（重放）不能把时间往后推。
 */
export async function loadLegacy(chain, container, listing, block) {
  const files = listing.files.filter((f) => RECORD.test(f.path)).sort((a, b) => b.updatedAt - a.updatedAt);
  const setups = [];
  const checkins = [];
  let ignored = 0;
  for (const f of files) {
    try {
      const { body, sig } = parseRecord(await chain.readVerified(container, f.path, f, block));
      const kind = RECORD.exec(f.path)[1];
      if (kind === 's' ? !validSetup(body, container) : (body.type !== 'legacy-checkin' || body.container !== lower(container))) throw new Error('bad');
      const signer = await chain.recoverSigner(await signText(kind, body), sig);
      if (!signer || signer !== lower(body.owner)) throw new Error('bad sig');
      const at = Math.min(Number(body.time) || 0, f.updatedAt);
      (kind === 's' ? setups : checkins).push({ ...body, path: f.path, at });
    } catch {
      ignored++;
    }
  }
  return { setups, checkins, ignored };
}

/**
 * 某个持有人的当前托付状态。now = 链上时间（秒）。
 * 返回 null（没有设置）或 {setup, lastAlive, releaseAt, released, daysLeft}
 */
export function legacyStatus(records, owner, now) {
  const me = lower(owner);
  const setup = records.setups.find((s) => s.owner === me);
  if (!setup) return null;
  let lastAlive = setup.at;
  for (const c of records.checkins) if (c.owner === me && c.at > lastAlive) lastAlive = c.at;
  const releaseAt = lastAlive + setup.days * DAY;
  return { setup, lastAlive, releaseAt, released: now >= releaseAt, daysLeft: Math.max(0, Math.ceil((releaseAt - now) / DAY)) };
}

// ---------------------------------------------------------------- 放行

/** 守护人：用私钥找出自己是第几位，解开碎片，改用继承人公钥加密。返回可交给继承人的字符串 */
export async function guardianRelease(setup, guardianPriv) {
  const i = setup.guardians.findIndex((g) => g.fingerprint === guardianPriv.fingerprint);
  if (i < 0) throw new Error('这把私钥不是这份托付里的任何一位守护人');
  const plain = await S.unseal(guardianPriv.key, S.unb64(setup.shares[i]), guardianInfo(i + 1, setup.container));
  const heirKey = await S.importSpki(S.unb64(setup.heir.spki));
  const out = await S.seal(heirKey, plain, releaseInfo(i + 1, setup.container));
  plain.fill(0);
  return { index: i + 1, text: `tvs1:${i + 1}:${S.b64(out)}` };
}

/** 解析守护人交来的碎片字符串 */
export function parseShare(text) {
  const m = String(text || '').trim().match(/^tvs1:(\d{1,3}):([A-Za-z0-9+/=_-]+)$/);
  if (!m) throw new Error('碎片格式不对，应以 tvs1: 开头');
  return { index: Number(m[1]), data: S.unb64(m[2]) };
}

/**
 * 继承人：用私钥和至少 threshold 份碎片解开文件夹。返回 {aes, keyCheck}（与持有人签名解锁得到的相同）。
 */
export async function heirOpen(setup, heirPriv, shareTexts) {
  if (heirPriv.fingerprint !== setup.heir.fingerprint) throw new Error('私钥与这份托付的继承人公钥指纹不符');
  const seen = new Set();
  const parts = [];
  for (const t of shareTexts) {
    const s = parseShare(t);
    if (s.index < 1 || s.index > setup.guardians.length) throw new Error(`碎片编号 ${s.index} 不存在`);
    if (seen.has(s.index)) continue;
    seen.add(s.index);
    const plain = await S.unseal(heirPriv.key, s.data, releaseInfo(s.index, setup.container))
      .catch(() => { throw new Error(`碎片 ${s.index} 解不开：不属于这个文件夹，或不是交给你的`); });
    if (plain.length !== 33 || plain[0] !== s.index) throw new Error(`碎片 ${s.index} 内容不对`);
    parts.push({ x: plain[0], y: plain.subarray(1) });
  }
  if (parts.length < setup.threshold) throw new Error(`碎片不够：需要 ${setup.threshold} 份，还差 ${setup.threshold - parts.length} 份`);
  const K = S.combine(parts.slice(0, setup.threshold));
  const kKey = await subtle().importKey('raw', K, 'AES-GCM', false, ['decrypt']);
  K.fill(0);
  const raw = S.unb64(setup.sealed);
  let inner;
  try {
    inner = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: outerAad(setup.container) }, kKey, raw.subarray(12)));
  } catch {
    throw new Error('碎片组合不对，解不开外锁');
  }
  const secret = await S.unseal(heirPriv.key, inner, heirInfo(setup.container));
  try {
    const keys = await keysFromSecret(secret);
    if (keys.keyCheck !== setup.keyCheck) throw new Error('解出的密钥核对失败');
    return keys;
  } finally {
    secret.fill(0);
  }
}
