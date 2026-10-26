/* Shared bootstrap. runtime-config.js is supplied by the web build or local server. */
(() => {
  'use strict';
  const config = window.DESI_BUILD_CONFIG;
  if (!config || !['online', 'offline'].includes(config.mode)) {
    throw new Error('Invalid runtime configuration. Use the complete web or offline package.');
  }
  const offline = config.mode === 'offline';
  const script = document.currentScript;
  if (!script || !script.src) throw new Error('Cannot resolve application base URL.');
  const baseUrl = new URL('./', script.src).href;
  const cloud = Object.freeze({
    url: offline ? '' : String(config.cloud && config.cloud.url || ''),
    anonKey: offline ? '' : String(config.cloud && config.cloud.anonKey || ''),
  });
  const runtime = Object.freeze({
    mode: config.mode,
    baseUrl,
    cloud,
    capabilities: Object.freeze({ cloud: !offline, localMrm: offline }),
    asset(filename) {
      if (typeof filename !== 'string' || filename === '.' || filename === '..' || !/^[\w.-]+$/.test(filename)) {
        throw new Error('Invalid asset filename.');
      }
      return new URL('vendor/' + filename, baseUrl).href;
    },
  });
  for (const [name, value] of Object.entries({
    DESI_OFFLINE: offline,
    DesiRuntime: runtime,
    SUPABASE_URL: cloud.url,
    SUPABASE_ANON_KEY: cloud.anonKey,
  })) {
    Object.defineProperty(window, name, {value, enumerable:true, writable:false, configurable:false});
  }
})();
