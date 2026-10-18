import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assignmentSecret,validateAssignmentStartup} from './atomic-assignment.js';

test('assignment file secrets take precedence, fail closed, and leave disabled startup available',()=>{
 const names=['REPLYNEST_ASSIGNMENT_SECRET','REPLYNEST_ASSIGNMENT_SECRET_FILE','AUTOMATION_ASSIGNMENT_ENABLED'];
 const saved=names.map(n=>process.env[n]);
 const dir=mkdtempSync(join(tmpdir(),'assignment-secret-test-')),file=join(dir,'key');
 try{
  process.env.REPLYNEST_ASSIGNMENT_SECRET='environment-secret-'.repeat(3);
  process.env.REPLYNEST_ASSIGNMENT_SECRET_FILE=file;
  process.env.AUTOMATION_ASSIGNMENT_ENABLED='true';
  assert.throws(validateAssignmentStartup,/^Error: atomic_assignment_not_configured$/);
  const key='synthetic-assignment-file-'.repeat(3);
  for(const ending of ['','\n','\r\n']){writeFileSync(file,key+ending);assert.equal(assignmentSecret(),key);assert.doesNotThrow(validateAssignmentStartup);}
  for(const bad of ['', 'short', 'x'.repeat(65537), 'x'.repeat(32)+'\0']){
   writeFileSync(file,bad);assert.throws(assignmentSecret,/^Error: atomic_assignment_not_configured$/);
  }
  process.env.AUTOMATION_ASSIGNMENT_ENABLED='false';assert.doesNotThrow(validateAssignmentStartup);
  process.env.REPLYNEST_ASSIGNMENT_SECRET_FILE=dir;assert.throws(assignmentSecret);
  process.env.REPLYNEST_ASSIGNMENT_SECRET_FILE='relative/key';assert.throws(assignmentSecret);
  delete process.env.REPLYNEST_ASSIGNMENT_SECRET_FILE;assert.equal(assignmentSecret(),process.env.REPLYNEST_ASSIGNMENT_SECRET);
 }finally{
  names.forEach((n,i)=>{if(saved[i]===undefined)delete process.env[n];else process.env[n]=saved[i];});
  rmSync(dir,{recursive:true,force:true});
 }
});
