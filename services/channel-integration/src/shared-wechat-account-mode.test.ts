import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { isSharedWechatAccountActive } from "./shared-wechat-account-mode.js";
test("shared activation takes over only the designated account; DB failures do not permit fallback",async()=>{
  let calls=0,enabled=false,fail=false;
  const db={query:async(_sql:string,values:string[])=>{calls++;assert.deepEqual(values,["shared-app"]);if(fail)throw new Error("database unavailable");return {rows:enabled?[{}]:[]};}} as unknown as Pool;
  assert.equal(await isSharedWechatAccountActive(db,"tenant-own-app","shared-app",true),false);
  assert.equal(await isSharedWechatAccountActive(db,"shared-app","shared-app",false),false);assert.equal(calls,0);
  assert.equal(await isSharedWechatAccountActive(db,"shared-app","shared-app",true),false);
  enabled=true;assert.equal(await isSharedWechatAccountActive(db,"shared-app","shared-app",true),true);
  fail=true;await assert.rejects(isSharedWechatAccountActive(db,"shared-app","shared-app",true),/database unavailable/);
});
