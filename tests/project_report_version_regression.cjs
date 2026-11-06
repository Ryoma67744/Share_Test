'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const App = require('../viewer/project-report-app.js');
const Data = require('../viewer/project-report-data.js');
const Deck = require('../viewer/project-report-deck.js');

assert.ok(App.REPORT_REVISION, 'Report code declares the revision it can export');
assert.doesNotThrow(() => App.assertReportModules(Data, Deck));
for (const [data, deck] of [
  [null, Deck], [Data, null], [{...Data, REPORT_REVISION: undefined}, Deck],
  [Data, {...Deck, REPORT_REVISION: undefined}],
  [{...Data, REPORT_REVISION: 'previous-report'}, Deck],
  [Data, {...Deck, REPORT_REVISION: 'previous-report'}],
]) {
  assert.throws(() => App.assertReportModules(data, deck), error =>
    error.code === 'REPORT_VERSION_MISMATCH' && /再読み込み/.test(error.message),
  'A cached or missing module must not produce a mixed-version report');
}

const html = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8');
const appUrl = html.match(/<script\s+defer\s+src="([^"]*project-report-app\.js[^"]*)"/)[1];
const dataUrl = html.match(/projectReportData:\s*"([^"]+)"/)[1];
const deckUrl = html.match(/projectReportDeck:\s*"([^"]+)"/)[1];
for (const [url, file] of [[appUrl,'app'],[dataUrl,'data'],[deckUrl,'deck']]) {
  const parsed = new URL(url, 'https://fixture.invalid/viewer/');
  assert.equal(parsed.pathname, '/viewer/project-report-' + file + '.js');
  assert.equal(parsed.searchParams.get('v'), App.REPORT_REVISION,
    'Eager and lazy scripts must use URLs for the same report revision');
}
console.log('Project report revision regressions passed (matching modules, stale modules, versioned URLs).');
