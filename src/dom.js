// 界面工具。链上读到的字符串都可能被任何人设置，一律用 textContent 渲染，不拼 HTML。

export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

export const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
export const errText = (e) => (e && (e.shortMessage || e.message)) || String(e);

export function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

export function formatTime(sec) {
  return sec ? new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';
}

export function formatBnb(wei) {
  const v = Number(wei) / 1e18;
  return (v < 0.0001 ? v.toFixed(6) : v.toFixed(4)) + ' BNB';
}
