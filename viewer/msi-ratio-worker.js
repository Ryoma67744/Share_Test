/* Transfer only derived arrays back; the caller keeps its original source refs. */
'use strict';
importScripts('msi-ratio-core.js');
self.onmessage = function(event) {
    const message = event.data || {};
    try {
        const result = MsiRatioCore.calculate(message.X, message.Y, message.options || {});
        delete result.numerator; delete result.denominator; delete result.positions; delete result.rowIds;
        const transfer = ['values', 'valid', 'reasons', 'denominatorOrder']
            .filter(key => result[key]).map(key => result[key].buffer);
        self.postMessage({id:message.id, result}, transfer);
    } catch (error) {
        self.postMessage({id:message.id, error:error && error.message || String(error)});
    }
};
