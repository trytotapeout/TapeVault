// 保险箱逻辑（与界面无关，可在 Node 里测试）。
//
// 目录结构（容器内）：
//   _tapevault/_meta.json   明文：格式版本与 keyCheck，不含任何文件信息
//   _tapevault/f/<随机ID>   TVF1 密文（见 crypto.js）；文件名、类型、大小都在加密头里
//
// 同名文件：链上只能新增，所以上传同名文件就是再写一个新 ID。列表按文件名分组，
// 只显示链上更新时间最新的一个，其余作为历史版本保留。

import { VAULT_PREFIX, VAULT_META, CIPHER_CONTENT_TYPE, MAX_UPLOAD_BYTES } from './config.js';
import { deriveKeys, keyMessage, encryptFile, openHeader, decryptBody, randomFileId, sha256Hex, HEADER_READ, OVERHEAD } from './crypto.js';
import { fileWriteTxs } from './chain.js';

export const FILE_DIR = VAULT_PREFIX + 'f/';
const FILE_ID = /^[0-9a-f]{32}$/;
const enc = new TextEncoder();

export const filePath = (fileId) => FILE_DIR + fileId;

// ---------------------------------------------------------------- _meta.json

export function buildMeta(keyCheck) {
  return enc.encode(JSON.stringify({ app: 'tapevault', v: 1, cipher: 'AES-256-GCM', kdf: 'personal_sign+HKDF-SHA256', keyCheck }) + '\n');
}

export function parseMeta(bytes) {
  const m = JSON.parse(new TextDecoder().decode(bytes));
  if (m.app !== 'tapevault' || m.v !== 1 || !/^[0-9a-f]{32}$/.test(m.keyCheck)) throw new Error('_meta.json 格式不认识');
  return m;
}

export async function readMeta(chain, container, listing, block) {
  if (!listing.meta) return null;
  const bytes = await chain.readVerified(container, VAULT_META, listing.meta, block);
  return parseMeta(bytes);
}

/** 初始化用的交易：写 _meta.json */
export async function metaWriteTxs(container, keyCheck) {
  const bytes = buildMeta(keyCheck);
  return fileWriteTxs(container, VAULT_META, 'application/json', await sha256Hex(bytes), bytes);
}

// ---------------------------------------------------------------- 解锁

/**
 * 通过钱包签名得到这个文件夹的密钥。
 * sign(text) → 签名。meta 为 null 表示首次初始化：签两次核对签名是否确定，不确定的钱包无法稳定恢复密钥，直接拒绝。
 * 已初始化时签一次，与 meta.keyCheck 对比，不一致说明换了钱包或钱包签名不确定。
 */
export async function unlock(sign, container, chainId, meta) {
  const msg = keyMessage(container, chainId);
  const keys = await deriveKeys(await sign(msg), container);
  if (meta) {
    if (keys.keyCheck !== meta.keyCheck) throw new Error('密钥核对失败：这个文件夹是用另一个钱包初始化的，当前钱包解不开里面的文件');
    return keys;
  }
  const again = await deriveKeys(await sign(msg), container);
  if (again.keyCheck !== keys.keyCheck) throw new Error('两次签名结果不同：当前钱包（可能是智能合约钱包或 MPC 钱包）签名不确定，无法用来加密');
  return keys;
}

// ---------------------------------------------------------------- 列表

/**
 * 解开文件夹里的全部文件头，按文件名合并版本。
 * listing 来自 chain.vaultListing。返回 {entries, locked, broken}：
 *   entries: [{name, type, size, mtime, updatedAt, fileId, info, pending, versions:[…旧版本]}]，按名字排序
 *   locked:  解不开的文件数（其他钱包写入的，例如电路的上一任持有人）
 *   broken:  不是 TVF1 格式或文件头损坏的文件数
 */
export async function decodeListing(chain, keys, container, listing, block) {
  const ours = listing.files.filter((f) => f.path.startsWith(FILE_DIR) && FILE_ID.test(f.path.slice(FILE_DIR.length)));
  const heads = ours.length ? await chain.readHeads(container, ours.map((f) => f.path), HEADER_READ, block) : new Map();
  const byName = new Map();
  let locked = 0;
  let broken = 0;
  for (const f of ours) {
    const fileId = f.path.slice(FILE_DIR.length);
    const head = heads.get(f.path);
    if (!head || head.length < HEADER_READ) { broken++; continue; }
    let h;
    try {
      h = await openHeader(keys, fileId, head);
    } catch (e) {
      if (/TapeVault/.test(e.message)) broken++; else locked++;
      continue;
    }
    const item = { name: h.name, type: h.type, size: h.size, mtime: h.mtime, created: h.created, updatedAt: f.updatedAt, fileId, info: f,
      // 链上已写入的字节少于应有长度：上传没完成
      pending: f.size !== h.size + OVERHEAD };
    const list = byName.get(h.name) || [];
    list.push(item);
    byName.set(h.name, list);
  }
  const entries = [];
  for (const list of byName.values()) {
    // 完整的版本优先；同为完整时取链上更新时间最新的
    list.sort((a, b) => (a.pending - b.pending) || (b.updatedAt - a.updatedAt) || (b.created - a.created));
    const [latest, ...versions] = list;
    entries.push({ ...latest, versions });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return { entries, locked, broken };
}

// ---------------------------------------------------------------- 上传 / 下载

export function normalizeName(name) {
  const n = String(name || '').normalize('NFC').trim();
  if (!n) throw new Error('文件名不能为空');
  if (/[\0-\x1f\x7f]/.test(n)) throw new Error('文件名含控制字符');
  return n;
}

/** 加密并切块。返回 {fileId, path, blob, sha256, txs} */
export async function prepareUpload(keys, container, { name, type, mtime, bytes }) {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`单个文件最大 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  const fileId = randomFileId();
  const blob = await encryptFile(keys, fileId, { name: normalizeName(name), type, mtime }, bytes);
  const sha256 = await sha256Hex(blob);
  const path = filePath(fileId);
  return { fileId, path, blob, sha256, txs: fileWriteTxs(container, path, CIPHER_CONTENT_TYPE, sha256, blob) };
}

/** 下载并解密一个条目。返回 Uint8Array 原文 */
export async function downloadEntry(chain, keys, container, entry, block, onProgress) {
  const blob = await chain.readVerified(container, entry.info.path, entry.info, block, onProgress);
  const header = await openHeader(keys, entry.fileId, blob.subarray(0, HEADER_READ));
  return decryptBody(header, entry.fileId, blob);
}

/** 估算写入 gas：SiteRegistry 实测约 232 gas/字节（2026-09-30，1 KB 与 24 KB 两档），外加每笔约 30 万固定开销 */
export function estimateGas(totalBytes, txCount) {
  return BigInt(Math.ceil(totalBytes * 235)) + BigInt(txCount) * 300000n;
}
