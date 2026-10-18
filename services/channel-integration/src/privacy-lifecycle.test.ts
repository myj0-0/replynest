import assert from "node:assert/strict";
import test from "node:test";

process.env.POSTGRES_HOST??="127.0.0.1";process.env.POSTGRES_DATABASE??="test";process.env.POSTGRES_USERNAME??="test";process.env.POSTGRES_PASSWORD??="test";
const {retentionPolicy}=await import("./privacy-lifecycle.js");

test("registration retention requires both approval and execution gates",()=>{
  const oldA=process.env.REGISTRATION_RETENTION_POLICY_APPROVED,oldE=process.env.REGISTRATION_RETENTION_EXECUTION_ENABLED;
  process.env.REGISTRATION_RETENTION_POLICY_APPROVED="false";process.env.REGISTRATION_RETENTION_EXECUTION_ENABLED="true";
  assert.equal(retentionPolicy().effective_execution,false);
  process.env.REGISTRATION_RETENTION_POLICY_APPROVED="true";process.env.REGISTRATION_RETENTION_EXECUTION_ENABLED="true";
  assert.equal(retentionPolicy().effective_execution,true);
  if(oldA===undefined)delete process.env.REGISTRATION_RETENTION_POLICY_APPROVED;else process.env.REGISTRATION_RETENTION_POLICY_APPROVED=oldA;
  if(oldE===undefined)delete process.env.REGISTRATION_RETENTION_EXECUTION_ENABLED;else process.env.REGISTRATION_RETENTION_EXECUTION_ENABLED=oldE;
});

test("invalid retention configuration fails back to bounded defaults",()=>{
  const old=process.env.REGISTRATION_FAILED_RETENTION_DAYS;process.env.REGISTRATION_FAILED_RETENTION_DAYS="0";
  assert.equal(retentionPolicy().failed_or_expired_days,30);
  if(old===undefined)delete process.env.REGISTRATION_FAILED_RETENTION_DAYS;else process.env.REGISTRATION_FAILED_RETENTION_DAYS=old;
});
