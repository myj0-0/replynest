/** Display-only fallback: never replace an authorized nickname or a staff rename.
 * The suffix is not unique and is not an authentication credential. Shared
 * channel identities are hashes: pass the verified thread OpenID, not its hash.
 */
export function wechatCustomerName(name: string, channel: string, openId: unknown, authorizedNickname?:unknown): string {
  if (name !== '微信访客' || !['shared_wechat', 'wechat_official_account'].includes(channel)) return name;
  if(typeof authorizedNickname==='string'&&authorizedNickname.trim()&&authorizedNickname.length<=100&&!/[\u0000-\u001f\u007f]/u.test(authorizedNickname))return authorizedNickname.trim();
  if (typeof openId !== 'string' || !/^[A-Za-z0-9_-]{4,128}$/.test(openId)) return name;
  return `微信访客 · ${openId.slice(-4)}`;
}
