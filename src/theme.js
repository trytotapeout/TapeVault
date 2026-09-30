// 明暗主题。普通脚本（非模块），在 <head> 里同步加载，页面渲染前就设好主题，避免刷新时闪一下另一种配色。
// 用户选过就用用户的选择（localStorage），否则跟随系统。
(function () {
  var KEY = 'tapevault:theme';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function saved() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch (e) { return null; }
  }
  function system() { return media && media.matches ? 'light' : 'dark'; }
  function apply(theme) {
    root.dataset.theme = theme;
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      var next = theme === 'dark' ? '浅色' : '深色';
      btn.setAttribute('aria-label', '切换到' + next + '模式');
      btn.title = '切换到' + next + '模式';
    }
  }

  apply(saved() || system());

  // 没有手动选过时，跟着系统设置变化
  if (media && media.addEventListener) {
    media.addEventListener('change', function () { if (!saved()) apply(system()); });
  }

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
