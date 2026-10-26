'use strict';

// The portable server supplies this response instead of the source tree's
// online runtime-config.js. app-runtime.js freezes the nested cloud settings
// and derives DESI_OFFLINE/SUPABASE_* before application code executes.
function renderOfflineConfig() {
  return "Object.defineProperty(window,'DESI_BUILD_CONFIG',{value:Object.freeze({mode:'offline',cloud:{url:'',anonKey:''}}),writable:false,configurable:false});";
}

module.exports = { renderOfflineConfig };
