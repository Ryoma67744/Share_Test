import assert from 'node:assert/strict';
import { canonicalNumeric, matchExpRows } from '../mrm/exp-library-import.mjs';
for (const [input, expected] of [['001.200','1.2'],['-0.000','0'],['.3e2','30'],['12e-3','0.012'],['1e3','1000'],['12abc',null],['1e101',null],['1e-101',null],['Infinity',null],['',null]]) assert.equal(canonicalNumeric(input), expected);
const compound = { id:'c1', name:'Lactate', polarity:'-', updated_at:'2026-01-01T00:00:00Z', shelf:'main', transitions:[{id:'t1',precursor:89,product:43,ce:11,cv:20}] };
const base = {id:'row1',name:'Lactate',polarity:'-',precursor:'89.0',product:43,ce:11,cv:20};
const library = [compound];
const frozen = JSON.stringify(library);
let [result] = matchExpRows([base],library);
assert.equal(result.status,'exact');
assert.equal(result.payload.expected.transitions[0].precursor,'89');
[result] = matchExpRows([{...base,ce:12}],library);
assert.equal(result.status,'new-condition');
assert.equal(result.requiresAcknowledgement,true);
assert.equal(result.payload.allow_new_condition,false);
[result] = matchExpRows([{...base,polarity:'+'}],library);
assert.equal(result.status,'polarity-conflict'); assert.equal(result.payload,null);
[result] = matchExpRows([{...base,name:'New'}],library,{shelf:'archive'});
assert.equal(result.status,'new-compound'); assert.equal(result.expected,null);
for (const patch of [{ce:''},{cv:'12abc'},{precursor:0},{product:-1},{name:'bad\nname'},{polarity:null},{tags:['\n'] }]) {
 [result] = matchExpRows([{...base,...patch}],library);
 assert.equal(result.status,'invalid',JSON.stringify(patch));
}
assert.equal(JSON.stringify(library),frozen);
assert.equal(matchExpRows([base,base],library).length,2);
console.log('exp library import: numeric matching, conflicts, acknowledgement, snapshots, validation passed');
