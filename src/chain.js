// 只读链访问。所有请求都经由调用方传入的 rpc(method, params)：
//   浏览器里是用户钱包（EIP-1193 provider.request），测试里是直连公共节点。
// 本模块不发起任何 fetch，也不依赖任何后端或索引服务。

import { encodeCall, decodeResult, decodeAggregate3, hexToBytes } from './abi.js';
import { BSC, SEL, MULTICALL_BATCH, PATHS_PAGE, VAULT_PREFIX, VAULT_META, CHUNK_SIZE, MAX_FILE_BYTES, READ_RANGE } from './config.js';
import { sha256Hex } from './crypto.js';
import { keccak256 } from './keccak.js';
import { t } from './i18n.js';

const lower = (a) => String(a).toLowerCase();

export function createChain(rpc, net = BSC) {
  /** 钉住一个区块号，保证一次扫描里的所有读取看到的是同一个链状态 */
  async function pinBlock() {
    const n = BigInt(await rpc('eth_blockNumber', []));
    return '0x' + (n > 2n ? n - 2n : n).toString(16);
  }

  async function call(to, data, block = 'latest') {
    return rpc('eth_call', [{ to, data }, block]);
  }

  async function view(to, data, types, block) {
    return decodeResult(types, await call(to, data, block));
  }

  /** 批量只读调用：calls = [{target, callData}]，返回 [{success, returnData}]，顺序与输入一致 */
  async function multicall(calls, block = 'latest', batch = MULTICALL_BATCH) {
    const out = [];
    for (let i = 0; i < calls.length; i += batch) {
      const chunk = calls.slice(i, i + batch).map((c) => ({ ...c, allowFailure: true }));
      const data = encodeCall(SEL.aggregate3, ['call3[]'], [chunk]);
      out.push(...decodeAggregate3(await call(net.multicall3, data, block)));
    }
    return out;
  }

  /** 解码一个 multicall 结果；失败或返回异常时给 null */
  function take(r, types) {
    if (!r.success || r.returnData === '0x') return null;
    try { return decodeResult(types, r.returnData); } catch { return null; }
  }

  async function cpuCount(block) {
    const [n] = await view(net.factory, SEL.cpuCount, ['uint'], block);
    return Number(n);
  }

  /** 全部处理器（电路 NFT 合约）地址，下标即处理器编号 */
  async function cpuList(block) {
    const n = await cpuCount(block);
    const calls = [];
    for (let i = 0; i < n; i++) calls.push({ target: net.factory, callData: encodeCall(SEL.cpuAt, ['uint'], [i]) });
    return (await multicall(calls, block)).map((r) => {
      const v = take(r, ['address']);
      return v ? v[0] : null;
    });
  }

  /** 钱包在每个处理器上持有的电路数量；返回 [{cpu, circuits, balance}]，只含 balance > 0 的 */
  async function holdings(wallet, cpus, block) {
    const data = encodeCall(SEL.balanceOf, ['address'], [lower(wallet)]);
    const res = await multicall(cpus.map((c) => ({ target: c, callData: data })), block);
    const out = [];
    res.forEach((r, cpu) => {
      const v = take(r, ['uint']);
      if (v && v[0] > 0n && cpus[cpu]) out.push({ cpu, circuits: cpus[cpu], balance: Number(v[0]) });
    });
    return out;
  }

  /** 处理器已铸造到的最大编号（TapeOut 处理器合约的 nextId()，编号从 1 起连续分配） */
  async function maxTokenId(circuits, block) {
    const [n] = await view(circuits, SEL.nextId, ['uint'], block);
    return Number(n);
  }

  /** 在 [from, to] 编号区间里找出 wallet 持有的电路编号；找够 want 个就提前结束 */
  async function ownedIds(circuits, wallet, from, to, want, block, onProgress) {
    const me = lower(wallet);
    const found = [];
    const step = MULTICALL_BATCH * 4;
    for (let start = from; start <= to && found.length < want; start += step) {
      const end = Math.min(to, start + step - 1);
      const calls = [];
      for (let id = start; id <= end; id++) calls.push({ target: circuits, callData: encodeCall(SEL.ownerOf, ['uint'], [id]) });
      const res = await multicall(calls, block);
      res.forEach((r, i) => {
        const v = take(r, ['address']);
        if (v && v[0] === me) found.push(start + i);
      });
      if (onProgress) onProgress(end - from + 1, to - from + 1);
    }
    return found;
  }

  /**
   * 批量读取电路的文件夹状态：持有人、容器地址、容器是否开通、处理器名字。
   * items = [{circuits, tokenId}]，一次 Multicall 读完，返回顺序与输入一致。
   */
  async function circuitInfos(items, block) {
    const calls = [];
    for (const { circuits, tokenId } of items) {
      calls.push(
        { target: circuits, callData: encodeCall(SEL.ownerOf, ['uint'], [tokenId]) },
        { target: net.opener, callData: encodeCall(SEL.accountOf, ['address', 'uint'], [circuits, tokenId]) },
        { target: net.opener, callData: encodeCall(SEL.isOpened, ['address', 'uint'], [circuits, tokenId]) },
        { target: circuits, callData: SEL.name },
      );
    }
    const res = await multicall(calls, block);
    return items.map((_, i) => {
      const owner = take(res[i * 4], ['address']);
      const container = take(res[i * 4 + 1], ['address']);
      const opened = take(res[i * 4 + 2], ['bool']);
      const name = take(res[i * 4 + 3], ['string']);
      return {
        exists: Boolean(owner),
        owner: owner ? owner[0] : null,
        container: container ? container[0] : null,
        opened: opened ? opened[0] : false,
        cpuName: name ? name[0] : '',
      };
    });
  }

  /** 容器里的全部路径（分页读取） */
  async function allPaths(container, block) {
    const [n] = await view(net.registry, encodeCall(SEL.pathCount, ['address'], [container]), ['uint'], block);
    const total = Number(n);
    const out = [];
    for (let from = 0; from < total; from += PATHS_PAGE) {
      const data = encodeCall(SEL.pathsRange, ['address', 'uint', 'uint'], [container, from, PATHS_PAGE]);
      const [page] = await view(net.registry, data, ['string[]'], block);
      out.push(...page);
    }
    return out;
  }

  /** 批量读取文件元数据：返回 Map(path → {size, contentType, sha256, updatedAt, chunkCount}) */
  async function fileInfos(container, paths, block) {
    const res = await multicall(paths.map((p) => ({
      target: net.registry,
      callData: encodeCall(SEL.fileInfo, ['address', 'string'], [container, p]),
    })), block);
    const out = new Map();
    res.forEach((r, i) => {
      const v = take(r, ['uint', 'string', 'bytes32', 'uint', 'uint']);
      if (!v || v[4] === 0n) return;
      out.set(paths[i], { size: Number(v[0]), contentType: v[1], sha256: v[2], updatedAt: Number(v[3]), chunkCount: Number(v[4]) });
    });
    return out;
  }

  /**
   * 读取容器里的 TapeVault 文件夹：只看 _tapevault/ 前缀，容器里的其他文件不碰。
   * 返回 {initialized, meta, files:[{path, size, updatedAt, ...}], otherFileCount}；meta 是 _meta.json 的 fileInfo
   */
  async function vaultListing(container, block) {
    const paths = await allPaths(container, block);
    const mine = paths.filter((p) => p.startsWith(VAULT_PREFIX));
    const infos = mine.length ? await fileInfos(container, mine, block) : new Map();
    const files = [];
    for (const [path, info] of infos) if (path !== VAULT_META) files.push({ path, ...info });
    files.sort((a, b) => b.updatedAt - a.updatedAt);
    return { initialized: infos.has(VAULT_META), meta: infos.get(VAULT_META) || null, files, otherFileCount: paths.length - mine.length };
  }

  async function gasPrice() {
    return BigInt(await rpc('eth_gasPrice', []));
  }

  /** 读取文件的一段字节 */
  async function readRange(container, path, offset, len, block) {
    const data = encodeCall(SEL.readRange, ['address', 'string', 'uint', 'uint'], [container, path, offset, len]);
    const [hex] = await view(net.registry, data, ['bytes'], block);
    return hexToBytes(hex);
  }

  /** 批量读多个文件的开头 len 字节（用于列表时解文件头）。返回 Map(path → Uint8Array)，读失败的不在结果里 */
  async function readHeads(container, paths, len, block) {
    const res = await multicall(paths.map((p) => ({
      target: net.registry,
      callData: encodeCall(SEL.readRange, ['address', 'string', 'uint', 'uint'], [container, p, 0, len]),
    })), block, 40);
    const out = new Map();
    res.forEach((r, i) => {
      const v = take(r, ['bytes']);
      if (v) out.set(paths[i], hexToBytes(v[0]));
    });
    return out;
  }

  /** 读取整个文件并核对长度与 SHA-256（SPEC §5 第 4 条）。onProgress(done, total) */
  async function readVerified(container, path, info, block, onProgress) {
    if (info.size > MAX_FILE_BYTES) throw new Error(t('文件超过 8.4 MB，拒绝读取'));
    const out = new Uint8Array(info.size);
    for (let off = 0; off < info.size; off += READ_RANGE) {
      const part = await readRange(container, path, off, READ_RANGE, block);
      if (!part.length || off + part.length > info.size) throw new Error(t('读取长度异常'));
      out.set(part, off);
      onProgress?.(off + part.length, info.size);
    }
    if ((await sha256Hex(out)) !== info.sha256) throw new Error(t('SHA-256 校验失败：文件可能还在上传中，或已损坏'));
    return out;
  }

  /** 链上时间（秒）：Multicall3.getCurrentBlockTimestamp()，倒计时一律用它，不用本机时钟 */
  async function chainTime(block = 'latest') {
    const [ts] = await view(net.multicall3, SEL.getCurrentBlockTimestamp, ['uint'], block);
    return Number(ts);
  }

  /**
   * 核对 personal_sign 签名：用 ecrecover 预编译合约（地址 0x01）恢复签名人。
   * 经由 eth_call 在节点上算，页面不必带椭圆曲线库。签名无效时返回 null。
   */
  async function recoverSigner(text, signatureHex) {
    const sig = hexToBytes(signatureHex);
    if (sig.length !== 65) return null;
    let v = sig[64];
    if (v < 27) v += 27;
    if (v !== 27 && v !== 28) return null;
    const msg = new TextEncoder().encode(text);
    const digest = keccak256(new Uint8Array([...new TextEncoder().encode('\x19Ethereum Signed Message:\n' + msg.length), ...msg]));
    const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const data = '0x' + hex(digest) + v.toString(16).padStart(64, '0') + hex(sig.subarray(0, 32)) + hex(sig.subarray(32, 64));
    const out = await call('0x0000000000000000000000000000000000000001', data);
    if (!out || out === '0x' || out.length < 66) return null;
    const addr = '0x' + out.slice(-40).toLowerCase();
    return /^0x0{40}$/.test(addr) ? null : addr;
  }

  return { pinBlock, multicall, recoverSigner, chainTime, cpuCount, cpuList, holdings, maxTokenId, ownedIds, circuitInfos, allPaths, fileInfos, vaultListing, gasPrice, readRange, readHeads, readVerified };
}

// ---------------------------------------------------------------- 写入（生成交易，不签名、不发送）

/** 把一个文件切成 SiteRegistry 的写入交易：第 1 笔 putFile，其余 appendChunk。返回 [{to, data}] */
export function fileWriteTxs(container, path, contentType, sha256, bytes, net = BSC) {
  if (!bytes.length) throw new Error(t('空文件'));
  if (bytes.length > MAX_FILE_BYTES) throw new Error(t('文件超过链上上限 8.4 MB'));
  const txs = [{
    to: net.registry,
    data: encodeCall(SEL.putFile, ['address', 'string', 'string', 'bytes32', 'bytes'],
      [container, path, contentType, sha256, bytes.subarray(0, CHUNK_SIZE)]),
  }];
  for (let i = 1; i * CHUNK_SIZE < bytes.length; i++) {
    txs.push({
      to: net.registry,
      data: encodeCall(SEL.appendChunk, ['address', 'string', 'uint', 'bytes'],
        [container, path, i, bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)]),
    });
  }
  return txs;
}

export function removeFileTx(container, path, net = BSC) {
  return { to: net.registry, data: encodeCall(SEL.removeFile, ['address', 'string'], [container, path]) };
}
