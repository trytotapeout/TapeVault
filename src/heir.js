// 受托人 / 守护人页面：不需要持有这枚电路，连接任意钱包只用来读链。
//   1. 输入文件夹编号，读取链上的托付记录（签名核对通过的才显示）
//   2. 守护人：到期后导入私钥，生成交给受托人的碎片
//   3. 受托人：粘贴碎片、导入私钥，在本机解开文件夹，下载全部文件
// 私钥和碎片只在当前页面内存里使用，不保存、不上传。

import { $, el, errText, formatSize, formatTime, saveBytes } from './dom.js';
import { ensureChain } from './wallet.js';
import { parseFolderInput, folderLabel } from './folders.js';
import { parsePrivateKey } from './seal.js';
import { loadLegacy, guardianRelease, heirOpen } from './legacy-store.js';
import * as vault from './vault.js';
import { t, onLang } from './i18n.js';

// ctx = {provider, chain}；view = 当前文件夹的读取结果
let ctx = null;
let view = null;
let keys = null;
let seq = 0;
// 当前打开的面板：{owner, kind: 'guardian'|'heir', share?}。切换语言重画时照原样打开，
// 已生成的碎片、已解开的文件列表不用重来（私钥不保留，所以不能要求用户重新输入）
let panel = null;

const root = () => $('heir-body');
const date = formatTime;

export function openHeir(c) {
  ctx = c;
  view = null;
  keys = null;
  panel = null;
  seq++;
  renderLookup();
}

export function closeHeir() {
  ctx = null;
  view = null;
  keys = null;
  panel = null;
  seq++;
  root()?.replaceChildren();
}

// ---------------------------------------------------------------- 1. 查找文件夹

function renderLookup(error = '', value = '') {
  view = null;
  panel = null;
  const input = el('input', { id: 'heir-folder', type: 'text', value, placeholder: t('如 4452.0'), autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'heir-folder-hint' });
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  if (error) { msg.dataset.kind = 'error'; msg.textContent = error; }
  const form = el('form', { class: 'add-form', on: { submit: async (e) => {
    e.preventDefault();
    const my = ++seq;
    msg.dataset.kind = '';
    msg.textContent = t('读取链上记录…');
    try {
      await load(input.value);
      if (my === seq) renderFolder();
    } catch (err) {
      if (my !== seq) return;
      msg.dataset.kind = 'error';
      msg.textContent = errText(err);
    }
  } } },
  el('label', { for: 'heir-folder', class: 'sr-only' }, t('文件夹编号')),
  input,
  el('button', { type: 'submit', class: 'btn primary' }, t('查看')));
  root().replaceChildren(
    el('h2', {}, t('我是受托人 / 守护人')),
    el('p', { class: 'muted' }, t('输入持有人发给你的文件夹编号。连接任意一个 BSC 钱包即可：钱包只用来读取公链上的数据，你不需要持有这枚电路，也不需要余额，这里不会签名，也不会发交易。')),
    form,
    el('p', { class: 'hint', id: 'heir-folder-hint' }, t('编号写在你收到的分发信息里，例如「文件夹：4452.0.tape」，输入 4452.0 即可。')),
    msg,
  );
  input.focus();
}

async function load(raw) {
  const parsed = parseFolderInput(raw);
  if (!parsed) throw new Error(t('格式不对，请输入 <#ID>.<处理器编号>，例如 4452.0'));
  const { chain, provider } = ctx;
  await ensureChain(provider);
  const block = await chain.pinBlock();
  const cpus = await chain.cpuList(block);
  const circuits = cpus[parsed.cpu];
  if (!circuits) throw new Error(t('处理器 {0} 不存在', [parsed.cpu]));
  const [info] = await chain.circuitInfos([{ circuits, tokenId: parsed.tokenId }], block);
  if (!info.exists) throw new Error(t('{0} 不存在', [folderLabel(parsed.tokenId, parsed.cpu)]));
  if (!info.opened) throw new Error(t('这枚电路的容器没有开通，里面不会有托付记录'));
  const listing = await chain.vaultListing(info.container, block);
  const meta = listing.initialized ? await vault.readMeta(chain, info.container, listing, block) : null;
  const [records, now] = await Promise.all([loadLegacy(chain, info.container, listing, block), chain.chainTime(block)]);
  if (!records.setups.length) throw new Error(t('这个文件夹里没有有效的托付记录'));
  view = { label: folderLabel(parsed.tokenId, parsed.cpu), container: info.container, holder: info.owner, listing, meta, records, now, block };
  keys = null;
  panel = null;
}

// ---------------------------------------------------------------- 2. 托付记录

/** 同一个文件夹可能被不同持有人先后设置过；每份托付按设置人分别计算 */
function entrustments() {
  const { records, now } = view;
  const owners = [...new Set(records.setups.map((s) => s.owner))];
  return owners.map((owner) => {
    const setup = records.setups.find((s) => s.owner === owner);
    let lastAlive = setup.at;
    for (const c of records.checkins) if (c.owner === owner && c.at > lastAlive) lastAlive = c.at;
    const releaseAt = lastAlive + setup.days * 86400;
    return { setup, lastAlive, releaseAt, released: now >= releaseAt, daysLeft: Math.max(0, Math.ceil((releaseAt - now) / 86400)) };
  });
}

function renderFolder(restore = null) {
  const list = entrustments();
  panel = null;
  const back = el('button', { type: 'button', class: 'btn link', on: { click: () => { keys = null; renderLookup(); } } }, t('← 换一个文件夹'));
  root().replaceChildren(
    back,
    el('h2', {}, view.label),
    el('dl', { class: 'meta' },
      el('dt', {}, t('容器地址')), el('dd', {}, el('code', {}, view.container)),
      el('dt', {}, t('当前持有人')), el('dd', {}, el('code', {}, view.holder)),
      el('dt', {}, t('链上时间')), el('dd', {}, date(view.now))),
    el('p', { class: 'muted small' }, t('请和你收到的分发信息逐项核对：持有人钱包、门限和各方公钥指纹都应一致。不一致时不要继续。')),
    ...list.map((st) => renderEntrustment(st, restore)),
    view.records.ignored ? el('p', { class: 'muted small' }, t('另有 {0} 条记录签名核对不通过或格式不对，已忽略。', [view.records.ignored])) : null,
  );
}

function renderEntrustment(st, restore) {
  const s = st.setup;
  const n = s.guardians.length;
  const card = el('section', { class: 'card legacy-status' + (st.released ? ' due' : ''), 'aria-label': t('托付记录') },
    el('h3', {}, st.released ? t('已到期：守护人可以放行') : t('未到期：还有 {0} 天', [st.daysLeft])),
    el('dl', { class: 'meta compact' },
      el('dt', {}, t('设置人')), el('dd', {}, el('code', {}, s.owner)),
      el('dt', {}, t('设置时间')), el('dd', {}, date(s.at)),
      el('dt', {}, t('上次报平安')), el('dd', {}, date(st.lastAlive)),
      el('dt', {}, t('到期时间')), el('dd', {}, t('{0}（{1} 天未报平安）', [date(st.releaseAt), s.days])),
      el('dt', {}, t('门限')), el('dd', {}, t('{0} / {1} 位守护人', [s.threshold, n])),
      el('dt', {}, t('受托人指纹')), el('dd', {}, el('code', {}, s.heir.fingerprint)),
      ...s.guardians.flatMap((g, i) => [el('dt', {}, t('守护人 {0}', [i + 1])), el('dd', {}, el('code', {}, g.fingerprint))])),
  );
  const guardianBox = el('div', {});
  const heirBox = el('div', {});
  const openGuardian = () => { heirBox.replaceChildren(); panel = { owner: s.owner, kind: 'guardian' }; renderGuardian(guardianBox, st); };
  const openHeirPanel = () => { guardianBox.replaceChildren(); panel = { owner: s.owner, kind: 'heir' }; renderHeir(heirBox, st); };
  card.append(
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn', on: { click: () => { keys = null; openGuardian(); } } }, t('我是守护人')),
      el('button', { type: 'button', class: 'btn', on: { click: () => { keys = null; openHeirPanel(); } } }, t('我是受托人'))),
    guardianBox, heirBox);
  // 切换语言后恢复刚才打开的面板
  if (restore && restore.owner === s.owner) {
    if (restore.kind === 'guardian') { panel = restore; renderGuardian(guardianBox, st); }
    else { panel = restore; renderHeir(heirBox, st); }
  }
  return card;
}

// ---------------------------------------------------------------- 私钥输入（粘贴或选择文件）

function keyField(id, label) {
  const area = el('textarea', { id, rows: 4, spellcheck: 'false', autocomplete: 'off', placeholder: '-----BEGIN EC PRIVATE KEY-----\n…\n-----END EC PRIVATE KEY-----' });
  const file = el('input', { type: 'file', id: id + '-file', class: 'sr-only', accept: '.pem,.key,.txt' });
  file.addEventListener('change', async () => { if (file.files[0]) area.value = await file.files[0].text(); file.value = ''; });
  return {
    area,
    node: el('div', { class: 'field' },
      el('label', { for: id }, label),
      area,
      el('span', { class: 'inline' },
        file, el('label', { for: id + '-file', class: 'btn small' }, t('选择私钥文件')),
        el('span', { class: 'hint' }, t('私钥只在本页面内存里使用，不保存、不上传。建议在干净的设备上操作，用完关掉页面。')))),
  };
}

// ---------------------------------------------------------------- 3a. 守护人

function renderGuardian(box, st) {
  const k = keyField('guardian-key', t('你的守护人私钥'));
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  const out = el('div', {});
  const go = el('button', { type: 'button', class: 'btn primary' }, t('生成交给受托人的碎片'));
  const show = (r) => {
    msg.textContent = t('你是守护人 {0}。把下面这段碎片发给受托人；碎片只有受托人的私钥能用。', [r.index]);
    const text = el('textarea', { id: 'guardian-share', class: 'dist-text', readonly: true, rows: 3, spellcheck: 'false' }, r.text);
    const copy = el('button', { type: 'button', class: 'btn small' }, t('复制'));
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(r.text); copy.textContent = t('已复制'); } catch { text.select(); copy.textContent = t('已选中，请手动复制'); }
      setTimeout(() => { copy.textContent = t('复制'); }, 2000);
    });
    out.replaceChildren(el('section', { class: 'dist-card', 'aria-labelledby': 'guardian-share-t' },
      el('div', { class: 'dist-head' }, el('strong', { id: 'guardian-share-t' }, t('碎片 {0}', [r.index])), copy),
      el('label', { for: 'guardian-share', class: 'sr-only' }, t('碎片')), text));
  };
  go.addEventListener('click', async () => {
    msg.dataset.kind = '';
    out.replaceChildren();
    try {
      const priv = await parsePrivateKey(k.area.value);
      const r = await guardianRelease(st.setup, priv);
      k.area.value = '';
      if (panel) panel.share = r;
      show(r);
    } catch (e) {
      msg.dataset.kind = 'error';
      msg.textContent = errText(e);
    }
  });
  box.replaceChildren(el('div', { class: 'heir-panel' },
    el('h3', {}, t('守护人放行')),
    st.released
      ? el('p', { class: 'muted small' }, t('已到期。放行前请先尝试联系持有人本人，确认对方确实失联。'))
      : el('p', { class: 'notice' }, t('还没到期（还有 {0} 天）。按约定，到期前请不要交出碎片。', [st.daysLeft])),
    k.node, el('div', { class: 'row' }, go), msg, out));
  if (panel?.share) show(panel.share);
}

// ---------------------------------------------------------------- 3b. 受托人

function renderHeir(box, st) {
  const s = st.setup;
  const k = keyField('heir-key', t('你的受托人私钥'));
  const sharesArea = el('textarea', { id: 'heir-shares', rows: 4, spellcheck: 'false', autocomplete: 'off', placeholder: 'tvs1:1:…\ntvs1:3:…' });
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  const files = el('div', {});
  const go = el('button', { type: 'button', class: 'btn primary' }, t('解开文件夹'));
  go.addEventListener('click', async () => {
    if (go.disabled) return;
    go.disabled = true;
    msg.dataset.kind = '';
    files.replaceChildren();
    try {
      const priv = await parsePrivateKey(k.area.value);
      const shares = sharesArea.value.split(/\s+/).filter(Boolean);
      msg.textContent = t('正在本机解密…');
      keys = await heirOpen(s, priv, shares);
      k.area.value = '';
      sharesArea.value = '';
      await renderFiles(files, msg);
    } catch (e) {
      msg.dataset.kind = 'error';
      msg.textContent = errText(e);
    } finally {
      go.disabled = false;
    }
  });
  box.replaceChildren(el('div', { class: 'heir-panel' },
    el('h3', {}, t('受托人解密')),
    el('p', { class: 'muted small' }, t('需要至少 {0} 份守护人交来的碎片（tvs1: 开头），加上你自己的私钥。每行一份。', [s.threshold])),
    el('div', { class: 'field' }, el('label', { for: 'heir-shares' }, t('守护人的碎片')), sharesArea),
    k.node, el('div', { class: 'row' }, go), msg, files));
  if (keys) renderFiles(files, msg).catch((e) => { msg.dataset.kind = 'error'; msg.textContent = errText(e); });
}

async function renderFiles(box, msg) {
  const { chain } = ctx;
  const block = await chain.pinBlock();
  const listing = await chain.vaultListing(view.container, block);
  const r = await vault.decodeListing(chain, keys, view.container, listing, block);
  msg.textContent = t('已解开。共 {0} 个文件。解密在本机完成，关闭页面后密钥即清除。', [r.entries.length]);
  if (!r.entries.length) { box.replaceChildren(el('p', { class: 'muted' }, t('这个文件夹里没有文件。'))); return; }
  const all = el('button', { type: 'button', class: 'btn' }, t('逐个下载全部'));
  const rows = r.entries.map((e) => {
    const btn = el('button', { type: 'button', class: 'btn small', disabled: e.pending, 'aria-label': t('下载 {0}', [e.name]) }, e.pending ? t('未上传完') : t('下载'));
    btn.addEventListener('click', () => download(btn, e));
    return { e, btn, tr: el('tr', {},
      el('td', { class: 'name' }, e.name, e.versions.length ? el('span', { class: 'muted small' }, t(' · {0} 个版本', [e.versions.length + 1])) : null),
      el('td', {}, formatSize(e.size)), el('td', {}, formatTime(e.updatedAt)), el('td', {}, btn)) };
  });
  all.addEventListener('click', async () => {
    all.disabled = true;
    for (const x of rows) if (!x.e.pending) await download(x.btn, x.e);
    all.disabled = false;
  });
  box.replaceChildren(
    el('table', { class: 'files' },
      el('caption', { class: 'sr-only' }, t('托付的文件')),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, t('文件名')), el('th', { scope: 'col' }, t('大小')), el('th', { scope: 'col' }, t('上链时间')), el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, t('操作'))))),
      el('tbody', {}, ...rows.map((x) => x.tr))),
    r.locked ? el('p', { class: 'muted small' }, t('{0} 个文件不是用这把密钥加密的（例如电路其他持有人上传的），解不开，未显示。', [r.locked])) : null,
    el('div', { class: 'row' }, all),
    el('p', { class: 'muted small' }, t('持有人消失后电路可能落到别人手里，链上的文件有可能被删除。建议尽快把文件全部下载保存。')),
  );
}

async function download(btn, entry) {
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.textContent;
  try {
    const block = await ctx.chain.pinBlock();
    const bytes = await vault.downloadEntry(ctx.chain, keys, view.container, entry, block, (done, total) => {
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

onLang(() => {
  if (!ctx || !root()?.childElementCount) return;
  if (!view) return renderLookup('', $('heir-folder')?.value || '');
  renderFolder(panel);
});
