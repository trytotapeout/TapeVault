// 文件夹 = 钱包持有的一枚电路 NFT。
// 没有索引服务，只能直接读链找出持有的电路：
//   1. 用 Multicall 对全部处理器读 balanceOf(钱包)，得到"哪几台处理器上有电路、各有几枚"；
//   2. 对这些处理器读 nextId()，按编号批量 ownerOf，找出具体 #ID；
//   3. 编号太多的处理器不自动扫，交给用户手动添加 #ID。
// 所有权以链上 ownerOf 为准：本地缓存只用来加快下次打开，展示前一定重新核对。

import { MAX_IDS_PER_CPU } from './config.js';

const lower = (a) => String(a).toLowerCase();
const cacheKey = (wallet) => 'tapevault:folders:' + lower(wallet);

/** 规范文件夹名，沿用 TapeKit 的写法：<#ID>.<处理器编号>.tape，例如 4246.0.tape */
export const folderLabel = (tokenId, cpu) => `${tokenId}.${cpu}.tape`;

/** 解析用户手动输入：4246.0 / 4246.0.tape / #4246@0 → {tokenId, cpu} */
export function parseFolderInput(raw) {
  const s = String(raw || '').trim().toLowerCase();
  let m = s.match(/^#?(\d+)\.(\d+)(?:\.tape)?$/) || s.match(/^#(\d+)@(\d+)$/);
  if (!m) return null;
  const tokenId = Number(m[1]);
  const cpu = Number(m[2]);
  if (!Number.isSafeInteger(tokenId) || !Number.isSafeInteger(cpu) || tokenId < 1) return null;
  return { tokenId, cpu };
}

export function loadCache(storage, wallet) {
  try {
    const v = JSON.parse(storage.getItem(cacheKey(wallet)) || '[]');
    return Array.isArray(v) ? v.filter((f) => Number.isSafeInteger(f.tokenId) && Number.isSafeInteger(f.cpu)) : [];
  } catch {
    return [];
  }
}

export function saveCache(storage, wallet, folders) {
  const slim = folders.map((f) => ({ tokenId: f.tokenId, cpu: f.cpu }));
  storage.setItem(cacheKey(wallet), JSON.stringify(slim));
}

/**
 * 扫描钱包持有的全部电路。
 * 返回 {found:[{tokenId, cpu, circuits}], skipped:[{cpu, circuits, balance, maxId}], cpus}
 * skipped 是编号过多、没有自动扫描的处理器，界面提示用户手动添加。
 */
export async function scanFolders(chain, wallet, { onProgress } = {}) {
  const block = await chain.pinBlock();
  onProgress?.({ stage: 'cpus' });
  const cpus = await chain.cpuList(block);
  onProgress?.({ stage: 'balances', total: cpus.length });
  const held = await chain.holdings(wallet, cpus, block);

  const found = [];
  const skipped = [];
  for (const h of held) {
    let maxId;
    try {
      maxId = await chain.maxTokenId(h.circuits, block);
    } catch {
      skipped.push({ ...h, maxId: null });
      continue;
    }
    if (maxId > MAX_IDS_PER_CPU) {
      skipped.push({ ...h, maxId });
      continue;
    }
    const ids = await chain.ownedIds(h.circuits, wallet, 1, maxId, h.balance, block, (done, total) => {
      onProgress?.({ stage: 'ids', cpu: h.cpu, done, total });
    });
    for (const tokenId of ids) found.push({ tokenId, cpu: h.cpu, circuits: h.circuits });
    // 扫完仍不足 balance：编号可能不连续或 nextId 语义不同，剩余的交给手动添加
    if (ids.length < h.balance) skipped.push({ ...h, maxId, missing: h.balance - ids.length });
  }
  return { found, skipped, cpus, block };
}

/**
 * 核对一组文件夹：重新读 ownerOf 和容器状态，丢掉已经不属于该钱包的。
 * cpus 是 cpuList() 的结果（下标 = 处理器编号）。
 */
export async function verifyFolders(chain, wallet, folders, cpus, block) {
  const me = lower(wallet);
  const seen = new Set();
  const items = [];
  for (const f of folders) {
    const label = folderLabel(f.tokenId, f.cpu);
    const circuits = cpus[f.cpu];
    if (seen.has(label) || !circuits) continue;
    seen.add(label);
    items.push({ tokenId: f.tokenId, cpu: f.cpu, circuits, label });
  }
  const infos = items.length ? await chain.circuitInfos(items, block) : [];
  const out = [];
  items.forEach((it, i) => {
    const info = infos[i];
    if (info.exists && lower(info.owner) === me) out.push({ ...it, ...info });
  });
  out.sort((a, b) => a.cpu - b.cpu || a.tokenId - b.tokenId);
  return out;
}
