import assert from "node:assert/strict";
import test from "node:test";
import { validateConversationAutomationSettings } from "./conversation-automation-core.js";

test('three reception modes map to compatible stored flags',()=>{
  for(const mode of ['manual','draft','automatic'] as const){
    const r=validateConversationAutomationSettings({reception_mode:mode,ai_auto_send_confidence_threshold_percent:90,confirm_enable:true,reason:'Administrator confirms reception mode'});
    assert.ok(r.ok);if(r.ok){assert.equal(r.value.ai_auto_reply_enabled,mode!=='manual');assert.equal(r.value.automatic_sending_enabled,mode==='automatic');}
  }
});
test('unknown and contradictory reception modes are rejected',()=>{
  for(const input of [{reception_mode:'unrestricted'},{reception_mode:'manual',automatic_sending_enabled:true}])assert.equal(validateConversationAutomationSettings({...input,ai_auto_send_confidence_threshold_percent:90,confirm_enable:true,reason:'Administrator confirms reception mode'}).ok,false);
});

test("accepts an explicit tenant automation preference with a bounded threshold", () => {
  const result = validateConversationAutomationSettings({
    automatic_sending_enabled: true,
    ai_auto_reply_enabled: true,
    ai_auto_send_confidence_threshold_percent: 92,
    confirm_enable: true,
    reason: "Tenant administrator approved the staged preference"
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.ai_auto_send_confidence_threshold_percent, 92);
});

test("rejects thresholds outside the supported percentage range", () => {
  for (const threshold of [49, 100.1, 101, "90"]) {
    const result = validateConversationAutomationSettings({
      automatic_sending_enabled: false,
      ai_auto_reply_enabled: false,
      ai_auto_send_confidence_threshold_percent: threshold,
      confirm_enable: false,
      reason: ""
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid_automation_settings");
  }
});

test("requires explicit confirmation and a reason when either preference is enabled", () => {
  const result = validateConversationAutomationSettings({
    automatic_sending_enabled: false,
    ai_auto_reply_enabled: true,
    ai_auto_send_confidence_threshold_percent: 90,
    confirm_enable: false,
    reason: "short"
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "enable_confirmation_required");
});

test("allows disabling both preferences without an enable reason", () => {
  const result = validateConversationAutomationSettings({
    automatic_sending_enabled: false,
    ai_auto_reply_enabled: false,
    ai_auto_send_confidence_threshold_percent: 90,
    confirm_enable: false,
    reason: ""
  });
  assert.equal(result.ok, true);
});

test('automatic sending cannot be enabled without automatic reply generation',()=>{
  const result=validateConversationAutomationSettings({automatic_sending_enabled:true,ai_auto_reply_enabled:false,
    ai_auto_send_confidence_threshold_percent:90,confirm_enable:true,reason:'Administrator explicitly confirmed sending'});
  assert.equal(result.ok,false);
});
