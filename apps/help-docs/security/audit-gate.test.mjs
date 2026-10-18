import test from 'node:test';
import assert from 'node:assert/strict';
import {auditFindings} from './audit-gate.mjs';
const brace={source:1,name:'braces',severity:'high',url:'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',range:'<=3.0.3'};
const fixture=(via=[brace])=>({auditReportVersion:2,metadata:{vulnerabilities:{moderate:0,high:2,critical:0}},vulnerabilities:{
 braces:{severity:'high',via},parent:{severity:'high',via:['braces']}}});
test('raw warnings remain visible; only hash-verified mitigation closes this exact advisory',()=>{
 const result=auditFindings(fixture(),true);assert.equal(result.raw.high,2);assert.equal(result.advisories.length,1);assert.equal(result.unmitigated.length,0);
 assert.equal(auditFindings(fixture(),false).unmitigated.length,1);
});
test('new advisory, changed range, or another package cannot reuse the local mitigation',()=>{
 for(const edit of [{url:'https://github.com/advisories/GHSA-new'},{url:'https://other.invalid/GHSA-vfj7-8cjw-p6xm'},{range:'*'},{severity:'critical'},{name:'another-package'}])assert.equal(auditFindings(fixture([{...brace,...edit}]),true).unmitigated.length,1);
 const result=auditFindings(fixture([brace,{...brace,source:2,severity:'critical',url:'https://github.com/advisories/GHSA-new'}]),true);
 assert.equal(result.unmitigated.length,1);
});
test('registry failures, unknown paths, cycles and unexplained high findings fail closed',()=>{
 for(const audit of [{},{error:{code:'network_unavailable'}}, {...fixture(),auditReportVersion:1},
  {...fixture(),vulnerabilities:{parent:{severity:'high',via:['missing']}}},
  {...fixture(),vulnerabilities:{parent:{severity:'high',via:['parent']}}},
  {...fixture(),vulnerabilities:{parent:{severity:'high',via:[]}}}])assert.throws(()=>auditFindings(audit,true));
});

test('missing high findings and conflicting advisory metadata cannot silently pass',()=>{
 assert.throws(()=>auditFindings({...fixture(),vulnerabilities:{}},true),/metadata_mismatch/);
 assert.throws(()=>auditFindings(fixture([brace,{...brace,name:'other-package'}]),true),/conflicting_advisory/);
});

test('new moderate advisories are blocked rather than hidden by the braces exception',()=>{
 const audit=fixture();
 audit.metadata.vulnerabilities.moderate=1;
 audit.vulnerabilities.other={severity:'moderate',via:[{...brace,source:2,name:'other',severity:'moderate',url:'https://github.com/advisories/GHSA-new-moderate'}]};
 assert.equal(auditFindings(audit,true).unmitigated.length,1);
 audit.vulnerabilities.other.via=[];
 assert.throws(()=>auditFindings(audit,true),/unresolved_path/);
});
