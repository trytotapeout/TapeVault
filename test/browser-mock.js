// 浏览器里的模拟钱包（仅本地开发测试用，不上链）。
// 读链转发到 dev-server 的 /__rpc；对 SiteRegistry 的读写全部在内存里模拟，交易不会真的发出。
// 用法（在 dev-server 页面的控制台）：
//   const m = await import('/test/browser-mock.js'); m.install('0x…持有人地址');

import { decodeResult, hexToBytes, bytesToHex } from '../src/abi.js';
import { BSC, SEL, CHUNK_SIZE } from '../src/config.js';
import { personalSign, addressOf, randomPriv } from './secp256k1.mjs';

const lower = (a) => String(a).toLowerCase();
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const padR = (h) => h + '0'.repeat((64 - (h.length % 64)) % 64);
const dynBytes = (b) => word(b.length) + padR(bytesToHex(b).slice(2));
const utf8 = (s) => new TextEncoder().encode(s);

export const store = new Map();   // path → {bytes, contentType, sha256, updatedAt}
export const sent = [];
/** ecrecover 结果改写：测试私钥地址 → 模拟的持有人地址 */
const recoverAlias = new Map();
/** 链上时间偏移（秒），测试到期用：m.timeSkew.value = 8 * 86400 */
export const timeSkew = { value: 0 };
let clock = Math.floor(Date.now() / 1000);

function registryCall(data) {
  const sel = data.slice(0, 10);
  const args = '0x' + data.slice(10);
  if (sel === SEL.pathCount) return '0x' + word(store.size);
  if (sel === SEL.pathsRange) {
    const [, from, n] = decodeResult(['address', 'uint', 'uint'], args);
    const list = [...store.keys()].slice(Number(from), Number(from) + Number(n));
    let head = ''; let tail = '';
    for (const p of list) { head += word(list.length * 32 + tail.length / 2); tail += dynBytes(utf8(p)); }
    return '0x' + word(32) + word(list.length) + head + tail;
  }
  if (sel === SEL.fileInfo) {
    const [, path] = decodeResult(['address', 'string'], args);
    const f = store.get(path);
    if (!f) return '0x' + word(0) + word(160) + word(0) + word(0) + word(0) + word(0);
    return '0x' + word(f.bytes.length) + word(160) + f.sha256.slice(2) + word(f.updatedAt) + word(Math.ceil(f.bytes.length / CHUNK_SIZE)) + dynBytes(utf8(f.contentType));
  }
  if (sel === SEL.readRange) {
    const [, path, off, len] = decodeResult(['address', 'string', 'uint', 'uint'], args);
    const f = store.get(path);
    if (!f) throw new Error('NoSuchFile');
    return '0x' + word(32) + dynBytes(f.bytes.slice(Number(off), Number(off) + Number(len)));
  }
  throw new Error('mock registry: unsupported ' + sel);
}

function execTx(data) {
  const args = '0x' + data.slice(10);
  if (data.startsWith(SEL.putFile)) {
    const [, path, contentType, sha256, bytes] = decodeResult(['address', 'string', 'string', 'bytes32', 'bytes'], args);
    store.set(path, { bytes: hexToBytes(bytes), contentType, sha256, updatedAt: ++clock });
  } else if (data.startsWith(SEL.appendChunk)) {
    const [, path, idx, bytes] = decodeResult(['address', 'string', 'uint', 'bytes'], args);
    const f = store.get(path);
    if (!f || Number(idx) !== Math.ceil(f.bytes.length / CHUNK_SIZE)) throw new Error('execution reverted: BadIndex');
    const add = hexToBytes(bytes);
    const m = new Uint8Array(f.bytes.length + add.length); m.set(f.bytes); m.set(add, f.bytes.length);
    f.bytes = m; f.updatedAt = ++clock;
  } else throw new Error('mock: unsupported tx');
}

export function install(account, { failAtTx = -1, rejectSign = false, signerKey = null } = {}) {
  // 模拟钱包的地址是真实持有人地址（为了读到真实电路），但我们没有它的私钥。
  // 遗产记录的签名改用一把测试私钥，并让 ecrecover 把这把私钥的地址映射回 account。
  const key = signerKey || randomPriv();
  recoverAlias.set(addressOf(key), lower(account));
  let id = 0;
  const real = async (method, params) => {
    const j = await (await fetch('/__rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })).json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  const opts = { failAtTx, rejectSign, signerKey: key };
  const provider = {
    opts,
    async request({ method, params }) {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [account];
        case 'eth_chainId': return '0x38';
        case 'eth_gasPrice': return '0x2faf080';
        case 'personal_sign': {
          if (opts.rejectSign) throw Object.assign(new Error('User rejected'), { code: 4001 });
          const text = new TextDecoder().decode(hexToBytes(params[0]));
          // 派生加密密钥的消息必须每次得到相同签名：用确定性假签名（ecrecover 不会用到它）
          if (text.startsWith('TapeVault 加密密钥')) {
            const h = new Uint8Array(await crypto.subtle.digest('SHA-256', hexToBytes(params[0])));
            return bytesToHex(new Uint8Array([...h, ...h, 27]));
          }
          // 其余消息（遗产记录）用真实 secp256k1 私钥签名，ecrecover 恢复出 opts.signer
          return personalSign(opts.signerKey, text);
        }
        case 'eth_estimateGas': return '0x100000';
        case 'eth_sendTransaction': {
          if (opts.failAtTx === sent.length) { opts.failAtTx = -1; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
          execTx(params[0].data);
          sent.push(params[0]);
          return '0x' + word(sent.length);
        }
        case 'eth_getTransactionReceipt': return { blockNumber: '0x1', status: '0x1' };
        case 'eth_call': {
          const { to, data } = params[0];
          if (lower(to) === BSC.registry) return registryCall(data);
          // 测试到期：把链上时间往后拨 timeSkew 秒
          if (lower(to) === BSC.multicall3 && data === SEL.getCurrentBlockTimestamp) {
            return '0x' + word(BigInt(await real(method, params)) + BigInt(timeSkew.value));
          }
          if (lower(to) === '0x0000000000000000000000000000000000000001') {
            const out = await real(method, params);
            const got = '0x' + out.slice(-40).toLowerCase();
            return recoverAlias.has(got) ? '0x' + word(BigInt(recoverAlias.get(got))) : out;
          }
          // 批量调用里有发往 SiteRegistry 的才拆开模拟，否则整批转发
          if (lower(to) === BSC.multicall3 && data.includes(BSC.registry.slice(2))) return multicall(data, params[1], real);
          return real(method, params);
        }
        default: return real(method, params);
      }
    },
    on() {}, removeListener() {},
  };
  window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
    detail: { info: { uuid: 'mock-' + account, name: 'Mock Wallet', icon: '', rdns: 'dev.mock' }, provider } })));
  return provider;
}

/** 解开 aggregate3：发往 SiteRegistry 的子调用走内存，其余子调用逐个转发到真实节点 */
async function multicall(data, block, real) {
  const b = hexToBytes(data.slice(10));
  const u = (off) => Number(BigInt(bytesToHex(b.subarray(off, off + 32))));
  const n = u(u(0));
  const base = u(0) + 32;
  const results = [];
  for (let i = 0; i < n; i++) {
    const t = base + u(base + i * 32);
    const target = '0x' + bytesToHex(b.subarray(t + 12, t + 32)).slice(2);
    const cdOff = t + u(t + 64);
    const cd = bytesToHex(b.subarray(cdOff + 32, cdOff + 32 + u(cdOff)));
    try {
      results.push({ ok: true, ret: lower(target) === BSC.registry ? registryCall(cd) : await real('eth_call', [{ to: target, data: cd }, block]) });
    } catch {
      results.push({ ok: false, ret: '0x' });
    }
  }
  let head = ''; let tail = '';
  for (const r of results) {
    head += word(results.length * 32 + tail.length / 2);
    tail += word(r.ok ? 1 : 0) + word(64) + dynBytes(hexToBytes(r.ret));
  }
  return '0x' + word(32) + word(results.length) + head + tail;
}

