// 文件夹详情：初始化、解锁、上传、列表、下载。
// 所有写操作都是用户钱包直接调用 SiteRegistry（持有人即编辑者），每一块一笔交易，逐笔确认。

import { $, el, errText, formatSize, formatTime, formatBnb } from './dom.js';
import { BSC, VAULT_PREFIX, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from './config.js';
import { ensureChain, signText, sendAndWait, isUserRejection } from './wallet.js';
import * as vault from './vault.js';

// 当前会话。keys 只放在内存里，关闭页面即失效；换文件夹、换账户都会清掉。
const s = { ctx: null, folder: null, keys: null, listing: null, meta: null, entries: [], locked: 0, broken: 0, busy: false, seq: 0 };

const lower = (a) => String(a).toLowerCase();
const body = () => $('detail-body');

// 解锁过的密钥按「账户 + 容器」缓存在内存里，同一页面内重新打开文件夹不必再签名。
// 断开钱包、切换账户（forgetKeys）或刷新页面后失效。
const keyCache = new Map();
const cacheKey = () => lower(s.ctx.account) + ':' + lower(s.folder.container);

export function forgetKeys() {
  keyCache.clear();
  pending = null;
}

/** ctx = {provider, account, chain}；由 app.js 在打开文件夹时传入 */
export async function openFolder(ctx, f) {
  s.seq++;
  Object.assign(s, { ctx, folder: f, keys: null, listing: null, meta: null, entries: [], locked: 0, broken: 0, busy: false });
  s.keys = keyCache.get(cacheKey()) || null;
  $('detail-title').textContent = f.label;
  $('detail-meta').replaceChildren(
    ...metaRow('处理器', `${f.cpuName || '—'}（编号 ${f.cpu}）`),
    ...metaRow('电路合约', f.circuits),
    ...metaRow('容器地址', f.container),
    ...metaRow('容器状态', f.opened ? '已开通' : '未开通'),
  );
  if (!f.opened) {
    body().replaceChildren(el('p', { class: 'notice' }, '这枚电路的容器还没开通，暂时不能存放文件。请先在 TapeOut 官网为它开通容器，之后刷新这里即可使用。'));
    return;
  }
  await refresh();
}

export function closeFolder() {
  s.seq++;
  Object.assign(s, { ctx: null, folder: null, keys: null, listing: null, meta: null, entries: [] });
}

function metaRow(k, v) {
  return [el('dt', {}, k), el('dd', {}, el('code', {}, v || '—'))];
}

/** 重新读链。已解锁时顺带解开文件列表 */
async function refresh() {
  const seq = s.seq;
  const { chain, provider } = s.ctx;
  const c = s.folder.container;
  body().replaceChildren(el('p', { class: 'muted' }, '读取文件夹…'));
  try {
    await ensureChain(provider);
    const block = await chain.pinBlock();
    const listing = await chain.vaultListing(c, block);
    const meta = listing.initialized ? await vault.readMeta(chain, c, listing, block) : null;
    if (seq !== s.seq) return;
    s.listing = listing;
    s.meta = meta;
    if (s.keys && meta) {
      const r = await vault.decodeListing(chain, s.keys, c, listing, block);
      if (seq !== s.seq) return;
      Object.assign(s, r);
    }
    render();
  } catch (e) {
    if (seq === s.seq) body().replaceChildren(el('p', { class: 'notice error' }, '读取失败：' + errText(e)));
  }
}

function render() {
  const parts = [];
  if (s.listing.otherFileCount) {
    parts.push(el('p', { class: 'muted small' }, `容器里另有 ${s.listing.otherFileCount} 个非 TapeVault 文件（例如 DeWEB 网站），TapeVault 不会读取或改动它们。`));
  }
  if (!s.meta) parts.push(renderInit());
  else if (!s.keys) parts.push(renderLocked());
  else parts.push(renderUpload(), renderFiles());
  body().replaceChildren(...parts);
}

/** 用户在钱包里签名的回调，给 vault.unlock 用 */
const signer = () => (msg) => signText(s.ctx.provider, s.ctx.account, msg);

/** 当前钱包是否仍是这个文件夹的持有人（写入前核对，避免转手后误操作） */
function isHolder() {
  return lower(s.folder.owner) === lower(s.ctx.account);
}
// ---------------------------------------------------------------- 初始化 / 解锁

function renderInit() {
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  const btn = el('button', { type: 'button', class: 'btn primary' }, '初始化保险箱');
  btn.addEventListener('click', () => guarded(btn, msg, async () => {
    msg.textContent = '请在钱包里签名（共 2 次，用来生成并核对加密密钥，不花 gas）…';
    const keys = await vault.unlock(signer(), s.folder.container, BSC.chainId, null);
    msg.textContent = '请在钱包里确认交易：写入 _tapevault/_meta.json（约 0.0001 BNB）…';
    for (const tx of await vault.metaWriteTxs(s.folder.container, keys.keyCheck)) await sendAndWait(s.ctx.provider, s.ctx.account, tx);
    s.keys = keys;
    keyCache.set(cacheKey(), keys);
    await refresh();
  }));
  return el('div', { class: 'card' },
    el('h3', {}, '这个文件夹还没有启用 TapeVault'),
    el('ul', { class: 'plain' },
      el('li', {}, '文件在你的浏览器里加密后才上链，链上只有密文；文件名、类型、大小也都在密文里。'),
      el('li', {}, '加密密钥由你的钱包签名生成，不保存在任何地方。换设备时连同一个钱包、再签一次即可恢复。'),
      el('li', {}, '只有初始化时使用的钱包能解密。电路转给别人后，对方能管理这个文件夹，但解不开已有文件。'),
      el('li', {}, '请使用普通钱包（MetaMask、OKX Wallet、硬件钱包等）。智能合约钱包、MPC 钱包的签名可能不固定，会被拒绝。')),
    isHolder() ? btn : el('p', { class: 'notice' }, '当前钱包不是这枚电路的持有人，不能初始化。'),
    msg);
}

function renderLocked() {
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  const btn = el('button', { type: 'button', class: 'btn primary' }, '签名解锁');
  btn.addEventListener('click', () => guarded(btn, msg, async () => {
    msg.textContent = '请在钱包里签名（不花 gas）…';
    s.keys = await vault.unlock(signer(), s.folder.container, BSC.chainId, s.meta);
    keyCache.set(cacheKey(), s.keys);
    await refresh();
  }));
  return el('div', { class: 'card' },
    el('h3', {}, '🔒 保险箱已上锁'),
    el('p', { class: 'muted' }, `链上共有 ${s.listing.files.length} 个加密文件。签名后在本机解开文件列表。密钥只保存在当前页面内存里，断开钱包或刷新页面后失效。`),
    btn, msg);
}

/** 执行一个需要钱包交互的动作：期间禁用按钮，拒绝签名 / 交易给出友好提示 */
async function guarded(btn, msg, fn) {
  if (s.busy) return;
  s.busy = true;
  btn.disabled = true;
  msg.dataset.kind = '';
  const seq = s.seq;
  try {
    await ensureChain(s.ctx.provider);
    await fn();
  } catch (e) {
    if (seq !== s.seq) return;
    msg.dataset.kind = 'error';
    msg.textContent = isUserRejection(e) ? '已在钱包里取消。' : errText(e);
  } finally {
    s.busy = false;
    btn.disabled = false;
  }
}
// ---------------------------------------------------------------- 上传

// 已加密、尚未全部写完的上传；中断后可以接着写，不必重新加密（同一份密文、同一个路径）
let pending = null;

function renderUpload() {
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  const input = el('input', { type: 'file', id: 'file-input', class: 'sr-only' });
  const pick = el('label', { for: 'file-input', class: 'btn primary' }, '选择文件上传');
  const zone = el('div', { class: 'drop-zone' },
    input, pick,
    el('p', { class: 'muted small' }, `或把文件拖到这里 · 单个文件最大 ${MAX_UPLOAD_LABEL} · 每 24 KB 一笔交易`));
  const confirmBox = el('div', { class: 'confirm-box', hidden: true });

  const onFile = async (file) => {
    if (!file || s.busy) return;
    msg.dataset.kind = '';
    confirmBox.hidden = true;
    if (!isHolder()) { msg.dataset.kind = 'error'; msg.textContent = '当前钱包不是这枚电路的持有人，不能上传。'; return; }
    if (file.size > MAX_UPLOAD_BYTES) { msg.dataset.kind = 'error'; msg.textContent = `文件太大（${formatSize(file.size)}），单个文件最大 ${MAX_UPLOAD_LABEL}。`; return; }
    if (!file.size) { msg.dataset.kind = 'error'; msg.textContent = '不能上传空文件。'; return; }
    try {
      msg.textContent = '正在本机加密…';
      const bytes = new Uint8Array(await file.arrayBuffer());
      const up = await vault.prepareUpload(s.keys, s.folder.container, { name: file.name, type: file.type, mtime: Math.floor(file.lastModified / 1000), bytes });
      const gas = vault.estimateGas(up.blob.length, up.txs.length);
      const price = await s.ctx.chain.gasPrice();
      const replaces = s.entries.some((e) => e.name === file.name.normalize('NFC').trim());
      msg.textContent = '';
      showConfirm(confirmBox, msg, { ...up, name: file.name, size: file.size, next: 0 }, gas * price, replaces);
    } catch (e) {
      msg.dataset.kind = 'error';
      msg.textContent = errText(e);
    }
  };
  input.addEventListener('change', () => { onFile(input.files[0]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); onFile(e.dataTransfer.files[0]); });

  const box = el('section', { class: 'upload', 'aria-label': '上传文件' }, zone, confirmBox, msg);
  if (pending && pending.container === s.folder.container) showResume(confirmBox, msg);
  return box;
}

function showConfirm(box, msg, up, costWei, replaces) {
  const go = el('button', { type: 'button', class: 'btn primary' }, '确认上传');
  const cancel = el('button', { type: 'button', class: 'btn' }, '取消');
  cancel.addEventListener('click', () => { box.hidden = true; });
  go.addEventListener('click', () => { cancel.disabled = true; runUpload(go, msg, { ...up, container: s.folder.container }); });
  box.replaceChildren(
    el('dl', { class: 'meta compact' },
      el('dt', {}, '文件'), el('dd', {}, up.name),
      el('dt', {}, '大小'), el('dd', {}, `${formatSize(up.size)}（加密后 ${formatSize(up.blob.length)}）`),
      el('dt', {}, '交易'), el('dd', {}, `${up.txs.length} 笔，需要在钱包里逐笔确认`),
      el('dt', {}, '预计费用'), el('dd', {}, `约 ${formatBnb(costWei)}（按当前 gas 价格估算）`)),
    ...(replaces ? [el('p', { class: 'muted small' }, '已有同名文件：上传后显示新版本，旧版本保留在链上。')] : []),
    el('div', { class: 'row' }, go, cancel));
  box.hidden = false;
}

function showResume(box, msg) {
  const go = el('button', { type: 'button', class: 'btn primary' }, '继续上传');
  const drop = el('button', { type: 'button', class: 'btn' }, '放弃');
  drop.addEventListener('click', () => { pending = null; box.hidden = true; });
  go.addEventListener('click', () => { drop.disabled = true; runUpload(go, msg, pending); });
  box.replaceChildren(
    el('p', {}, `「${pending.name}」上传中断：已写入 ${pending.next} / ${pending.txs.length} 笔。未写完的文件不会出现在列表里。`),
    el('div', { class: 'row' }, go, drop));
  box.hidden = false;
}

async function runUpload(btn, msg, up) {
  pending = up;
  await guarded(btn, msg, async () => {
    if (!isHolder()) throw new Error('当前钱包不是这枚电路的持有人，不能上传。');
    // 以链上实际写入的块数为准：上次最后一笔可能已经上链，只是页面没等到回执
    const block = await s.ctx.chain.pinBlock();
    const info = (await s.ctx.chain.fileInfos(up.container, [up.path], block)).get(up.path);
    if (info && info.sha256 === up.sha256) up.next = Math.min(info.chunkCount, up.txs.length);
    else if (up.next > 0) up.next = 0;
    window.addEventListener('beforeunload', warnUnload);
    try {
      for (let i = up.next; i < up.txs.length; i++) {
        msg.textContent = `请在钱包里确认第 ${i + 1} / ${up.txs.length} 笔交易…`;
        await sendAndWait(s.ctx.provider, s.ctx.account, up.txs[i]);
        up.next = i + 1;
      }
    } finally {
      window.removeEventListener('beforeunload', warnUnload);
    }
    pending = null;
    await refresh();
  });
  if (pending) {
    msg.textContent += ` 已写入 ${pending.next} / ${pending.txs.length} 笔，可以继续上传。`;
    const box = btn.closest('.upload')?.querySelector('.confirm-box');
    if (box) showResume(box, msg);
  }
}

function warnUnload(e) {
  e.preventDefault();
  e.returnValue = '';
}
// ---------------------------------------------------------------- 文件列表 / 下载

function renderFiles() {
  const parts = [];
  const notes = [];
  if (s.locked) notes.push(`${s.locked} 个文件用别的钱包加密（例如电路的上一任持有人），当前钱包解不开，未显示。`);
  if (s.broken) notes.push(`${s.broken} 个文件格式不对或已损坏，未显示。`);
  const pendingCount = s.entries.filter((e) => e.pending).length;
  if (pendingCount) notes.push(`${pendingCount} 个文件还没上传完整，暂时不能下载。`);

  if (!s.entries.length) {
    parts.push(el('p', { class: 'muted' }, '保险箱是空的，上传第一个文件吧。'));
  } else {
    const rows = s.entries.map((e) => {
      const btn = el('button', { type: 'button', class: 'btn small', disabled: e.pending, 'aria-label': `下载 ${e.name}` }, e.pending ? '上传中' : '下载');
      btn.addEventListener('click', () => download(btn, e));
      return el('tr', {},
        el('td', { class: 'name' }, e.name, e.versions.length ? el('span', { class: 'muted small' }, ` · ${e.versions.length + 1} 个版本`) : null),
        el('td', {}, formatSize(e.size)),
        el('td', {}, formatTime(e.updatedAt)),
        el('td', {}, btn));
    });
    parts.push(el('table', { class: 'files' },
      el('caption', { class: 'sr-only' }, '保险箱文件'),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, '文件名'), el('th', { scope: 'col' }, '大小'),
        el('th', { scope: 'col' }, '上链时间'), el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, '操作')))),
      el('tbody', {}, ...rows)));
  }
  for (const n of notes) parts.push(el('p', { class: 'muted small' }, n));
  const again = el('button', { type: 'button', class: 'btn link' }, '刷新列表');
  again.addEventListener('click', () => { if (!s.busy) refresh(); });
  parts.push(again);
  return el('section', { class: 'file-section', 'aria-label': '文件列表' }, ...parts);
}

async function download(btn, entry) {
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.textContent;
  try {
    await ensureChain(s.ctx.provider);
    const block = await s.ctx.chain.pinBlock();
    const bytes = await vault.downloadEntry(s.ctx.chain, s.keys, s.folder.container, entry, block, (done, total) => {
      btn.textContent = Math.floor((done / total) * 100) + '%';
    });
    saveBytes(bytes, entry.name);
    btn.textContent = label;
  } catch (e) {
    btn.textContent = '失败';
    btn.title = errText(e);
  } finally {
    btn.disabled = false;
  }
}

/** 用 blob: 地址触发浏览器下载。类型一律按二进制下载，避免浏览器直接在本页渲染 HTML/SVG */
function saveBytes(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = el('a', { href: url, download: name.split('/').pop() || 'file' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
