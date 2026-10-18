import type {RoutingState} from './shared-wechat-routing.js';

export type AutomaticSharedRouteFence=Readonly<{appId:string;openId:string;tenantId:string;routeVersion:number}>;
export type AutomaticSharedRouteDecision={allowed:true}|{allowed:false;reason:'invalid_route'|'route_changed'|'merchant_entry_required'|'merchant_selection_required'|'merchant_changed'};
/** Only verified persisted state/receipt, never model output or a fresh guessed route.
 * Caller must read under the SAME shared-wechat:appId:openId advisory lock used by
 * routing transitions and recheck enabled tenant/enrollment/inbox rows separately.
 * One association needs no merchant selection. Multiple associations always do,
 * even if only one remains enabled; do not silently reroute to another merchant.
 */
export function automaticSharedRouteDecision(fence:AutomaticSharedRouteFence,state:RoutingState,now:number):AutomaticSharedRouteDecision{
 const deny=(reason:Exclude<AutomaticSharedRouteDecision,{allowed:true}>['reason']):AutomaticSharedRouteDecision=>({allowed:false,reason});
 if(!fence||!state||!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(fence.routeVersion)||fence.routeVersion<0||
  !Number.isSafeInteger(state.version)||state.version<0||!Number.isSafeInteger(state.lastTransitionAt)||state.lastTransitionAt<0||state.lastTransitionAt>now||
  typeof fence.appId!=='string'||!/^wx[a-f0-9]{16}$/.test(fence.appId)||typeof fence.openId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(fence.openId)||
  typeof fence.tenantId!=='string'||!fence.tenantId.trim()||!Array.isArray(state.associations)||state.associations.length>100||
  state.associations.some(a=>!a||typeof a.tenantId!=='string'||!a.tenantId.trim())||
  new Set(state.associations.map(a=>a.tenantId)).size!==state.associations.length)return deny('invalid_route');
 if(state.appId!==fence.appId||state.openId!==fence.openId||state.version!==fence.routeVersion)return deny('route_changed');
 if(state.needsMerchantEntry!==undefined&&state.needsMerchantEntry!==false)return deny('merchant_entry_required');
 if(!state.associations.some(a=>a.tenantId===fence.tenantId))return deny('merchant_changed');
 if(state.associations.length===1)return {allowed:true};
 // Older routing rows used PostgreSQL's fractional epoch milliseconds.
 // Accept only finite numeric times, rounded DOWN: never extend their expiry
 // or relax the exact tenant/version fence while upgrading existing rows.
 const expiry=state.selected?.expiresAt;
 if(!state.selected||!Number.isFinite(expiry)||!Number.isSafeInteger(Math.floor(expiry!))||Math.floor(expiry!)<=now)return deny('merchant_selection_required');
 if(state.selected.tenantId!==fence.tenantId)return deny('merchant_changed');
 return {allowed:true};
}
