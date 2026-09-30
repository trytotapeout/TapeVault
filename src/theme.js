// 明暗主题与界面语言。普通脚本（非模块），在 <head> 里同步加载，页面渲染前就设好，避免刷新时闪一下另一种配色或语言。
// 用户选过就用用户的选择（localStorage），否则跟随系统 / 浏览器语言。
// 文案翻译在 i18n.js（模块）；英文页面在翻译完成前先隐藏正文（见 style.css 的 data-i18n-pending）。
(function () {
  var KEY = 'tapevault:theme';
  var LANG_KEY = 'tapevault:lang';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }

  var lang = read(LANG_KEY);
  if (lang !== 'zh' && lang !== 'en') lang = /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
  root.lang = lang === 'en' ? 'en' : 'zh-CN';
  if (lang === 'en') {
    root.dataset.i18nPending = '';
    // 翻译模块加载失败时也不要一直空白：最多等 3 秒，退回中文原文
    setTimeout(function () { delete root.dataset.i18nPending; }, 3000);
  }

  function saved() {
    var v = read(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  }
  function system() { return media && media.matches ? 'light' : 'dark'; }
  function apply(theme) {
    root.dataset.theme = theme;
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      var en = root.lang === 'en';
      var label = theme === 'dark'
        ? (en ? 'Switch to light mode' : '切换到浅色模式')
        : (en ? 'Switch to dark mode' : '切换到深色模式');
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
  }

  apply(saved() || system());

  // 没有手动选过时，跟着系统设置变化
  if (media && media.addEventListener) {
    media.addEventListener('change', function () { if (!saved()) apply(system()); });
  }

  // 语言切换后更新按钮说明
  document.addEventListener('tapevault:lang', function () {
    delete root.dataset.i18nPending;
    apply(root.dataset.theme);
  });

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    apply(root.dataset.theme);
    btn.addEventListener('click', function () {
      var theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, theme); } catch (e) { /* 隐私模式等写不进去时只在本页生效 */ }
      apply(theme);
    });
  });
})();
