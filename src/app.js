// 界面层：钱包连接与文件夹列表。文件夹详情在 detail.js。

import { BSC } from './config.js';
import { discoverWallets, connect, ensureChain, walletRpc } from './wallet.js';
import { createChain } from './chain.js';
import { scanFolders, verifyFolders, loadCache, saveCache, parseFolderInput, folderLabel } from './folders.js';
import { $, el, short, errText } from './dom.js';
import { openFolder as openDetail, closeFolder, forgetKeys, openLegacyDialog, legacyBusy } from './detail.js';
import { openHeir, closeHeir } from './heir.js';

// wantHeir：从「我是继承人 / 守护人」进来，连上钱包后直接去继承人页面
const state = { provider: null, account: null, chain: null, cpus: null, folders: [], busy: false, wantHeir: false };
const setStatus = (msg, kind = '') => { const s = $('status'); s.textContent = msg; s.dataset.kind = kind; };

// ---------------------------------------------------------------- 钱包

async function onConnectClick() {
  const wallets = await discoverWallets();
  if (!wallets.length) {
    state.wantHeir = false;
    showIntroMessage('没有检测到浏览器钱包。请安装 MetaMask、OKX Wallet 等支持 BNB Chain 的钱包扩展后刷新页面。');
    return;
  }
  if (wallets.length === 1) return useWallet(wallets[0]);
  const list = $('wallet-list');
  list.replaceChildren(...wallets.map((w) => el('li', {},
    el('button', { type: 'button', class: 'btn wallet-option', on: { click: () => useWallet(w) } },
      safeIcon(w.icon), w.name))));
  $('wallet-picker').returnValue = '';
  $('wallet-picker').showModal();
  list.querySelector('button')?.focus();
}

/** 只接受 data:image 图标，防止钱包公告里塞外链 */
function safeIcon(src) {
  if (typeof src !== 'string' || !/^data:image\/(png|svg\+xml|webp|jpeg|gif);/i.test(src)) return null;
  return el('img', { src, alt: '', width: 20, height: 20 });
}

function showIntroMessage(msg) {
  const hero = document.querySelector('#intro .hero');
  let p = hero.querySelector('.intro-error');
  if (!p) { p = el('p', { class: 'intro-error', role: 'alert' }); hero.append(p); }
  p.textContent = msg;
}

async function useWallet(w) {
  if ($('wallet-picker').open) $('wallet-picker').close('picked');
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
    if (state.wantHeir) { state.wantHeir = false; showHeir(); return; }
    $('folders-view').hidden = false;
    await loadFolders(false);
  } catch (e) {
    state.wantHeir = false;
    showIntroMessage('连接失败：' + errText(e));
  }
}

function onAccountsChanged(accounts) {
  if (!accounts || !accounts.length) return disconnect();
  forgetKeys();
  state.account = String(accounts[0]).toLowerCase();
  state.folders = [];
  renderWallet();
  closeDetail();
  loadFolders(false);
}

function disconnect() {
  state.provider?.removeListener?.('accountsChanged', onAccountsChanged);
  closeFolder();
  forgetKeys();   // 清掉内存里的密钥
  Object.assign(state, { provider: null, account: null, chain: null, cpus: null, folders: [] });
  $('wallet-area').replaceChildren(el('button', { type: 'button', id: 'connect-btn', class: 'btn primary', on: { click: onConnectClick } }, '连接钱包'));
  closeHeir();
  $('folders-view').hidden = true;
  $('folder-detail').hidden = true;
  $('heir-view').hidden = true;
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
    const tail = skipped.length ? `；另有 ${skipped.map((s) => `处理器 ${s.cpu}`).join('、')} 编号过多未自动扫描，可在下方手动添加` : '';
    if (skipped.length) $('add-panel').open = true;
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

function openFolder(f) {
  $('folders-view').hidden = true;
  $('folder-detail').hidden = false;
  $('back-btn').focus();
  openDetail({ provider: state.provider, account: state.account, chain: state.chain }, f);
}

function closeDetail() {
  closeFolder();
  $('folder-detail').hidden = true;
  if (state.account) $('folders-view').hidden = false;
}

// ---------------------------------------------------------------- 继承人 / 守护人

function showHeir() {
  closeFolder();
  $('folders-view').hidden = true;
  $('folder-detail').hidden = true;
  $('heir-view').hidden = false;
  openHeir({ provider: state.provider, chain: state.chain });
}

function hideHeir() {
  closeHeir();
  $('heir-view').hidden = true;
  $('folders-view').hidden = false;
  if (!state.folders.length && !state.busy) loadFolders(false);
}

// ---------------------------------------------------------------- 启动

$('connect-btn').addEventListener('click', onConnectClick);
$('hero-connect').addEventListener('click', onConnectClick);
$('hero-heir').addEventListener('click', () => { state.wantHeir = true; onConnectClick(); });
$('heir-open-btn').addEventListener('click', showHeir);
$('heir-back').addEventListener('click', hideHeir);
// 没选钱包就关掉选择窗口（✕、Esc、点遮罩）：取消「去继承人页面」的意图，避免之后普通连接也跳过去
$('wallet-picker').addEventListener('close', () => { if ($('wallet-picker').returnValue !== 'picked') state.wantHeir = false; });
$('wallet-picker-close').addEventListener('click', () => $('wallet-picker').close());
$('legacy-btn').addEventListener('click', openLegacyDialog);
$('legacy-close').addEventListener('click', () => { if (!legacyBusy()) $('legacy-dialog').close(); });
// 签名或交易进行中不允许按 Esc 关闭
$('legacy-dialog').addEventListener('cancel', (e) => { if (legacyBusy()) e.preventDefault(); });
// 点遮罩关闭（点击落在 dialog 自身而不是里面的内容上）
// 遗产表单内容多，不做点遮罩关闭，避免误触丢掉已填内容
$('wallet-picker').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
/** 复制按钮：把 source 元素的文本写进剪贴板；不可用时选中文本让用户手动复制 */
function bindCopy(btnId, sourceId, what) {
  $(btnId).addEventListener('click', async () => {
    const btn = $(btnId);
    let ok = false;
    try {
      await navigator.clipboard.writeText($(sourceId).textContent.trim());
      ok = true;
    } catch {
      getSelection().selectAllChildren($(sourceId));
    }
    btn.textContent = ok ? '已复制' : '已选中，请手动复制';
    $('copy-status').textContent = ok ? what + '已复制' : what + '已选中';
    setTimeout(() => { btn.textContent = '复制'; }, 2000);
  });
}
bindCopy('copy-donate', 'donate-address', '钱包地址');
bindCopy('copy-x', 'x-handle', 'X 地址');
$('rescan-btn').addEventListener('click', () => loadFolders(true));
$('add-form').addEventListener('submit', onAddSubmit);
$('back-btn').addEventListener('click', closeDetail);
