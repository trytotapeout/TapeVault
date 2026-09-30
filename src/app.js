// 界面层。链上读到的字符串（处理器名字、路径）都可能被任何人设置，一律用 textContent 渲染，不拼 HTML。

import { BSC, VAULT_PREFIX } from './config.js';
import { discoverWallets, connect, ensureChain, walletRpc } from './wallet.js';
import { createChain } from './chain.js';
import { scanFolders, verifyFolders, loadCache, saveCache, parseFolderInput, folderLabel } from './folders.js';

const $ = (id) => document.getElementById(id);
const state = { provider: null, account: null, chain: null, cpus: null, folders: [], busy: false };

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : String(c));
  return n;
}

const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const setStatus = (msg, kind = '') => { const s = $('status'); s.textContent = msg; s.dataset.kind = kind; };
const errText = (e) => (e && (e.shortMessage || e.message)) || String(e);

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function formatTime(sec) {
  return sec ? new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';
}

// ---------------------------------------------------------------- 钱包

async function onConnectClick() {
  const wallets = await discoverWallets();
  if (!wallets.length) {
    showIntroMessage('没有检测到浏览器钱包。请安装 MetaMask、OKX Wallet 等支持 BNB Chain 的钱包扩展后刷新页面。');
    return;
  }
  if (wallets.length === 1) return useWallet(wallets[0]);
  const list = $('wallet-list');
  list.replaceChildren(...wallets.map((w) => el('li', {},
    el('button', { type: 'button', class: 'btn wallet-option', on: { click: () => useWallet(w) } },
      safeIcon(w.icon), w.name))));
  $('wallet-picker').hidden = false;
}

/** 只接受 data:image 图标，防止钱包公告里塞外链 */
function safeIcon(src) {
  if (typeof src !== 'string' || !/^data:image\/(png|svg\+xml|webp|jpeg|gif);/i.test(src)) return null;
  return el('img', { src, alt: '', width: 20, height: 20 });
}

function showIntroMessage(msg) {
  const intro = $('intro');
  let p = intro.querySelector('.intro-error');
  if (!p) { p = el('p', { class: 'intro-error', role: 'alert' }); intro.append(p); }
  p.textContent = msg;
}

async function useWallet(w) {
  $('wallet-picker').hidden = true;
  try {
    const account = await connect(w.provider);
    state.provider = w.provider;
    state.account = account;
    state.chain = createChain(walletRpc(w.provider));
    state.cpus = null;
    w.provider.on?.('accountsChanged', onAccountsChanged);
    w.provider.on?.('chainChanged', () => { if (state.account) loadFolders(false); });
    renderWallet();
    $('intro').hidden = true;
    $('folders-view').hidden = false;
    await loadFolders(false);
  } catch (e) {
    showIntroMessage('连接失败：' + errText(e));
  }
}

function onAccountsChanged(accounts) {
  if (!accounts || !accounts.length) return disconnect();
  state.account = String(accounts[0]).toLowerCase();
  state.folders = [];
  renderWallet();
  closeDetail();
  loadFolders(false);
}

function disconnect() {
  state.provider?.removeListener?.('accountsChanged', onAccountsChanged);
  Object.assign(state, { provider: null, account: null, chain: null, cpus: null, folders: [] });
  $('wallet-area').replaceChildren(el('button', { type: 'button', id: 'connect-btn', class: 'btn primary', on: { click: onConnectClick } }, '连接钱包'));
  $('folders-view').hidden = true;
  $('folder-detail').hidden = true;
  $('folder-list').replaceChildren();
  setStatus('');
  $('intro').hidden = false;
}

function renderWallet() {
  $('wallet-area').replaceChildren(
    el('span', { class: 'chip', title: state.account }, el('span', { class: 'dot', 'aria-hidden': 'true' }), BSC.name + ' · ' + short(state.account)),
    el('button', { type: 'button', class: 'btn link', on: { click: disconnect } }, '断开'),
  );
}

// ---------------------------------------------------------------- 文件夹

/** full=false：先用本地缓存 + 链上核对快速显示；缓存为空时自动做完整扫描 */
async function loadFolders(full) {
  if (state.busy || !state.chain) return;
  state.busy = true;
  $('rescan-btn').disabled = true;
  const account = state.account;
  try {
    await ensureChain(state.provider);
    const block = await state.chain.pinBlock();
    if (!state.cpus) {
      setStatus('读取处理器列表…');
      state.cpus = await state.chain.cpuList(block);
    }
    const cached = loadCache(localStorage, account);
    let candidates = cached;
    let skipped = [];
    if (full || !cached.length) {
      const scan = await scanFolders(state.chain, account, { onProgress: renderProgress });
      state.cpus = scan.cpus;
      skipped = scan.skipped;
      // 手动添加过的也保留，重新核对后再决定去留
      candidates = [...scan.found, ...cached];
    }
    setStatus('核对持有状态…');
    const folders = await verifyFolders(state.chain, account, candidates, state.cpus, block);
    if (account !== state.account) return;   // 扫描期间切换了账户
    state.folders = folders;
    saveCache(localStorage, account, folders);
    renderFolders();
    const tail = skipped.length ? `；另有 ${skipped.map((s) => `处理器 ${s.cpu}`).join('、')} 编号过多未自动扫描，可手动添加` : '';
    setStatus(folders.length ? `共 ${folders.length} 个文件夹${tail}` : `这个钱包在 BNB Chain 上没有 TapeOut 电路${tail}`, skipped.length ? 'warn' : '');
  } catch (e) {
    setStatus('读取失败：' + errText(e), 'error');
  } finally {
    state.busy = false;
    $('rescan-btn').disabled = false;
  }
}

function renderProgress(p) {
  if (p.stage === 'cpus') setStatus('读取处理器列表…');
  else if (p.stage === 'balances') setStatus(`在 ${p.total} 台处理器上查找你的电路…`);
  else if (p.stage === 'ids') setStatus(`处理器 ${p.cpu}：已扫描 ${p.done} / ${p.total} 个编号…`);
}

function renderFolders() {
  const list = $('folder-list');
  if (!state.folders.length) { list.replaceChildren(); return; }
  list.replaceChildren(...state.folders.map((f) => el('li', {},
    el('button', { type: 'button', class: 'folder-card', on: { click: () => openFolder(f) }, 'aria-label': `打开文件夹 ${f.label}` },
      el('span', { class: 'folder-icon', 'aria-hidden': 'true' }, f.opened ? '🗂' : '📁'),
      el('span', { class: 'folder-name' }, f.label),
      el('span', { class: 'folder-cpu' }, f.cpuName || `处理器 ${f.cpu}`),
      el('span', { class: 'badge ' + (f.opened ? 'ok' : 'off') }, f.opened ? '容器已开通' : '容器未开通'),
    ))));
}

async function onAddSubmit(ev) {
  ev.preventDefault();
  const input = $('add-input');
  const parsed = parseFolderInput(input.value);
  if (!parsed) { setStatus('格式不对，请输入 <#ID>.<处理器编号>，例如 4246.0', 'error'); return; }
  if (!state.cpus || parsed.cpu >= state.cpus.length) { setStatus(`处理器 ${parsed.cpu} 不存在`, 'error'); return; }
  try {
    await ensureChain(state.provider);
    const block = await state.chain.pinBlock();
    const [f] = await verifyFolders(state.chain, state.account, [parsed], state.cpus, block);
    if (!f) { setStatus(`${folderLabel(parsed.tokenId, parsed.cpu)} 不属于当前钱包`, 'error'); return; }
    if (!state.folders.some((x) => x.label === f.label)) {
      state.folders = [...state.folders, f].sort((a, b) => a.cpu - b.cpu || a.tokenId - b.tokenId);
      saveCache(localStorage, state.account, state.folders);
      renderFolders();
    }
    input.value = '';
    setStatus(`已添加 ${f.label}`);
  } catch (e) {
    setStatus('添加失败：' + errText(e), 'error');
  }
}

// ---------------------------------------------------------------- 文件夹详情

async function openFolder(f) {
  $('folders-view').hidden = true;
  const d = $('folder-detail');
  d.hidden = false;
  $('detail-title').textContent = f.label;
  $('detail-meta').replaceChildren(
    ...metaRow('处理器', `${f.cpuName || '—'}（编号 ${f.cpu}）`),
    ...metaRow('电路合约', f.circuits),
    ...metaRow('容器地址', f.container),
    ...metaRow('容器状态', f.opened ? '已开通' : '未开通'),
  );
  const body = $('detail-body');
  $('back-btn').focus();
  if (!f.opened) {
    body.replaceChildren(el('p', { class: 'notice' }, '这枚电路的容器还没开通，暂时不能存放文件。请先在 TapeOut 官网为它开通容器，之后刷新这里即可使用。'));
    return;
  }
  body.replaceChildren(el('p', { class: 'muted' }, '读取文件列表…'));
  try {
    await ensureChain(state.provider);
    const block = await state.chain.pinBlock();
    const v = await state.chain.vaultListing(f.container, block);
    renderListing(body, v);
  } catch (e) {
    body.replaceChildren(el('p', { class: 'notice error' }, '读取失败：' + errText(e)));
  }
}

function metaRow(k, v) {
  return [el('dt', {}, k), el('dd', {}, el('code', {}, v || '—'))];
}

function renderListing(body, v) {
  const parts = [];
  if (v.otherFileCount) parts.push(el('p', { class: 'muted' }, `容器里另有 ${v.otherFileCount} 个非 TapeVault 文件（例如 DeWEB 网站），TapeVault 不会读取或改动它们。`));
  if (!v.initialized) {
    parts.push(el('p', { class: 'notice' }, `这个文件夹还没有初始化 TapeVault（${VAULT_PREFIX} 目录不存在）。上传与加密功能将在下一个版本提供。`));
  } else if (!v.files.length) {
    parts.push(el('p', { class: 'muted' }, '文件夹是空的。'));
  } else {
    const rows = v.files.map((f) => el('tr', {},
      el('td', {}, el('code', {}, f.path.slice(VAULT_PREFIX.length))),
      el('td', {}, formatSize(f.size)),
      el('td', {}, formatTime(f.updatedAt))));
    parts.push(el('table', { class: 'files' },
      el('caption', { class: 'sr-only' }, '文件列表（内容已加密）'),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '存储路径'), el('th', { scope: 'col' }, '大小'), el('th', { scope: 'col' }, '更新时间'))),
      el('tbody', {}, ...rows)));
  }
  body.replaceChildren(...parts);
}

function closeDetail() {
  $('folder-detail').hidden = true;
  if (state.account) $('folders-view').hidden = false;
}

// ---------------------------------------------------------------- 启动

$('connect-btn').addEventListener('click', onConnectClick);
$('rescan-btn').addEventListener('click', () => loadFolders(true));
$('add-form').addEventListener('submit', onAddSubmit);
$('back-btn').addEventListener('click', closeDetail);
