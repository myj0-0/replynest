import test from "node:test";
import assert from "node:assert/strict";
import { hasPermission } from "./access-control.js";

test("tenant and platform roles share one permission engine without crossing identity domains",()=>{
  assert.equal(hasPermission({domain:"tenant",role:"tenant_admin"},"tenant.members.manage"),true);
  assert.equal(hasPermission({domain:"tenant",role:"agent"},"tenant.billing.read"),false);
  assert.equal(hasPermission({domain:"platform",role:"owner"},"platform.admins.manage"),true);
  assert.equal(hasPermission({domain:"platform",role:"support"},"platform.impersonation.start"),true);
  assert.equal(hasPermission({domain:"platform",role:"auditor"},"platform.impersonation.start"),false);
  assert.equal(hasPermission({domain:"platform",role:"auditor"},"platform.registration.read"),true);
  assert.equal(hasPermission({domain:"platform",role:"support"},"platform.registration.manage"),false);
  assert.equal(hasPermission({domain:"platform",role:"admin"},"platform.registration.manage"),true);
  assert.equal(hasPermission({domain:"platform",role:"owner"},"tenant.members.manage"),false);
});
