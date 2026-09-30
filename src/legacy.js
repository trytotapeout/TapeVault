// 遗产保险箱设置表单（界面预览）。只校验输入、计算公钥指纹，不做任何加密，也不上链。
// 方案：主密钥先用继承人公钥加密（内层），再用随机外锁密钥加密（外层）；
// 外锁密钥用 Shamir 拆成 n 份，分别用守护人公钥加密。继承人凑齐 m 份碎片才能解开。

import { $, el } from './dom.js';
import { BSC } from './config.js';

const MIN_DAYS = 7;
const MAX_GUARDIANS = 7;

let ctx = null;     // {folder, account}
let draft = null;   // 表单内容，「返回修改」时恢复

const emptyPerson = () => ({ name: '', key: '' });
const body = () => $('legacy-body');

export function openLegacy(folder, account) {
  ctx = { folder, account };
  draft = {
    checkinDays: 180, noticeDays: 30, threshold: 2,
    heir: emptyPerson(),
    guardians: [emptyPerson(), emptyPerson(), emptyPerson()],
    ack: false,
  };
  renderForm();
  $('legacy-dialog').showModal();
}

// ---------------------------------------------------------------- 公钥

/** 接受 PEM 或裸 base64 的 SPKI；导入成功才算有效 P-256 公钥。返回 {fingerprint} */
export async function parsePublicKey(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('请填写公钥');
  const b64 = t.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  let der;
  try { der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); } catch { throw new Error('格式不对，应为 PEM 或 base64'); }
  try {
    await crypto.subtle.importKey('spki', der, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  } catch { throw new Error('不是有效的 P-256 公钥'); }
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
  return { fingerprint: fingerprint(h.slice(0, 16)) };
}

/** 16 字节 → 8 组 4 位十六进制，方便当面或电话核对 */
const fingerprint = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(' ');

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
      el('div', { class: 'field-row' },
        numberField('lg-checkin', '报平安期限（天）', d.checkinDays, '超过这么多天没有报平安，进入公示期'),
        numberField('lg-notice', '公示期（天）', d.noticeDays, '公示期内报一次平安即可取消公示'),
      ),
    ),

    el('fieldset', {},
      el('legend', {}, '2. 继承人'),
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
      el('button', { type: 'submit', class: 'btn primary' }, '生成预览'),
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
  d.noticeDays = Number($('lg-notice').value);
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
  days(d.checkinDays, '报平安期限');
  days(d.noticeDays, '公示期');

  const people = [{ role: '继承人', ...d.heir }, ...d.guardians.map((g, i) => ({ role: `守护人 ${i + 1}`, ...g }))];
  for (const p of people) {
    if (!p.name) errors.push(`${p.role}：请填写称呼`);
    try { p.fingerprint = (await parsePublicKey(p.key)).fingerprint; } catch (e) { errors.push(`${p.role}的公钥：${e.message}`); }
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
  renderResult(heir, guardians);
}

// ---------------------------------------------------------------- 预览结果

function renderResult(heir, guardians) {
  const d = draft;
  const f = ctx.folder;
  const n = guardians.length;
  const rule = `你 ${d.checkinDays} 天没有报平安后进入公示期；公示期 ${d.noticeDays} 天结束时仍未报平安，守护人即可放行。`;

  const record = {
    app: 'tapevault', type: 'legacy', v: 1,
    owner: ctx.account,
    checkinDays: d.checkinDays,
    noticeDays: d.noticeDays,
    threshold: d.threshold,
    heir: { fingerprint: heir.fingerprint },
    guardians: guardians.map((g) => ({ fingerprint: g.fingerprint })),
    sealedKey: '<文件夹主密钥：先用继承人公钥加密，再用外锁密钥加密>',
    shares: guardians.map((_, i) => `<外锁碎片 ${i + 1}：用守护人 ${i + 1} 的公钥加密>`),
  };

  const header = [
    'TapeVault 遗产保险箱',
    `文件夹：${f.label}`,
    `容器地址：${f.container}`,
    `网络：${BSC.name}`,
    `持有人钱包：${ctx.account}`,
  ];
  const guardianList = guardians.map((g, i) => `  ${i + 1}. ${g.name}（指纹 ${g.fingerprint}）`);
  const heirText = [
    ...header,
    '',
    `你是继承人：${heir.name}`,
    `你的公钥指纹：${heir.fingerprint}`,
    `放行门限：${n} 位守护人中任意 ${d.threshold} 位`,
    '守护人：', ...guardianList,
    '',
    `放行条件：${rule}`,
    `放行后：收集至少 ${d.threshold} 份碎片，在 TapeVault 打开这个文件夹，导入你的私钥即可解密全部文件。`,
    '请离线妥善保管你的私钥。私钥丢失将无法继承，私钥被盗可能导致提前泄露。',
  ].join('\n');
  const guardianText = (g, i) => [
    ...header,
    '',
    `你是守护人 ${i + 1}：${g.name}`,
    `你的公钥指纹：${g.fingerprint}`,
    `继承人：${heir.name}（指纹 ${heir.fingerprint}）`,
    `放行门限：${n} 位守护人中任意 ${d.threshold} 位`,
    '',
    `放行条件：${rule}`,
    '放行时：在 TapeVault 打开这个文件夹的守护人视图，核对链上报平安记录确已到期，用你的私钥解开碎片后交给继承人。',
    '条件满足前请不要交出碎片。你看不到文件内容，只负责放行。',
  ].join('\n');

  body().replaceChildren(
    el('p', { class: 'notice' }, '这是预览：还没有做任何加密，也不会写入链上。'),
    el('dl', { class: 'meta compact' },
      el('dt', {}, '文件夹'), el('dd', {}, f.label),
      el('dt', {}, '触发条件'), el('dd', {}, `${d.checkinDays} 天未报平安 → 公示 ${d.noticeDays} 天`),
      el('dt', {}, '放行门限'), el('dd', {}, `${d.threshold} / ${n} 位守护人`),
      el('dt', {}, '继承人'), el('dd', {}, `${heir.name} · `, el('code', {}, heir.fingerprint)),
    ),

    el('h3', {}, '链上记录（将写入 _tapevault/legacy/）'),
    el('p', { class: 'muted small' }, '明文部分任何人都能读到：天数、门限和公钥指纹。称呼不会上链。'),
    el('pre', { class: 'record', tabindex: '0', 'aria-label': '链上记录预览' }, JSON.stringify(record, null, 2)),

    el('h3', {}, '需要分发的信息'),
    el('p', { class: 'muted small' }, '通过线下或你信任的渠道分别发给每个人，发之前当面或电话核对一遍公钥指纹。'),
    distCard('lg-out-heir', `继承人 · ${heir.name}`, heirText),
    ...guardians.map((g, i) => distCard(`lg-out-g${i}`, `守护人 ${i + 1} · ${g.name}`, guardianText(g, i))),

    el('div', { class: 'modal-actions' },
      el('button', { type: 'button', class: 'btn', on: { click: () => renderForm() } }, '返回修改'),
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
