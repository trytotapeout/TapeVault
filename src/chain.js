// 只读链访问。所有请求都经由调用方传入的 rpc(method, params)：
//   浏览器里是用户钱包（EIP-1193 provider.request），测试里是直连公共节点。
// 本模块不发起任何 fetch，也不依赖任何后端或索引服务。

import { encodeCall, decodeResult, decodeAggregate3 } from './abi.js';
import { BSC, SEL, MULTICALL_BATCH, PATHS_PAGE, VAULT_PREFIX, VAULT_META } from './config.js';

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
  async function multicall(calls, block = 'latest') {
    const out = [];
    for (let i = 0; i < calls.length; i += MULTICALL_BATCH) {
      const chunk = calls.slice(i, i + MULTICALL_BATCH).map((c) => ({ ...c, allowFailure: true }));
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
   * 返回 {initialized, files:[{path, size, updatedAt, ...}], otherFileCount}
   */
  async function vaultListing(container, block) {
    const paths = await allPaths(container, block);
    const mine = paths.filter((p) => p.startsWith(VAULT_PREFIX));
    const infos = mine.length ? await fileInfos(container, mine, block) : new Map();
    const files = [];
    for (const [path, info] of infos) if (path !== VAULT_META) files.push({ path, ...info });
    files.sort((a, b) => b.updatedAt - a.updatedAt);
    return { initialized: infos.has(VAULT_META), files, otherFileCount: paths.length - mine.length };
  }

  return { pinBlock, multicall, cpuCount, cpuList, holdings, maxTokenId, ownedIds, circuitInfos, allPaths, fileInfos, vaultListing };
}
