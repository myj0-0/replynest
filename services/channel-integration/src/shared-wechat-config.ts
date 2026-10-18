import { readWeChatCredential } from "./wechat-connection.js";
import { secretValue } from "./secret-value.js";
import type { SharedCallbackConfig } from "./shared-wechat-callback.js";

/** Reuse a validated encrypted credential reference instead of copying secrets. */
export async function sharedWechatConfig(): Promise<SharedCallbackConfig> {
  const appId=process.env.SHARED_WECHAT_APP_ID ?? "",receiverId=process.env.SHARED_WECHAT_RECEIVER_ID ?? "";
  if(!/^wx[A-Za-z0-9]{16}$/.test(appId) || !/^gh_[A-Za-z0-9]+$/.test(receiverId))throw new Error("shared_account_config_invalid");
  const reference=process.env.SHARED_WECHAT_CREDENTIAL_REF;
  const credential=reference ? await readWeChatCredential(reference,appId) : {
    appId,appSecret:secretValue("SHARED_WECHAT_APP_SECRET")??"",token:secretValue("SHARED_WECHAT_CALLBACK_TOKEN")??"",
    encodingAesKey:secretValue("SHARED_WECHAT_ENCODING_AES_KEY")
  };
  if(!credential.token || !/^[A-Za-z0-9+/]{43}$/.test(credential.encodingAesKey??""))throw new Error("shared_account_config_invalid");
  return {...credential,receiverId};
}
