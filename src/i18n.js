// 中英文切换。文案以中文原文为键，英文词典在 i18n-en.js；找不到英文时退回中文。
// 语言在 theme.js 里（<head> 同步执行）先定好并写到 <html lang>，这里直接沿用，避免两处判断不一致。
//
// 注意：钱包签名的文字（crypto.keyMessage、legacy-store.signText）不走这里，永远是固定中文：
// 改动会让已有文件夹的密钥派生不出来、已有托付记录的签名核对失败。

import EN from './i18n-en.js';

const KEY = 'tapevault:lang';
const hasDom = typeof document !== 'undefined';

let lang = hasDom && document.documentElement.lang === 'en' ? 'en' : 'zh';
const listeners = new Set();

export const getLang = () => lang;
/** 日期格式用的 locale */
export const locale = () => (lang === 'en' ? 'en-US' : 'zh-CN');

/** 翻译。vars 替换 {name} 占位符 */
export function t(zh, vars) {
  const s = lang === 'en' && Object.hasOwn(EN, zh) ? EN[zh] : zh;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

/** 语言切换后要重新渲染的界面在这里登记 */
export function onLang(fn) { listeners.add(fn); }

export function setLang(next) {
  if ((next !== 'zh' && next !== 'en') || next === lang) return;
  lang = next;
  try { localStorage.setItem(KEY, next); } catch { /* 隐私模式等写不进去时只在本页生效 */ }
  applyStatic();
  for (const fn of listeners) fn(lang);
}

// ---------------------------------------------------------------- 页面里的静态文案
// data-i18n：整段 innerHTML（原文来自本站 HTML，不含任何链上数据，可以安全地当 HTML 用）
// data-i18n-aria / data-i18n-title / data-i18n-placeholder：属性值写中文原文
const originals = new WeakMap();
let titleOriginal = null;
const ATTRS = [['data-i18n-aria', 'aria-label'], ['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder']];

export function applyStatic() {
  if (!hasDom) return;
  const html = document.documentElement;
  html.lang = lang === 'en' ? 'en' : 'zh-CN';
  for (const n of document.querySelectorAll('[data-i18n]')) {
    if (!originals.has(n)) originals.set(n, n.innerHTML.trim());
    n.innerHTML = t(originals.get(n));
  }
  for (const [attr, name] of ATTRS) {
    for (const n of document.querySelectorAll(`[${attr}]`)) n.setAttribute(name, t(n.getAttribute(attr)));
  }
  if (titleOriginal === null) titleOriginal = document.title;
  document.title = t(titleOriginal);
  // 切换按钮显示「另一种」语言
  const btn = document.getElementById('lang-toggle');
  if (btn) {
    btn.textContent = lang === 'en' ? '中' : 'EN';
    btn.setAttribute('aria-label', lang === 'en' ? '切换到中文' : 'Switch to English');
    btn.setAttribute('lang', lang === 'en' ? 'zh-CN' : 'en');
    btn.title = btn.getAttribute('aria-label');
  }
  document.dispatchEvent(new CustomEvent('tapevault:lang', { detail: lang }));
}
