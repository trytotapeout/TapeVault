// 遗产保险箱设置表单：填写 → 核对 → 签名加密并写入链上 → 显示分发信息。
// 方案：主密钥先用继承人公钥加密（内层），再用随机外锁密钥加密（外层）；
// 外锁密钥用 Shamir 拆成 n 份，分别用守护人公钥加密。继承人凑齐 m 份碎片才能解开。
// 记录格式与加密细节见 legacy-store.js。

import { $, el, errText, formatBnb } from './dom.js';
import { BSC } from './config.js';
import { ensureChain, signText, sendAndWait, isUserRejection } from './wallet.js';
import { keyMessage, deriveSecret, keysFromSecret } from './crypto.js';
import { estimateGas } from './vault.js';
import { parsePublicKey } from './seal.js';
import { buildSetup, MIN_DAYS, MAX_GUARDIANS } from './legacy-store.js';

export { parsePublicKey };

// ctx = {provider, account, chain, folder, meta, onDone}
let ctx = null;
let draft = null;   // 表单内容，「返回修改」时恢复
let busy = false;

const emptyPerson = () => ({ name: '', key: '' });
const body = () => $('legacy-body');

export function openLegacy(c) {
  ctx = c;
  busy = false;
  draft = {
    checkinDays: 180, threshold: 2,
    heir: emptyPerson(),
    guardians: [emptyPerson(), emptyPerson(), emptyPerson()],
    ack: false,
  };
  renderForm();
  $('legacy-dialog').showModal();
}

/** 写链期间不让关窗口，避免签名或交易进行到一半 */
export function legacyBusy() { return busy; }

// ---------------------------------------------------------------- 表单

function renderForm(errors = []) {
  const d = draft;
  const n = d.guardians.length;
  if (d.threshold > n) d.threshold = n;
  const errBox = errors.length
    ? el('div', { class: 'notice error', role: 'alert', tabindex: '-1', id: 'legacy-errors' },
      el('p', {}, '请先修正：'), el('ul', { class: 'plain' }, ...errors.map((e) => el('li', {}, e))))
    : null;

  const form = el('form', { class: 'legacy-form', novalidate: true, on: { submit: onSubmit } },
    errBox,
    el('p', { class: 'muted small' }, `文件夹 ${ctx.folder.label}。称呼只用于生成分发信息，不会写入链上。`),

    el('fieldset', {},
      el('legend', {}, '1. 触发条件'),
      numberField('lg-checkin', '多少天没有报平安后放行（天）', d.checkinDays, '从最后一次报平安算起，超过这么多天，守护人即可放行'),
    ),

    el('fieldset', {},
      el('legend', {}, '2. 继承人'),
      el('p', { class: 'muted small' }, '只靠继承人的私钥无法解密。继承人还需要拿到足够数量守护人交出的钥匙碎片，两者合在一起才能解开文件。'),
      personFields('lg-heir', d.heir, '继承人'),
    ),

    el('fieldset', {},
      el('legend', {}, '3. 守护人'),
      el('p', { class: 'muted small' }, '守护人确认你长期未报平安后，各自交出一份钥匙碎片。他们看不到文件内容，只负责放行。'),
      ...d.guardians.map((g, i) => el('div', { class: 'guardian' },
        el('div', { class: 'guardian-head' },
          el('strong', {}, `守护人 ${i + 1}`),
          n > 1 ? el('button', { type: 'button', class: 'btn link small', on: { click: () => { readForm(); d.guardians.splice(i, 1); renderForm(); } } }, '移除') : null,
        ),
        personFields(`lg-g${i}`, g, `守护人 ${i + 1}`),
      )),
      n < MAX_GUARDIANS
        ? el('button', { type: 'button', class: 'btn small', on: { click: () => { readForm(); d.guardians.push(emptyPerson()); renderForm(); } } }, '＋ 添加守护人')
        : null,
      el('div', { class: 'field threshold' },
        el('label', { for: 'lg-threshold' }, '放行门限'),
        el('span', { class: 'inline' },
          el('select', { id: 'lg-threshold' },
            ...Array.from({ length: n }, (_, k) => el('option', { value: k + 1, selected: k + 1 === d.threshold }, String(k + 1)))),
          ` / ${n} 位守护人同意即可放行`),
        el('p', { class: 'hint' }, '建议至少 2 位，且小于总人数，这样有人失联也不影响放行。'),
      ),
    ),

    el('label', { class: 'ack' },
      el('input', { type: 'checkbox', id: 'lg-ack', checked: d.ack }),
      el('span', {}, '我了解：设置后无法撤回。继承人加上足够数量的守护人合作，就能解开这个文件夹里现在的全部文件。'),
    ),

    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'btn', on: { click: () => $('legacy-dialog').close() } }, '取消'),
      el('button', { type: 'submit', class: 'btn primary' }, '下一步：核对'),
    ),
  );
  body().replaceChildren(form);
  if (errBox) errBox.focus();
}

function numberField(id, label, value, hint) {
  return el('div', { class: 'field' },
    el('label', { for: id }, label),
    el('input', { id, type: 'number', min: MIN_DAYS, step: 1, value, inputmode: 'numeric', 'aria-describedby': id + '-hint' }),
    el('p', { class: 'hint', id: id + '-hint' }, `${hint}。至少 ${MIN_DAYS} 天。`),
  );
}

function personFields(id, p, who) {
  return el('div', { class: 'person' },
    el('div', { class: 'field' },
      el('label', { for: id + '-name' }, '称呼'),
      el('input', { id: id + '-name', type: 'text', value: p.name, placeholder: `如：${who === '继承人' ? '小明' : '王律师'}`, autocomplete: 'off' }),
    ),
    el('div', { class: 'field' },
      el('label', { for: id + '-key' }, '公钥（P-256，PEM 或 base64）'),
      el('textarea', { id: id + '-key', rows: 3, spellcheck: 'false', placeholder: '-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----' }, p.key),
      el('p', { class: 'hint' }, `由${who}在线下自己生成密钥对，只把公钥交给你。`),
    ),
  );
}

/** 把 DOM 里的输入读回 draft */
function readForm() {
  const d = draft;
  d.checkinDays = Number($('lg-checkin').value);
  d.threshold = Number($('lg-threshold').value);
  d.ack = $('lg-ack').checked;
  const read = (id) => ({ name: $(id + '-name').value.trim(), key: $(id + '-key').value.trim() });
  d.heir = read('lg-heir');
  d.guardians = d.guardians.map((_, i) => read(`lg-g${i}`));
}

async function onSubmit(ev) {
  ev.preventDefault();
  readForm();
  const d = draft;
  const errors = [];
  const days = (v, what) => { if (!Number.isInteger(v) || v < MIN_DAYS) errors.push(`${what}至少 ${MIN_DAYS} 天（整数）`); };
  days(d.checkinDays, '放行天数');

  const people = [{ role: '继承人', ...d.heir }, ...d.guardians.map((g, i) => ({ role: `守护人 ${i + 1}`, ...g }))];
  for (const p of people) {
    if (!p.name) errors.push(`${p.role}：请填写称呼`);
    try { Object.assign(p, await parsePublicKey(p.key)); } catch (e) { errors.push(`${p.role}的公钥：${e.message}`); }
  }
  // 同一把公钥不能出现两次：继承人兼任守护人会让门限失效
  const seen = new Map();
  for (const p of people) {
    if (!p.fingerprint) continue;
    if (seen.has(p.fingerprint)) errors.push(`${p.role}和${seen.get(p.fingerprint)}用了同一把公钥`);
    else seen.set(p.fingerprint, p.role);
  }
  if (!d.ack) errors.push('请勾选确认「设置后无法撤回」');
  if (errors.length) return renderForm(errors);

  const [heir, ...guardians] = people;
  await renderConfirm(heir, guardians);
}

// ---------------------------------------------------------------- 核对与写链

async function renderConfirm(heir, guardians) {
  const d = draft;
  const n = guardians.length;
  // 记录大小：每位守护人约 330 字节（公钥 + 指纹 + 碎片），固定部分约 1.2 KB
  const approxBytes = 1200 + n * 330;
  let cost = '';
  try { cost = '约 ' + formatBnb(estimateGas(approxBytes, 1) * await ctx.chain.gasPrice()); } catch { cost = '（暂时读不到 gas 价格）'; }
  const msg = el('p', { class: 'action-msg', role: 'status', 'aria-live': 'polite' });
  const go = el('button', { type: 'button', class: 'btn primary' }, '签名并写入链上');
  const back = el('button', { type: 'button', class: 'btn' }, '返回修改');
  back.addEventListener('click', () => { if (!busy) renderForm(); });
  go.addEventListener('click', () => runSetup(go, back, msg, heir, guardians));

  body().replaceChildren(
    el('h3', {}, '请核对'),
    el('dl', { class: 'meta compact' },
      el('dt', {}, '文件夹'), el('dd', {}, ctx.folder.label),
      el('dt', {}, '放行条件'), el('dd', {}, `${d.checkinDays} 天未报平安`),
      el('dt', {}, '放行门限'), el('dd', {}, `${d.threshold} / ${n} 位守护人`),
      el('dt', {}, '继承人'), el('dd', {}, `${heir.name} · `, el('code', {}, heir.fingerprint)),
      ...guardians.flatMap((g, i) => [el('dt', {}, `守护人 ${i + 1}`), el('dd', {}, `${g.name} · `, el('code', {}, g.fingerprint))]),
      el('dt', {}, '费用'), el('dd', {}, `1 笔交易，${cost}`),
    ),
    el('p', { class: 'muted small' }, '写入前请和每个人当面或电话核对一遍公钥指纹。接下来钱包会弹出 2 次签名（不花 gas）和 1 笔交易：'),
    el('ol', { class: 'plain' },
      el('li', {}, '签名生成文件夹密钥，和你解锁保险箱时签的是同一条消息；'),
      el('li', {}, '签名确认这份托付记录，将来守护人和继承人靠它核对是你本人设置的；'),
      el('li', {}, '交易把加密后的记录写入 _tapevault/legacy/。')),
    el('div', { class: 'modal-actions' }, back, go),
    msg,
  );
}

async function runSetup(go, back, msg, heir, guardians) {
  if (busy) return;
  busy = true;
  go.disabled = back.disabled = true;
  msg.dataset.kind = '';
  const { provider, account, chain, folder, meta } = ctx;
  const sign = (text) => signText(provider, account, text);
  let secret = null;
  try {
    await ensureChain(provider);
    msg.textContent = '第 1 步：请在钱包里签名，生成文件夹密钥…';
    secret = await deriveSecret(await sign(keyMessage(folder.container, BSC.chainId)), folder.container);
    if ((await keysFromSecret(secret)).keyCheck !== meta.keyCheck) throw new Error('密钥核对失败：当前钱包不是初始化这个保险箱的钱包');
    msg.textContent = '第 2 步：请在钱包里签名，确认托付记录…';
    const now = await chain.chainTime();
    const rec = await buildSetup({
      secret, container: folder.container, chainId: BSC.chainId, owner: account, now,
      days: draft.checkinDays, threshold: draft.threshold,
      heir: { spki: heir.spki }, guardians: guardians.map((g) => ({ spki: g.spki })), sign,
    });
    secret.fill(0);
    secret = null;
    for (let i = 0; i < rec.txs.length; i++) {
      msg.textContent = `第 3 步：请在钱包里确认交易${rec.txs.length > 1 ? `（${i + 1} / ${rec.txs.length}）` : ''}…`;
      await sendAndWait(provider, account, rec.txs[i]);
    }
    busy = false;
    renderResult(heir, guardians, rec);
    ctx.onDone?.();
  } catch (e) {
    msg.dataset.kind = 'error';
    msg.textContent = isUserRejection(e) ? '已在钱包里取消，没有写入任何内容。' : errText(e);
  } finally {
    if (secret) secret.fill(0);
    busy = false;
    go.disabled = back.disabled = false;
  }
}

// ---------------------------------------------------------------- 结果：分发信息

function renderResult(heir, guardians, rec) {
  const d = draft;
  const f = ctx.folder;
  const n = guardians.length;
  const rule = `从持有人最后一次报平安算起，超过 ${d.checkinDays} 天没有再报平安，守护人即可放行。`;
  const header = [
    'TapeVault 遗产保险箱',
    `文件夹：${f.label}`,
    `容器地址：${f.container}`,
    `网络：${BSC.name}`,
    `持有人钱包：${ctx.account}`,
    `托付记录：${rec.path}`,
  ];
  const guardianList = guardians.map((g, i) => `  ${i + 1}. ${g.name}（指纹 ${g.fingerprint}）`);
  const heirText = [
    ...header, '',
    `你是继承人：${heir.name}`,
    `你的公钥指纹：${heir.fingerprint}`,
    `放行门限：${n} 位守护人中任意 ${d.threshold} 位`,
    '守护人：', ...guardianList, '',
    `放行条件：${rule}`,
    `只靠你的私钥无法解密，还需要至少 ${d.threshold} 位守护人交出的钥匙碎片。`,
    `放行后：在 TapeVault 首页选「我是继承人 / 守护人」，输入文件夹 ${f.label}，粘贴收到的碎片并导入你的私钥，即可解密下载全部文件。`,
    '请离线妥善保管你的私钥。私钥丢失将无法继承，私钥被盗可能导致提前泄露。',
  ].join('\n');
  const guardianText = (g, i) => [
    ...header, '',
    `你是守护人 ${i + 1}：${g.name}`,
    `你的公钥指纹：${g.fingerprint}`,
    `继承人：${heir.name}（指纹 ${heir.fingerprint}）`,
    `放行门限：${n} 位守护人中任意 ${d.threshold} 位`, '',
    `放行条件：${rule}`,
    `放行时：在 TapeVault 首页选「我是继承人 / 守护人」，输入文件夹 ${f.label}，页面会显示链上报平安记录是否已到期。到期后导入你的私钥，页面生成一段碎片（tvs1: 开头），发给继承人即可。碎片只有继承人能用。`,
    '放行前请先尝试联系持有人本人。条件满足前请不要交出碎片。你看不到文件内容，只负责放行。',
  ].join('\n');

  body().replaceChildren(
    el('p', { class: 'notice' }, '托付已写入链上。请把下面的信息分别发给每个人，这些内容不会再显示，关闭前请先复制保存。'),
    el('dl', { class: 'meta compact' },
      el('dt', {}, '文件夹'), el('dd', {}, f.label),
      el('dt', {}, '放行条件'), el('dd', {}, `${d.checkinDays} 天未报平安`),
      el('dt', {}, '放行门限'), el('dd', {}, `${d.threshold} / ${n} 位守护人`),
      el('dt', {}, '记录'), el('dd', {}, el('code', {}, rec.path)),
    ),
    el('h3', {}, '需要分发的信息'),
    el('p', { class: 'muted small' }, '通过线下或你信任的渠道分别发给每个人，发之前当面或电话核对一遍公钥指纹。称呼只在这里出现，没有写入链上。'),
    distCard('lg-out-heir', `继承人 · ${heir.name}`, heirText),
    ...guardians.map((g, i) => distCard(`lg-out-g${i}`, `守护人 ${i + 1} · ${g.name}`, guardianText(g, i))),
    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'btn primary', on: { click: () => $('legacy-dialog').close() } }, '完成'),
    ),
  );
  $('legacy-dialog').scrollTop = 0;
}

function distCard(id, title, text) {
  const area = el('textarea', { id, class: 'dist-text', readonly: true, rows: Math.min(14, text.split('\n').length), spellcheck: 'false' }, text);
  const btn = el('button', { type: 'button', class: 'btn small' }, '复制');
  btn.addEventListener('click', async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { area.select(); }
    btn.textContent = ok ? '已复制' : '已选中，请手动复制';
    setTimeout(() => { btn.textContent = '复制'; }, 2000);
  });
  return el('section', { class: 'dist-card', 'aria-labelledby': id + '-t' },
    el('div', { class: 'dist-head' }, el('strong', { id: id + '-t' }, title), btn),
    el('label', { for: id, class: 'sr-only' }, title + ' 的分发信息'),
    area,
  );
}
