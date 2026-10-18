import test from "node:test";
import assert from "node:assert/strict";
import { createSharedOfficialQr } from "./wechat-official.js";
import { sceneToken } from "./shared-wechat-routing.js";

test("shared QR is disabled by default and uses only an opaque temporary scene", async () => {
  const flag = process.env.SHARED_WECHAT_QR_ENABLED;
  const fetchBefore = globalThis.fetch;
  const config = { appId: "wx-shared-qr-unit-test", appSecret: "test-secret", token: "test-callback-token" };
  let calls = 0;
  try {
    delete process.env.SHARED_WECHAT_QR_ENABLED;
    globalThis.fetch = async () => { throw new Error("network_must_not_be_called"); };
    await assert.rejects(createSharedOfficialQr(sceneToken().value, config), /qr_disabled/);
    process.env.SHARED_WECHAT_QR_ENABLED = "true";
    await assert.rejects(createSharedOfficialQr("tenant-a", config), /invalid_shared_scene/);
    await assert.rejects(createSharedOfficialQr(sceneToken().value, config, 2592001), /invalid_shared_qr_expiry/);
    const scene = sceneToken().value;
    globalThis.fetch = async (url, init) => {
      calls++;
      if (String(url).endsWith("stable_token")) return new Response(JSON.stringify({ access_token: "test-only-token", expires_in: 7200 }));
      assert.equal(new URL(String(url)).pathname, "/cgi-bin/qrcode/create");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), { expire_seconds: 600, action_name: "QR_STR_SCENE", action_info: { scene: { scene_str: scene } } });
      return new Response(JSON.stringify({ ticket: "test/ticket&", expire_seconds: 600 }));
    };
    const result = await createSharedOfficialQr(scene, config);
    assert.equal(result.imageUrl, "https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=test%2Fticket%26");
    assert.equal(calls, 2);
    assert.ok(!JSON.stringify(result).includes("test-only-token"));
    globalThis.fetch = async (_url,init) => {
      assert.deepEqual(JSON.parse(String(init?.body)),{action_name:"QR_LIMIT_STR_SCENE",action_info:{scene:{scene_str:scene}}});
      return new Response(JSON.stringify({ticket:"permanent-test"}));
    };
    assert.equal((await createSharedOfficialQr(scene,config,null)).expiresIn,null);
    globalThis.fetch = async () => new Response(JSON.stringify({ errcode: 48001, errmsg: "not authorized" }));
    await assert.rejects(createSharedOfficialQr(scene, config), /shared_wechat_qr_error:48001/);
  } finally {
    globalThis.fetch = fetchBefore;
    if (flag === undefined) delete process.env.SHARED_WECHAT_QR_ENABLED; else process.env.SHARED_WECHAT_QR_ENABLED = flag;
  }
});
