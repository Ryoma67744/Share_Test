/* Activated by app-runtime.js after the server supplies offline build config. */
(() => {
  'use strict';
  if (window.DESI_OFFLINE !== true) return;
  const sameOrigin = (input) => {
    const value = typeof input === 'string' || input instanceof URL ? input : input && input.url;
    try {
      const u = new URL(value, location.href);
      return u.origin === location.origin || u.protocol === 'blob:' || u.protocol === 'data:';
    } catch { return false; }
  };
  const error = () => new Error('オフライン版では外部通信を使用できません。元ファイルをPCから取り込んでください。');
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, options) => sameOrigin(url) ? realFetch(url, options) : Promise.reject(error());
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    if (!sameOrigin(url)) throw error();
    return open.call(this, method, url, ...rest);
  };
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => sameOrigin(url) ? beacon(url, data) : false;
  }
  // No remote image embedding, worker import, websocket or SDK fallback can
  // bypass the HTTP server's Content-Security-Policy.
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (a && !sameOrigin(a.href)) {
      e.preventDefault();
      alert('これは外部サイトへのリンクです。オフライン版では開きません。');
    }
  }, true);
  window.addEventListener('DOMContentLoaded', () => {
    document.title = document.title.replace('DESI Data Share', 'DESI Offline');
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  });
})();
