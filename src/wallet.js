// 钱包连接：EIP-6963 多钱包发现，退回 window.ethereum。只用 EIP-1193 标准方法。

import { BSC } from './config.js';

/** 发现已安装的钱包；返回 [{id, name, icon, provider}] */
export function discoverWallets(timeoutMs = 400) {
  return new Promise((resolve) => {
    const found = new Map();
    const onAnnounce = (e) => {
      const d = e.detail;
      if (d && d.info && d.provider && !found.has(d.info.uuid)) {
        found.set(d.info.uuid, { id: d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider });
      }
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
      const list = [...found.values()];
      if (!list.length && window.ethereum) list.push({ id: 'injected', name: '浏览器钱包', icon: '', provider: window.ethereum });
      resolve(list);
    }, timeoutMs);
  });
}

/** 请求授权并切到 BNB Smart Chain；返回当前账户（小写） */
export async function connect(provider) {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts || !accounts.length) throw new Error('钱包没有返回账户');
  await ensureChain(provider);
  return String(accounts[0]).toLowerCase();
}

export async function currentChainId(provider) {
  return Number(await provider.request({ method: 'eth_chainId' }));
}

export async function ensureChain(provider, net = BSC) {
  if ((await currentChainId(provider)) === net.chainId) return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: net.chainIdHex }] });
  } catch (e) {
    // 4902：钱包里没有这条链，先添加
    if (e && (e.code === 4902 || e?.data?.originalError?.code === 4902)) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: net.chainIdHex,
          chainName: net.name,
          nativeCurrency: { name: net.currency, symbol: net.currency, decimals: 18 },
          rpcUrls: [...net.rpcUrls],
          blockExplorerUrls: [net.explorer],
        }],
      });
    } else {
      throw e;
    }
  }
  if ((await currentChainId(provider)) !== net.chainId) throw new Error('请在钱包里切换到 ' + net.name);
}

/** personal_sign 一段 UTF-8 文本，返回 0x 开头的签名 */
export async function signText(provider, account, text) {
  const bytes = new TextEncoder().encode(text);
  const hex = '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return provider.request({ method: 'personal_sign', params: [hex, account] });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 发送一笔交易并等到上链。先 eth_estimateGas（失败说明交易会回滚，不发送），gas 上浮 20%。
 * 回滚或超时抛错。返回回执。
 */
export async function sendAndWait(provider, account, tx, { timeoutMs = 180000 } = {}) {
  const req = { from: account, to: tx.to, data: tx.data, value: '0x0' };
  const est = BigInt(await provider.request({ method: 'eth_estimateGas', params: [req] }));
  const gas = '0x' + ((est * 12n) / 10n).toString(16);
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ ...req, gas }] });
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (r && r.blockNumber) {
      if (r.status !== '0x1') throw new Error('交易回滚：' + hash);
      return r;
    }
    await sleep(1500);
  }
  throw new Error('等待交易确认超时：' + hash);
}

/** 用户在钱包里点了拒绝 */
export const isUserRejection = (e) => e && (e.code === 4001 || e?.data?.originalError?.code === 4001 || /reject|denied|cancel/i.test(e.message || ''));

/** 把 provider 包成 chain.js 需要的 rpc(method, params)。链是否正确由调用方在每次操作前用 ensureChain 确认。 */
export function walletRpc(provider) {
  return (method, params) => provider.request({ method, params });
}
