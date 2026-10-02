// 文件夹详情：初始化、解锁、上传、列表、下载。
// 所有写操作都是用户钱包直接调用 SiteRegistry（持有人即编辑者），每一块一笔交易，逐笔确认。

import { $, el, errText, formatSize, formatTime, formatDate, formatBnb, saveBytes } from './dom.js';
import { BSC, VAULT_PREFIX, MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from './config.js';
import { ensureChain, signText, sendAndWait, isUserRejection } from './wallet.js';
import * as vault from './vault.js';
import { loadLegacy, legacyStatus, buildCheckin } from './legacy-store.js';
import { openLegacy, legacyBusy } from './legacy.js';
import { t, onLang } from './i18n.js';

// 当前会话。keys 只放在内存里，关闭页面即失效；换文件夹、换账户都会清掉。
const s = { ctx: null, folder: null, keys: null, listing: null, meta: null, entries: [], locked: 0, broken: 0, busy: false, seq: 0, legacy: null, now: 0 };

const lower = (a) => String(a).toLowerCase();
const body = () => $('detail-body');

// 解锁过的密钥按「账户 + 容器」缓存在内存里，同一页面内重新打开文件夹不必再签名。
// 断开钱包、切换账户（forgetKeys）或刷新页面后失效。
const keyCache = new Map();
const cacheKey = () => lower(s.ctx.account) + ':' + lower(s.folder.container);

export function forgetKeys() {
  keyCache.clear();
  pending = null;
  notes.clear();
}

// 手写文字的草稿：按容器放在内存里（不写 localStorage，明文不落盘），上传成功或断开钱包时清掉。
// 有没上传的草稿时关闭 / 刷新页面先提醒
const notes = new Map();
window.addEventListener('beforeunload', (e) => {
  for (const n of notes.values()) if (n.text.trim()) return warnUnload(e);
});

/** ctx = {provider, account, chain}；由 app.js 在打开文件夹时传入 */
export async function openFolder(ctx, f) {
  s.seq++;
  Object.assign(s, { ctx, folder: f, keys: null, listing: null, meta: null, entries: [], locked: 0, broken: 0, busy: false, legacy: null, now: 0 });
  $('legacy-btn').hidden = true;
  s.keys = keyCache.get(cacheKey()) || null;
  $('detail-title').textContent = f.label;
  renderMeta();
  if (!f.opened) {
    renderUnopened();
    return;
  }
  await refresh();
}

function renderMeta() {
  const f = s.folder;
  $('detail-meta').replaceChildren(
    ...metaRow(t('处理器'), t('{0}（编号 {1}）', [f.cpuName || '—', f.cpu])),
    ...metaRow(t('电路合约'), f.circuits),
    ...metaRow(t('容器地址'), f.container),
    ...metaRow(t('容器状态'), f.opened ? t('已开通') : t('未开通')),
  );
}

function renderUnopened() {
  body().replaceChildren(el('p', { class: 'notice' }, t('这枚电路的容器还没开通，暂时不能存放文件。请先在 TapeOut 官网为它开通容器，之后刷新这里即可使用。')));
}

// 切换语言：重画当前文件夹。钱包操作进行中不重画，避免丢掉进度提示；下一次刷新时自然换成新语言
onLang(() => {
  if (!s.folder || s.busy) return;
  renderMeta();
  if (!s.folder.opened) renderUnopened();
  else if (s.listing) render();
});

export function closeFolder() {
  s.seq++;
  Object.assign(s, { ctx: null, folder: null, keys: null, listing: null, meta: null, entries: [], legacy: null });
}

function metaRow(k, v) {
  return [el('dt', {}, k), el('dd', {}, el('code', {}, v || '—'))];
}

/** 重新读链。已解锁时顺带解开文件列表 */
async function refresh() {
  const seq = s.seq;
  const { chain, provider } = s.ctx;
  const c = s.folder.container;
  body().replaceChildren(el('p', { class: 'muted' }, t('读取文件夹…')));
  try {
    await ensureChain(provider);
    const block = await chain.pinBlock();
    const listing = await chain.vaultListing(c, block);
    const meta = listing.initialized ? await vault.readMeta(chain, c, listing, block) : null;
    const [records, now] = meta ? await Promise.all([loadLegacy(chain, c, listing, block), chain.chainTime(block)]) : [null, 0];
    if (seq !== s.seq) return;
    s.listing = listing;
    s.meta = meta;
    s.now = now;
    s.legacy = records ? legacyStatus(records, s.ctx.account, now, meta.keyCheck) : null;
    if (s.keys && meta) {
      const r = await vault.decodeListing(chain, s.keys, c, listing, block);
      if (seq !== s.seq) return;
      Object.assign(s, r);
    }
    render();
  } catch (e) {
    if (seq === s.seq) body().replaceChildren(el('p', { class: 'notice error' }, t('读取失败：') + errText(e)));
  }
}

function render() {
  const parts = [];
  if (s.listing.otherFileCount) {
    parts.push(el('p', { class: 'muted small' }, t('容器里另有 {0} 个非 TapeVault 文件（例如 DeWEB 网站），TapeVault 不会读取或改动它们。', [s.listing.otherFileCount])));
  }
  // 标题旁的「设为托付保险箱」：已初始化、当前钱包是持有人、还没设置过时才显示
  $('legacy-btn').hidden = !(s.meta && isHolder() && !s.legacy);
  if (s.legacy) parts.push(renderLegacyStatus());
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
  const btn = el('button', { type: 'button', class: 'btn primary' }, t('初始化保险箱'));
  btn.addEventListener('click', () => guarded(btn, msg, async () => {
    msg.textContent = t('请在钱包里签名（共 2 次，用来生成并核对加密密钥，不花 gas）…');
    const keys = await vault.unlock(signer(), s.folder.container, BSC.chainId, null);
    msg.textContent = t('请在钱包里确认交易：写入 _tapevault/_meta.json（约 0.0001 BNB）…');
    for (const tx of await vault.metaWriteTxs(s.folder.container, keys.keyCheck)) await sendAndWait(s.ctx.provider, s.ctx.account, tx);
    s.keys = keys;
    keyCache.set(cacheKey(), keys);
    await refresh();
  }));
  return el('div', { class: 'card' },
    el('h3', {}, t('这个文件夹还没有启用 TapeVault')),
    el('ul', { class: 'plain' },
      el('li', {}, t('文件在你的浏览器里加密后才上链，链上只有密文；文件名、类型、大小也都在密文里。')),
      el('li', {}, t('加密密钥由你的钱包签名生成，不保存在任何地方。换设备时连同一个钱包、再签一次即可恢复。')),
      el('li', {}, t('只有初始化时使用的钱包能解密。电路转给别人后，对方能管理这个文件夹，但解不开已有文件。')),
      el('li', {}, t('请使用普通钱包（MetaMask、OKX Wallet、硬件钱包等）。智能合约钱包、MPC 钱包的签名可能不固定，会被拒绝。'))),
    isHolder() ? btn : el('p', { class: 'notice' }, t('当前钱包不是这枚电路的持有人，不能初始化。')),
    msg);
}

function renderLocked() {
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  const btn = el('button', { type: 'button', class: 'btn primary' }, t('签名解锁'));
  const resetBox = el('div');
  btn.addEventListener('click', () => guarded(btn, msg, async () => {
    msg.textContent = t('请在钱包里签名（不花 gas）…');
    try {
      s.keys = await vault.unlock(signer(), s.folder.container, BSC.chainId, s.meta);
    } catch (e) {
      // 密钥对不上：当前持有人可以重置文件夹（例如电路是转手来的）；不是持有人就只提示
      if (e.code === 'key-mismatch' && isHolder()) resetBox.replaceChildren(renderReset());
      throw e;
    }
    keyCache.set(cacheKey(), s.keys);
    await refresh();
  }));
  return el('div', { class: 'card' },
    el('h3', {}, t('🔒 保险箱已上锁')),
    el('p', { class: 'muted' }, t('链上共有 {0} 个加密文件。签名后在本机解开文件列表。密钥只保存在当前页面内存里，断开钱包或刷新页面后失效。', [s.listing.files.length])),
    btn, msg, resetBox);
}

/**
 * 重置文件夹：用当前钱包重新生成密钥，覆盖 _meta.json。
 * 链上已有的密文删不掉也用不上（旧密钥不在了），列表里算作「用别的钱包加密」不显示；旧托付随之失效。
 */
function renderReset() {
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  const ack = el('input', { type: 'checkbox', id: 'reset-ack' });
  const btn = el('button', { type: 'button', class: 'btn danger', disabled: true }, t('重置文件夹'));
  ack.addEventListener('change', () => { btn.disabled = !ack.checked; });
  btn.addEventListener('click', () => guarded(btn, msg, async () => {
    if (!isHolder()) throw new Error(t('当前钱包不是这枚电路的持有人，不能重置。'));
    msg.textContent = t('请在钱包里签名（共 2 次，用来生成并核对新的加密密钥，不花 gas）…');
    const keys = await vault.unlock(signer(), s.folder.container, BSC.chainId, null);
    msg.textContent = t('请在钱包里确认交易：覆盖 _tapevault/_meta.json（约 0.0001 BNB）…');
    for (const tx of await vault.metaWriteTxs(s.folder.container, keys.keyCheck)) await sendAndWait(s.ctx.provider, s.ctx.account, tx);
    s.keys = keys;
    keyCache.set(cacheKey(), keys);
    await refresh();
  }));
  return el('div', { class: 'notice reset-box' },
    el('h4', {}, t('重置这个文件夹')),
    el('p', {}, t('如果这个文件夹是你从别人手里接过来的，或者是用旧版本 TapeVault 初始化的，可以用当前钱包重置，重新开始使用。')),
    el('ul', { class: 'plain' },
      el('li', {}, t('链上现有的 {0} 个加密文件会永久无法解密（链上删不掉，也不会再显示）。', [s.listing.files.filter((f) => f.path.startsWith(vault.FILE_DIR)).length])),
      el('li', {}, t('这个文件夹以前设置的托付全部失效，需要时重新设置。')),
      el('li', {}, t('重置后只有当前钱包能解密新上传的文件。'))),
    el('label', { class: 'ack' }, ack, el('span', {}, t('我了解：旧文件无法再解开，这个操作不能撤销。'))),
    btn, msg);
}

// ---------------------------------------------------------------- 托付

/** 打开设置窗口（由 app.js 的标题按钮调用） */
export function openLegacyDialog() {
  if (!s.folder || !s.meta || !isHolder() || s.legacy) return;
  openLegacy({ provider: s.ctx.provider, account: s.ctx.account, chain: s.ctx.chain, folder: s.folder, meta: s.meta, onDone: () => refresh() });
}

export { legacyBusy };

function renderLegacyStatus() {
  const st = s.legacy;
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  const btn = el('button', { type: 'button', class: 'btn primary' }, t('我还在（报平安）'));
  btn.addEventListener('click', () => guarded(btn, msg, async () => {
    if (!isHolder()) throw new Error(t('当前钱包不是这枚电路的持有人，不能报平安。'));
    msg.textContent = t('请在钱包里签名（不花 gas）…');
    const rec = await buildCheckin({
      container: s.folder.container, chainId: BSC.chainId, owner: s.ctx.account, now: await s.ctx.chain.chainTime(),
      sign: (text) => signText(s.ctx.provider, s.ctx.account, text),
    });
    for (const tx of rec.txs) {
      msg.textContent = t('请在钱包里确认交易（约 0.0001 BNB）…');
      await sendAndWait(s.ctx.provider, s.ctx.account, tx);
    }
    await refresh();
  }));
  const g = st.setup.guardians.length;
  return el('section', { class: 'card legacy-status' + (st.released ? ' due' : ''), 'aria-label': t('托付状态') },
    el('h3', {}, st.released ? t('⚠️ 托付：已到期') : t('🛡 托付已设置')),
    el('p', {}, st.released
      ? t('已超过 {0} 天没有报平安，守护人现在可以放行。如果你还在，请立即报平安。', [st.setup.days])
      : t('距离放行还有 {0} 天。上次报平安：{1}，到期日：{2}。', [st.daysLeft, formatDate(st.lastAlive), formatDate(st.releaseAt)])),
    el('p', { class: 'muted small' }, t('放行条件：{0} 天未报平安 · 门限 {1} / {2} 位守护人 · 受托人指纹 ', [st.setup.days, st.setup.threshold, g]), el('code', {}, st.setup.heir.fingerprint)),
    isHolder() ? btn : null,
    msg);
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
    msg.textContent = isUserRejection(e) ? t('已在钱包里取消。') : errText(e);
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
  const pick = el('label', { for: 'file-input', class: 'btn primary' }, t('选择文件上传'));
  const zone = el('div', { class: 'drop-zone' },
    input, pick,
    el('p', { class: 'muted small' }, t('或把文件拖到这里 · 单个文件最大 {0} · 每 24 KB 一笔交易', [MAX_UPLOAD_LABEL])));
  const confirmBox = el('div', { class: 'confirm-box', hidden: true });
  const fail = (text) => { msg.dataset.kind = 'error'; msg.textContent = text; };

  /** 文件和手写文字共用：检查 → 本机加密 → 显示确认框。item = {name, type, mtime, size, read(), note} */
  const prepare = async (item) => {
    if (s.busy) return;
    msg.dataset.kind = '';
    confirmBox.hidden = true;
    if (!isHolder()) return fail(t('当前钱包不是这枚电路的持有人，不能上传。'));
    if (item.size > MAX_UPLOAD_BYTES) return fail(t('文件太大（{0}），单个文件最大 {1}。', [formatSize(item.size), MAX_UPLOAD_LABEL]));
    if (!item.size) return fail(item.note ? t('请先写点内容。') : t('不能上传空文件。'));
    try {
      msg.textContent = t('正在本机加密…');
      const up = await vault.prepareUpload(s.keys, s.folder.container, { name: item.name, type: item.type, mtime: item.mtime, bytes: await item.read() });
      const gas = vault.estimateGas(up.blob.length, up.txs.length);
      const price = await s.ctx.chain.gasPrice();
      const name = vault.normalizeName(item.name);
      const replaces = s.entries.some((e) => e.name === name);
      msg.textContent = '';
      showConfirm(confirmBox, msg, { ...up, name, size: item.size, note: !!item.note, next: 0 }, gas * price, replaces);
    } catch (e) {
      fail(errText(e));
    }
  };
  const onFile = (file) => file && prepare({
    name: file.name, type: file.type, mtime: Math.floor(file.lastModified / 1000), size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer()),
  });
  input.addEventListener('change', () => { onFile(input.files[0]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); onFile(e.dataTransfer.files[0]); });

  const box = el('section', { class: 'upload', 'aria-label': t('上传文件') }, zone, renderNote(prepare, fail), confirmBox, msg);
  if (pending && pending.container === s.folder.container) showResume(confirmBox, msg);
  return box;
}

/** 手写文字：本机转成 UTF-8 后和普通文件一样加密上传，存成 .txt 或 .md */
function renderNote(prepare, fail) {
  const c = s.folder.container;
  const draft = notes.get(c) || { text: '', name: '', ext: 'txt', open: false };
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fallback = t('笔记') + '-' + today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate());
  const enc = new TextEncoder();
  // 关掉拼写检查和自动填充：Chrome 增强拼写检查会把输入内容发给 Google，CSP 拦不住浏览器自己的请求
  const off = { spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off' };
  const area = el('textarea', { id: 'note-text', rows: 8, ...off });
  const name = el('input', { id: 'note-name', type: 'text', placeholder: fallback, ...off });
  const ext = el('select', { id: 'note-ext', 'aria-label': t('格式') },
    el('option', { value: 'txt' }, '.txt'), el('option', { value: 'md' }, '.md'));
  const size = el('span', { class: 'hint', 'aria-live': 'polite' });
  const go = el('button', { type: 'button', class: 'btn primary' }, t('加密上传'));
  area.value = draft.text;
  name.value = draft.name;
  ext.value = draft.ext;

  const save = () => {
    Object.assign(draft, { text: area.value, name: name.value, ext: ext.value });
    if (draft.text || draft.name) notes.set(c, draft);
    else notes.delete(c);
    size.textContent = draft.text ? t('{0} / 最大 {1}', [formatSize(enc.encode(draft.text).length), MAX_UPLOAD_LABEL]) : '';
  };
  area.addEventListener('input', save);
  name.addEventListener('input', save);
  ext.addEventListener('change', save);
  save();

  go.addEventListener('click', () => {
    let file;
    try { file = vault.noteFileName(name.value, ext.value, fallback); } catch (e) { return fail(errText(e)); }
    // 只有空白也算没写内容
    const bytes = area.value.trim() ? enc.encode(area.value) : new Uint8Array(0);
    prepare({ name: file, type: vault.NOTE_TYPES[ext.value], mtime: Math.floor(Date.now() / 1000), size: bytes.length, read: () => bytes, note: true });
  });

  const box = el('details', { class: 'note-panel' },
    el('summary', {}, t('或者直接写一段文字，存成文件')),
    el('div', { class: 'field' }, el('label', { for: 'note-text' }, t('内容')), area),
    el('div', { class: 'note-row' },
      el('div', { class: 'field' }, el('label', { for: 'note-name' }, t('文件名')), name),
      el('div', { class: 'field' }, el('label', { for: 'note-ext' }, t('格式')), ext)),
    el('p', { class: 'hint' }, t('内容只在本机加密后上链。草稿只留在当前页面内存里，刷新或关闭页面会丢失。'), ' ', size),
    el('div', { class: 'row' }, go));
  box.open = draft.open || !!draft.text;
  box.addEventListener('toggle', () => { draft.open = box.open; if (box.open) notes.set(c, draft); });
  return box;
}

function showConfirm(box, msg, up, costWei, replaces) {
  const go = el('button', { type: 'button', class: 'btn primary' }, t('确认上传'));
  const cancel = el('button', { type: 'button', class: 'btn' }, t('取消'));
  cancel.addEventListener('click', () => { box.hidden = true; });
  go.addEventListener('click', () => { cancel.disabled = true; runUpload(go, msg, { ...up, container: s.folder.container }); });
  box.replaceChildren(
    el('dl', { class: 'meta compact' },
      el('dt', {}, t('文件')), el('dd', {}, up.name),
      el('dt', {}, t('大小')), el('dd', {}, t('{0}（加密后 {1}）', [formatSize(up.size), formatSize(up.blob.length)])),
      el('dt', {}, t('交易')), el('dd', {}, t('{0} 笔，需要在钱包里逐笔确认', [up.txs.length])),
      el('dt', {}, t('预计费用')), el('dd', {}, t('约 {0}（按当前 gas 价格估算）', [formatBnb(costWei)]))),
    ...(replaces ? [el('p', { class: 'muted small' }, t('已有同名文件：上传后显示新版本，旧版本保留在链上。'))] : []),
    el('div', { class: 'row' }, go, cancel));
  box.hidden = false;
}

function showResume(box, msg) {
  const go = el('button', { type: 'button', class: 'btn primary' }, t('继续上传'));
  const drop = el('button', { type: 'button', class: 'btn' }, t('放弃'));
  drop.addEventListener('click', () => { pending = null; box.hidden = true; });
  go.addEventListener('click', () => { drop.disabled = true; runUpload(go, msg, pending); });
  box.replaceChildren(
    el('p', {}, t('「{0}」上传中断：已写入 {1} / {2} 笔。未写完的文件不会出现在列表里。', [pending.name, pending.next, pending.txs.length])),
    el('div', { class: 'row' }, go, drop));
  box.hidden = false;
}

async function runUpload(btn, msg, up) {
  pending = up;
  await guarded(btn, msg, async () => {
    if (!isHolder()) throw new Error(t('当前钱包不是这枚电路的持有人，不能上传。'));
    // 以链上实际写入的块数为准：上次最后一笔可能已经上链，只是页面没等到回执
    const block = await s.ctx.chain.pinBlock();
    const info = (await s.ctx.chain.fileInfos(up.container, [up.path], block)).get(up.path);
    if (info && info.sha256 === up.sha256) up.next = Math.min(info.chunkCount, up.txs.length);
    else if (up.next > 0) up.next = 0;
    window.addEventListener('beforeunload', warnUnload);
    try {
      for (let i = up.next; i < up.txs.length; i++) {
        msg.textContent = t('请在钱包里确认第 {0} / {1} 笔交易…', [i + 1, up.txs.length]);
        await sendAndWait(s.ctx.provider, s.ctx.account, up.txs[i]);
        up.next = i + 1;
      }
    } finally {
      window.removeEventListener('beforeunload', warnUnload);
    }
    pending = null;
    if (up.note) notes.delete(up.container);
    await refresh();
  });
  if (pending) {
    msg.textContent += t(' 已写入 {0} / {1} 笔，可以继续上传。', [pending.next, pending.txs.length]);
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
  if (s.locked) notes.push(t('{0} 个文件用别的钱包加密（例如电路的上一任持有人），当前钱包解不开，未显示。', [s.locked]));
  if (s.broken) notes.push(t('{0} 个文件格式不对或已损坏，未显示。', [s.broken]));
  const pendingCount = s.entries.filter((e) => e.pending).length;
  if (pendingCount) notes.push(t('{0} 个文件还没上传完整，暂时不能下载。', [pendingCount]));

  if (!s.entries.length) {
    parts.push(el('p', { class: 'muted' }, t('保险箱是空的，上传第一个文件吧。')));
  } else {
    const rows = s.entries.map((e) => {
      const btn = el('button', { type: 'button', class: 'btn small', disabled: e.pending, 'aria-label': t('下载 {0}', [e.name]) }, e.pending ? t('上传中') : t('下载'));
      btn.addEventListener('click', () => download(btn, e));
      return el('tr', {},
        el('td', { class: 'name' }, e.name, e.versions.length ? el('span', { class: 'muted small' }, t(' · {0} 个版本', [e.versions.length + 1])) : null),
        el('td', {}, formatSize(e.size)),
        el('td', {}, formatTime(e.updatedAt)),
        el('td', {}, btn));
    });
    parts.push(el('table', { class: 'files' },
      el('caption', { class: 'sr-only' }, t('保险箱文件')),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col' }, t('文件名')), el('th', { scope: 'col' }, t('大小')),
        el('th', { scope: 'col' }, t('上链时间')), el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, t('操作'))))),
      el('tbody', {}, ...rows)));
  }
  for (const n of notes) parts.push(el('p', { class: 'muted small' }, n));
  const again = el('button', { type: 'button', class: 'btn link' }, t('刷新列表'));
  again.addEventListener('click', () => { if (!s.busy) refresh(); });
  parts.push(again);
  return el('section', { class: 'file-section', 'aria-label': t('文件列表') }, ...parts);
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
    btn.textContent = t('失败');
    btn.title = errText(e);
  } finally {
    btn.disabled = false;
  }
}
