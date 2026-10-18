"use client";
import { Bell, X } from "lucide-react";
import { useEffect,useRef,useState } from "react";
import { createPortal } from "react-dom";
import { shouldPromptForPush } from "./workbench-push-policy";

type State="checking"|"ready"|"active"|"denied"|"unsupported"|"disabled"|"error";
export function WorkbenchPushPrompt({en,tenantId,userId}:{en:boolean;tenantId:string;userId:string}) {
  const [state,setState]=useState<State>("checking"),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const dialog=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const snoozeKey=`rn:push-nudge:v1:${userId}:${tenantId}`;
  function dismiss() {if(busy)return;try{localStorage.setItem(snoozeKey,String(Date.now()+7*86400000));}catch{}setOpen(false);trigger.current?.focus();}
  useEffect(()=>{
    let cancelled=false;
    async function check() {
      if(!window.isSecureContext || !("Notification" in window) || !("PushManager" in window) || !("serviceWorker" in navigator)){setState("unsupported");return;}
      if(Notification.permission==="denied"){setState("denied");return;}
      const config=await fetch("/api/browser-push/config",{cache:"no-store"}).then(async r=>{if(!r.ok)throw new Error();return r.json();});
      if(!config.data?.enabled){if(!cancelled)setState("disabled");return;}
      const registration=await navigator.serviceWorker.register("/sw.js",{scope:"/"});
      const subscription=await registration.pushManager.getSubscription();
      let active=false;
      if(subscription && Notification.permission==="granted") {
        const response=await fetch("/api/browser-push/subscriptions/status",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...subscription.toJSON(),expected_tenant_id:tenantId,expected_user_id:userId}),cache:"no-store"});
        if(!response.ok)throw new Error();active=(await response.json()).data?.active===true;
      }
      if(cancelled)return;
      setState(active?"active":"ready");
      let until=0;try{until=Number(localStorage.getItem(snoozeKey)??0);}catch{}
      if(shouldPromptForPush(Notification.permission,active,until,Date.now()))setOpen(true);
    }
    void check().catch(()=>{if(!cancelled)setState("error");});
    return()=>{cancelled=true;};
  },[tenantId,userId,snoozeKey]);
  useEffect(()=>{if(open)dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();},[open]);
  async function enable() {
    if(busy)return;setBusy(true);setMessage("");
    try {
      // Must be the first asynchronous action in this click handler (Safari user activation).
      const permission=Notification.permission==="granted"?"granted":await Notification.requestPermission();
      if(permission!=="granted") {setState(permission==="denied"?"denied":"ready");setMessage(en?"Not enabled. You can try again using the bell button.":"尚未开启，可稍后点击铃铛按钮重试。");try{localStorage.setItem(snoozeKey,String(Date.now()+7*86400000));}catch{}return;}
      const configResponse=await fetch("/api/browser-push/config",{cache:"no-store"});
      if(!configResponse.ok)throw new Error();const config=await configResponse.json();
      if(!config.data?.enabled)throw new Error();
      await navigator.serviceWorker.register("/sw.js",{scope:"/"});
      const worker=await Promise.race([navigator.serviceWorker.ready,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error()),10000))]);
      const key=config.data.public_key.replace(/-/g,"+").replace(/_/g,"/");
      const subscription=await worker.pushManager.getSubscription()??await worker.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(key.padEnd(Math.ceil(key.length/4)*4,"=")),c=>c.charCodeAt(0))});
      const response=await fetch("/api/browser-push/subscriptions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...subscription.toJSON(),expected_tenant_id:tenantId,expected_user_id:userId,device_label:en?"Support workspace browser":"客服工作台浏览器"})});
      if(!response.ok)throw new Error();const result=await response.json();
      setState("active");
      setMessage(result.data?.test_status==="delivered"?(en?"Enabled. A test push was accepted by the push service; actual display depends on device settings.":"已启用，推送服务已接受测试通知；实际显示还受设备设置影响。"):(en?"Subscription saved, but the test push failed. Please check notification settings.":"订阅已保存，但测试推送未成功，请检查通知设置。"));
    } catch {setState("error");setMessage(en?"Could not enable notifications. Check your network, workspace and browser settings, then retry.":"开启失败，请检查网络、当前企业及浏览器设置后重试。");}
    finally{setBusy(false);}
  }
  const details=state==="denied"?(en?"Notifications are blocked. Allow notifications in this site's browser settings, then reload.":"浏览器已拒绝通知。请在浏览器的本站权限设置中允许通知，再刷新页面。"):
    state==="unsupported"?(en?"This browser cannot enable push here. On iPhone/iPad, add ReplyNest to the Home Screen, then open it there.":"当前环境无法开启推送。iPhone/iPad 请先将答巢添加到主屏幕，再从主屏幕打开。"):
    state==="disabled"?(en?"Push is not configured on the server. Contact your administrator.":"服务端推送尚未配置，请联系管理员。"):
    en?"Enable notifications for this workspace and browser. Delivery follows your workspace's notification rules and quiet hours. Customer message text is excluded by default.":"为当前企业和浏览器开启通知。推送遵循企业的通知规则和免打扰时段，默认不包含客户消息正文。";
  return <><button ref={trigger} onClick={()=>setOpen(true)} aria-label={en?"Message notifications":"消息通知"} title={en?"Message notifications":"消息通知"} className="inline-flex items-center gap-1 rounded-lg border px-2 py-2 text-xs"><Bell size={14}/><span className="hidden sm:inline">{state==="active"?(en?"Notifications on":"通知已启用"):(en?"Enable notifications":"开启通知")}</span></button>
    {open && createPortal(<div className="studio-workbench-portal fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/30 p-4"><div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="push-prompt-title" aria-describedby="push-prompt-description" onKeyDown={event=>{
      if(event.key==="Escape"){event.preventDefault();dismiss();}
      if(event.key==="Tab"){const nodes=dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');if(!nodes?.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
    }} className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 text-slate-900 shadow-xl"><div className="flex items-center justify-between gap-3"><h2 id="push-prompt-title" className="font-semibold">{en?"Stay informed about customer conversations":"及时关注客户会话"}</h2><button onClick={dismiss} disabled={busy} aria-label={en?"Close":"关闭"}><X size={18}/></button></div><p id="push-prompt-description" className="mt-3 text-sm leading-6 text-slate-600">{details}</p><p role="status" className="mt-3 text-sm leading-6">{message}</p><div className="mt-4 flex flex-wrap gap-2">{["ready","error"].includes(state)&&<button disabled={busy} onClick={()=>void enable()} className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy?(en?"Enabling…":"正在开启…"):(en?"Enable message notifications":"开启消息通知")}</button>}<button disabled={busy} onClick={dismiss} className="rounded-xl border px-4 py-2 text-sm">{state==="active"?(en?"Done":"完成"):(en?"Not now":"暂不开启")}</button><a href="/notifications" className="px-2 py-2 text-sm text-blue-700">{en?"Notification settings":"通知设置"}</a></div></div></div>,document.body)}
  </>;
}
