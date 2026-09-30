// 继承人 / 守护人页面：不需要持有这枚电路，连接任意钱包只用来读链。
//   1. 输入文件夹编号，读取链上的托付记录（签名核对通过的才显示）
//   2. 守护人：到期后导入私钥，生成交给继承人的碎片
//   3. 继承人：粘贴碎片、导入私钥，在本机解开文件夹，下载全部文件
// 私钥和碎片只在当前页面内存里使用，不保存、不上传。

import { $, el, errText, formatSize, formatTime, saveBytes } from './dom.js';
import { ensureChain } from './wallet.js';
import { parseFolderInput, folderLabel } from './folders.js';
import { parsePrivateKey } from './seal.js';
import { loadLegacy, guardianRelease, heirOpen } from './legacy-store.js';
import * as vault from './vault.js';

// ctx = {provider, chain}；view = 当前文件夹的读取结果
let ctx = null;
let view = null;
let keys = null;
let seq = 0;

const root = () => $('heir-body');
const date = (t) => new Date(t * 1000).toLocaleString('zh-CN', { hour12: false });

export function openHeir(c) {
  ctx = c;
  view = null;
  keys = null;
  seq++;
  renderLookup();
}

export function closeHeir() {
  ctx = null;
  view = null;
  keys = null;
  seq++;
  root()?.replaceChildren();
}

// ---------------------------------------------------------------- 1. 查找文件夹

function renderLookup(error = '') {
  const input = el('input', { id: 'heir-folder', type: 'text', placeholder: '如 4452.0', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'heir-folder-hint' });
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  if (error) { msg.dataset.kind = 'error'; msg.textContent = error; }
  const form = el('form', { class: 'add-form', on: { submit: async (e) => {
    e.preventDefault();
    const my = ++seq;
    msg.dataset.kind = '';
    msg.textContent = '读取链上记录…';
    try {
      await load(input.value);
      if (my === seq) renderFolder();
    } catch (err) {
      if (my !== seq) return;
      msg.dataset.kind = 'error';
      msg.textContent = errText(err);
    }
  } } },
  el('label', { for: 'heir-folder', class: 'sr-only' }, '文件夹编号'),
  input,
  el('button', { type: 'submit', class: 'btn primary' }, '查看'));
  root().replaceChildren(
    el('h2', {}, '我是继承人 / 守护人'),
    el('p', { class: 'muted' }, '输入持有人发给你的文件夹编号。连接任意一个 BSC 钱包即可：钱包只用来读取公链上的数据，你不需要持有这枚电路，也不需要余额，这里不会签名，也不会发交易。'),
    form,
    el('p', { class: 'hint', id: 'heir-folder-hint' }, '编号写在你收到的分发信息里，例如「文件夹：4452.0.tape」，输入 4452.0 即可。'),
    msg,
  );
  input.focus();
}

async function load(raw) {
  const parsed = parseFolderInput(raw);
  if (!parsed) throw new Error('格式不对，请输入 <#ID>.<处理器编号>，例如 4452.0');
  const { chain, provider } = ctx;
  await ensureChain(provider);
  const block = await chain.pinBlock();
  const cpus = await chain.cpuList(block);
  const circuits = cpus[parsed.cpu];
  if (!circuits) throw new Error(`处理器 ${parsed.cpu} 不存在`);
  const [info] = await chain.circuitInfos([{ circuits, tokenId: parsed.tokenId }], block);
  if (!info.exists) throw new Error(`${folderLabel(parsed.tokenId, parsed.cpu)} 不存在`);
  if (!info.opened) throw new Error('这枚电路的容器没有开通，里面不会有托付记录');
  const listing = await chain.vaultListing(info.container, block);
  const meta = listing.initialized ? await vault.readMeta(chain, info.container, listing, block) : null;
  const [records, now] = await Promise.all([loadLegacy(chain, info.container, listing, block), chain.chainTime(block)]);
  if (!records.setups.length) throw new Error('这个文件夹里没有有效的遗产托付记录');
  view = { label: folderLabel(parsed.tokenId, parsed.cpu), container: info.container, holder: info.owner, listing, meta, records, now, block };
  keys = null;
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

function renderFolder() {
  const list = entrustments();
  const back = el('button', { type: 'button', class: 'btn link', on: { click: () => { keys = null; renderLookup(); } } }, '← 换一个文件夹');
  root().replaceChildren(
    back,
    el('h2', {}, view.label),
    el('dl', { class: 'meta' },
      el('dt', {}, '容器地址'), el('dd', {}, el('code', {}, view.container)),
      el('dt', {}, '当前持有人'), el('dd', {}, el('code', {}, view.holder)),
      el('dt', {}, '链上时间'), el('dd', {}, date(view.now))),
    el('p', { class: 'muted small' }, '请和你收到的分发信息逐项核对：持有人钱包、门限和各方公钥指纹都应一致。不一致时不要继续。'),
    ...list.map((st) => renderEntrustment(st)),
    view.records.ignored ? el('p', { class: 'muted small' }, `另有 ${view.records.ignored} 条记录签名核对不通过或格式不对，已忽略。`) : null,
  );
}

function renderEntrustment(st) {
  const s = st.setup;
  const n = s.guardians.length;
  const card = el('section', { class: 'card legacy-status' + (st.released ? ' due' : ''), 'aria-label': '托付记录' },
    el('h3', {}, st.released ? '已到期：守护人可以放行' : `未到期：还有 ${st.daysLeft} 天`),
    el('dl', { class: 'meta compact' },
      el('dt', {}, '设置人'), el('dd', {}, el('code', {}, s.owner)),
      el('dt', {}, '设置时间'), el('dd', {}, date(s.at)),
      el('dt', {}, '上次报平安'), el('dd', {}, date(st.lastAlive)),
      el('dt', {}, '到期时间'), el('dd', {}, `${date(st.releaseAt)}（${s.days} 天未报平安）`),
      el('dt', {}, '门限'), el('dd', {}, `${s.threshold} / ${n} 位守护人`),
      el('dt', {}, '继承人指纹'), el('dd', {}, el('code', {}, s.heir.fingerprint)),
      ...s.guardians.flatMap((g, i) => [el('dt', {}, `守护人 ${i + 1}`), el('dd', {}, el('code', {}, g.fingerprint))])),
  );
  const guardianBox = el('div', {});
  const heirBox = el('div', {});
  card.append(
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'btn', on: { click: () => { heirBox.replaceChildren(); renderGuardian(guardianBox, st); } } }, '我是守护人'),
      el('button', { type: 'button', class: 'btn', on: { click: () => { guardianBox.replaceChildren(); renderHeir(heirBox, st); } } }, '我是继承人')),
    guardianBox, heirBox);
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
        file, el('label', { for: id + '-file', class: 'btn small' }, '选择私钥文件'),
        el('span', { class: 'hint' }, '私钥只在本页面内存里使用，不保存、不上传。建议在干净的设备上操作，用完关掉页面。'))),
  };
}

// ---------------------------------------------------------------- 3a. 守护人

function renderGuardian(box, st) {
  const k = keyField('guardian-key', '你的守护人私钥');
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  const out = el('div', {});
  const go = el('button', { type: 'button', class: 'btn primary' }, '生成交给继承人的碎片');
  go.addEventListener('click', async () => {
    msg.dataset.kind = '';
    out.replaceChildren();
    try {
      const priv = await parsePrivateKey(k.area.value);
      const r = await guardianRelease(st.setup, priv);
      k.area.value = '';
      msg.textContent = `你是守护人 ${r.index}。把下面这段碎片发给继承人；碎片只有继承人的私钥能用。`;
      const text = el('textarea', { id: 'guardian-share', class: 'dist-text', readonly: true, rows: 3, spellcheck: 'false' }, r.text);
      const copy = el('button', { type: 'button', class: 'btn small' }, '复制');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(r.text); copy.textContent = '已复制'; } catch { text.select(); copy.textContent = '已选中，请手动复制'; }
        setTimeout(() => { copy.textContent = '复制'; }, 2000);
      });
      out.replaceChildren(el('section', { class: 'dist-card', 'aria-labelledby': 'guardian-share-t' },
        el('div', { class: 'dist-head' }, el('strong', { id: 'guardian-share-t' }, `碎片 ${r.index}`), copy),
        el('label', { for: 'guardian-share', class: 'sr-only' }, '碎片'), text));
    } catch (e) {
      msg.dataset.kind = 'error';
      msg.textContent = errText(e);
    }
  });
  box.replaceChildren(el('div', { class: 'heir-panel' },
    el('h3', {}, '守护人放行'),
    st.released
      ? el('p', { class: 'muted small' }, '已到期。放行前请先尝试联系持有人本人，确认他确实失联。')
      : el('p', { class: 'notice' }, `还没到期（还有 ${st.daysLeft} 天）。按约定，到期前请不要交出碎片。`),
    k.node, el('div', { class: 'row' }, go), msg, out));
}

// ---------------------------------------------------------------- 3b. 继承人

function renderHeir(box, st) {
  const s = st.setup;
  const k = keyField('heir-key', '你的继承人私钥');
  const sharesArea = el('textarea', { id: 'heir-shares', rows: 4, spellcheck: 'false', autocomplete: 'off', placeholder: 'tvs1:1:…\ntvs1:3:…' });
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  const files = el('div', {});
  const go = el('button', { type: 'button', class: 'btn primary' }, '解开文件夹');
  go.addEventListener('click', async () => {
    if (go.disabled) return;
    go.disabled = true;
    msg.dataset.kind = '';
    files.replaceChildren();
    try {
      const priv = await parsePrivateKey(k.area.value);
      const shares = sharesArea.value.split(/\s+/).filter(Boolean);
      msg.textContent = '正在本机解密…';
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
    el('h3', {}, '继承人解密'),
    el('p', { class: 'muted small' }, `需要至少 ${s.threshold} 份守护人交来的碎片（tvs1: 开头），加上你自己的私钥。每行一份。`),
    el('div', { class: 'field' }, el('label', { for: 'heir-shares' }, '守护人的碎片'), sharesArea),
    k.node, el('div', { class: 'row' }, go), msg, files));
}

async function renderFiles(box, msg) {
  const { chain } = ctx;
  const block = await chain.pinBlock();
  const listing = await chain.vaultListing(view.container, block);
  const r = await vault.decodeListing(chain, keys, view.container, listing, block);
  msg.textContent = `已解开。共 ${r.entries.length} 个文件。解密在本机完成，关闭页面后密钥即清除。`;
  if (!r.entries.length) { box.replaceChildren(el('p', { class: 'muted' }, '这个文件夹里没有文件。')); return; }
  const all = el('button', { type: 'button', class: 'btn' }, '逐个下载全部');
  const rows = r.entries.map((e) => {
    const btn = el('button', { type: 'button', class: 'btn small', disabled: e.pending, 'aria-label': `下载 ${e.name}` }, e.pending ? '未上传完' : '下载');
    btn.addEventListener('click', () => download(btn, e));
    return { e, btn, tr: el('tr', {},
      el('td', { class: 'name' }, e.name, e.versions.length ? el('span', { class: 'muted small' }, ` · ${e.versions.length + 1} 个版本`) : null),
      el('td', {}, formatSize(e.size)), el('td', {}, formatTime(e.updatedAt)), el('td', {}, btn)) };
  });
  all.addEventListener('click', async () => {
    all.disabled = true;
    for (const x of rows) if (!x.e.pending) await download(x.btn, x.e);
    all.disabled = false;
  });
  box.replaceChildren(
    el('table', { class: 'files' },
      el('caption', { class: 'sr-only' }, '继承的文件'),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, '文件名'), el('th', { scope: 'col' }, '大小'), el('th', { scope: 'col' }, '上链时间'), el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, '操作')))),
      el('tbody', {}, ...rows.map((x) => x.tr))),
    r.locked ? el('p', { class: 'muted small' }, `${r.locked} 个文件不是用这把密钥加密的（例如电路其他持有人上传的），解不开，未显示。`) : null,
    el('div', { class: 'row' }, all),
    el('p', { class: 'muted small' }, '持有人消失后电路可能落到别人手里，链上的文件有可能被删除。建议尽快把文件全部下载保存。'),
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
    btn.textContent = '失败';
    btn.title = errText(e);
  } finally {
    btn.disabled = false;
  }
}
