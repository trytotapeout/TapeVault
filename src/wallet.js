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

/** 把 provider 包成 chain.js 需要的 rpc(method, params)。链是否正确由调用方在每次操作前用 ensureChain 确认。 */
export function walletRpc(provider) {
  return (method, params) => provider.request({ method, params });
}
