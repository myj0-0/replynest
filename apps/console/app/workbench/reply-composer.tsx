"use client";
import { wechatDeliveryFailure } from "./wechat-delivery-label";

import { AlertTriangle, CheckCircle2, LoaderCircle, Paperclip, Plus, Send, Smile, UploadCloud, X, Zap } from "lucide-react";
import { KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type { EmojiClickData } from "emoji-picker-react";

import { WorkbenchAiAssistant } from "./workbench-ai-assistant";
import {sendQuickReplyComposition,type ImageQuickReply,type QuickImage} from './quick-reply-composition';

type Result = { kind: "idle" | "accepted" | "uncertain" | "error"; message?: string; requestId?: string; silent?:boolean };
type LinkedSuggestion = { recommendationId: string; originalText: string };
type QuickReply = { quick_reply_id: string; shortcut: string; title: string; content: string;updated_at?:string;image?:QuickImage|null;reply_type?:string };
type Role = "tenant_admin" | "supervisor" | "agent";
const EmojiPicker = dynamic(() => import("emoji-picker-react"), { ssr: false });

function newKey() { return `rn-console-${crypto.randomUUID()}`; }

export function ReplyComposer({ conversationId, canReply, role, en, channel, initialQuestion = "" }: { conversationId: string; canReply: boolean; role: Role; en: boolean; channel?: string; initialQuestion?: string }) {
  const router = useRouter();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"reply" | "note" | "ai">("reply");
  const drafts = useRef({ reply: "", note: "" });
  function switchMode(next: "reply" | "note" | "ai") {
    if (sending || result.kind === "uncertain" || attachmentBusy) return;
    if (mode !== "ai") drafts.current[mode] = content;
    setMode(next);
    if (next !== "ai") setContent(drafts.current[next]);
    setKey(newKey()); setResult({ kind: "idle" }); setEmojiOpen(false); setQuickOpen(false); setTransferNotice("");
  }
  const [content, setContent] = useState("");
  useLayoutEffect(() => {
    const field = textarea.current;
    if (!field || mode === "ai") return;
    const resize = () => {
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    };
    resize();
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth !== width) { width = field.clientWidth; resize(); }
    });
    observer.observe(field);
    window.addEventListener("resize", resize);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, [content, mode]);
  const [key, setKey] = useState(newKey);
  const [sending, setSending] = useState(false);
  const sendInFlight = useRef(false);
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const [linkedSuggestion, setLinkedSuggestion] = useState<LinkedSuggestion>();
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [quickOpen, setQuickOpen] = useState(false);
  const [activeQuick, setActiveQuick] = useState(0);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [transferNotice, setTransferNotice] = useState("");
  const [pendingMedia,setPendingMedia]=useState<{id:string;name:string}>();
  const [mediaKey,setMediaKey]=useState(newKey);
  const [quickImage,setQuickImage]=useState<ImageQuickReply>();
  const [quickImageSent,setQuickImageSent]=useState(false);
  const quickProgress=useRef(false);
  const manager = role === "tenant_admin" || role === "supervisor";

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string; recommendationId?: string; text?: string }>).detail;
      if (detail?.conversationId !== conversationId || typeof detail.recommendationId !== "string" || typeof detail.text !== "string" || !detail.text.trim() || result.kind === "uncertain" || sending) return;
      setMode("reply"); drafts.current.reply = detail.text.trim();
      setContent(detail.text.trim()); setLinkedSuggestion({ recommendationId: detail.recommendationId, originalText: detail.text.trim() });setQuickImage(undefined);setQuickImageSent(false);quickProgress.current=false;
      setKey(newKey()); setQuickOpen(false); setResult({ kind: "idle" });
    };
    window.addEventListener("replynest:composer:insert", listener);
    return () => window.removeEventListener("replynest:composer:insert", listener);
  }, [conversationId, result.kind, sending]);

  const quickQuery = content.match(/^\/([^\s\n]*)$/)?.[1];
  useEffect(() => {
    if (quickQuery === undefined) { setQuickOpen(false); return; }
    const abort = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/quick-replies?query=${encodeURIComponent(quickQuery ?? "")}`, { cache: "no-store", signal: abort.signal });
        const body = await response.json() as { data?: QuickReply[] };
        if (response.ok && !abort.signal.aborted) { setQuickReplies(body.data ?? []); setActiveQuick(0); setQuickOpen(true); }
      } catch { /* Composer remains usable if this optional lookup fails. */ }
    }, 120);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [quickQuery]);

  function insertText(value: string) {
    const field = textarea.current; const start = field?.selectionStart ?? content.length; const end = field?.selectionEnd ?? content.length;
    setContent(`${content.slice(0, start)}${value}${content.slice(end)}`); setQuickOpen(false); setEmojiOpen(false);
    window.setTimeout(() => { field?.focus(); field?.setSelectionRange(start + value.length, start + value.length); }, 0);
  }

  function chooseQuick(item: QuickReply) {
    if(sending||sendInFlight.current||attachmentBusy||result.kind==='uncertain')return;
    if(item.reply_type&&item.reply_type!=='text'&&!item.image){setTransferNotice(en?'The image is unavailable; ask an administrator to update this quick reply.':'图片素材不可用，请管理员更新该快捷回复。');return;}
    if(item.image&&(mode!=='reply'||!['shared_wechat','wechat_official_account'].includes(channel??''))){setTransferNotice(en?'Image quick replies currently require a WeChat public reply.':'图片快捷回复当前仅可用于微信公众号的公开回复；不会自动改成文字或下载链接。');return;}
    if(item.image&&!item.updated_at)return;
    setPendingMedia(undefined);setQuickImage(item.image?{quick_reply_id:item.quick_reply_id,updated_at:item.updated_at!,image:item.image}:undefined);
    quickProgress.current=false;setQuickImageSent(false);setKey(newKey());setResult({kind:'idle'});setTransferNotice('');
    setContent(item.content); setQuickOpen(false); setLinkedSuggestion(undefined);
    window.setTimeout(() => textarea.current?.focus(), 0);
  }

  async function uploadAttachment(file?: File) {
    if (!file || attachmentBusy||quickImage) return;
    setAttachmentBusy(true); setTransferNotice("");
    try {
      const form = new FormData(); form.set("file", file);
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/file-transfers`, { method: "POST", body: form });
      const body = await response.json() as { data?: { transfer_id:string;url: string; file_name: string; delivery_mode: string; native_attachment_supported: boolean }; error?: { message?: string } };
      if (!response.ok || !body.data) { setTransferNotice(body.error?.message ?? (en ? "The file could not be prepared." : "文件处理失败。")); return; }
      if(body.data.native_attachment_supported){setPendingMedia({id:body.data.transfer_id,name:body.data.file_name});setMediaKey(newKey());setTransferNotice(en?'Scanned and ready. Click Send media to send the original image/video to WeChat.':'安全处理完成。请点击“发送图片/视频”，将原始媒体发送至微信；上传本身不会发送。');return;}
      insertText(en ? `File: ${body.data.file_name}\nDownload: ${body.data.url}` : `文件：${body.data.file_name}\n下载：${body.data.url}`);
      setTransferNotice(en ? `A scanned, expiring relay link was inserted for ${channel ?? "this channel"}. Review it, then click Send.` : `已为${channel ? ` ${channel} ` : "当前渠道"}插入经安全扫描的限时中转链接；请检查后再点击发送。`);
    } catch { setTransferNotice(en ? "The file service is temporarily unavailable." : "文件服务暂不可用。"); }
    finally { setAttachmentBusy(false); if (attachmentInput.current) attachmentInput.current.value = ""; }
  }

  async function createUploadInvitation() {
    if (attachmentBusy) return;
    setAttachmentBusy(true); setTransferNotice("");
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/file-transfer-invitations`, { method: "POST" });
      const body = await response.json() as { data?: { url: string }; error?: { message?: string } };
      if (!response.ok || !body.data) { setTransferNotice(body.error?.message ?? (en ? "Could not create an upload invitation." : "无法创建上传邀请。")); return; }
      insertText(en ? `Please upload your file using this secure single-use link (valid for 24 hours):\n${body.data.url}` : `请通过以下安全的一次性链接上传文件（24 小时有效）：\n${body.data.url}`);
      setTransferNotice(en ? "The upload invitation was inserted. Review it, then click Send." : "上传邀请已插入输入框；请检查后再点击发送。");
    } catch { setTransferNotice(en ? "The upload invitation service is temporarily unavailable." : "上传邀请服务暂不可用。"); }
    finally { setAttachmentBusy(false); }
  }

  async function submitMedia(){
    if(!pendingMedia||mode!=='reply'||!canReply||sendInFlight.current||sending||attachmentBusy||result.kind==='uncertain')return;
    sendInFlight.current=true;setSending(true);setResult({kind:'idle'});
    try{
      const response=await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/media`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':mediaKey},body:JSON.stringify({file_transfer_id:pendingMedia.id})});
      const body=await response.json() as {data?:{state?:string};error?:{code?:string;message?:string};request_id?:string};
      if(response.status===202&&body.data?.state==='accepted'){setPendingMedia(undefined);setMediaKey(newKey());setTransferNotice('');setResult({kind:'accepted',silent:true,message:en?'WeChat accepted the media. This is not a read receipt.':'微信已接受媒体，不代表客户已读。'});}
      else setResult({kind:['send_outcome_uncertain','request_in_progress'].includes(body.error?.code??'')?'uncertain':'error',message:body.error?.message??(en?'Media was not sent.':'媒体未发送。'),requestId:body.request_id});
      router.refresh();
    }catch{setResult({kind:'uncertain',message:en?'The media outcome is unconfirmed. Do not resend.':'媒体发送结果待核对，请勿重发。'});}
    finally{sendInFlight.current=false;setSending(false);}
  }

  async function submit() {
    const trimmed = content.trim(); const limit = mode === "reply" && linkedSuggestion ? 4_000 : 10_000;
    if(mode==='reply'&&quickImage){
      if(!canReply||sendInFlight.current||sending||attachmentBusy||result.kind==='uncertain'||trimmed.length>4000)return;
      sendInFlight.current=true;setSending(true);setResult({kind:'idle'});
      try{
        const sent=await sendQuickReplyComposition({conversationId,item:quickImage,text:trimmed,key,imageAccepted:quickProgress.current},{fetcher:fetch,imageAccepted:()=>{quickProgress.current=true;setQuickImageSent(true);},failure:state=>wechatDeliveryFailure(state,en)});
        if(sent.kind==='accepted'){
          setContent('');drafts.current.reply='';setQuickImage(undefined);quickProgress.current=false;setQuickImageSent(false);setKey(newKey());
          setResult({kind:'accepted',silent:!trimmed||sent.deliveryState==='shared_provider_accepted',message:en?'Image accepted by WeChat; text, if any, accepted for channel delivery. This does not mean read.':'微信已接受图片；文字如有已受理，具体状态请查看消息下方，不代表已读。'});
        }else{
          setResult({kind:sent.kind,message:(sent.imageAccepted?(en?'Image already accepted; it will not be resent. Text needs attention. ':'图片已被微信接受，不会重复发送；文字需核查。 '):'')+(sent.message??(sent.kind==='uncertain'?(en?'Outcome unconfirmed. Do not resend; refresh and reconcile.':'结果待核对，请勿重发；请刷新并核查。'):(en?'Not sent. Review the quick reply before trying again.':'尚未发送，请检查快捷回复后再试。'))),requestId:sent.requestId});
          if(sent.kind==='error')setKey(newKey());
        }
        router.refresh();
      }finally{sendInFlight.current=false;setSending(false);}
      return;
    }
    if (mode === "ai" || (mode === "reply" && !canReply) || sendInFlight.current || sending || attachmentBusy || result.kind === "uncertain" || !trimmed || trimmed.length > limit) return;
    sendInFlight.current = true;
    setSending(true); setResult({ kind: "idle" });
    try {
      if (mode === "reply" && linkedSuggestion) {
        const action = trimmed === linkedSuggestion.originalText.trim() ? "accepted" : "edited";
        const response = await fetch(`/api/copilot/recommendations/${linkedSuggestion.recommendationId}/actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...(action === "edited" ? { text: trimmed } : {}) }) });
        const body = await response.json() as { error?: { message?: string }; request_id?: string };
        if (!response.ok) { setResult({ kind: "error", message: body.error?.message ?? (en ? "The AI suggestion is no longer applicable." : "AI 建议已不再适用，请重新生成或改为人工回复。"), requestId: body.request_id }); return; }
      }
      const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ content: trimmed, private: mode === "note" }) });
      const body = await response.json() as { request_id?: string; data?: { state?: string; delivery_state?: string }; error?: { code?: string; message?: string } };
      if (response.status === 202 && body.data?.state === "accepted") {
        const rejected = wechatDeliveryFailure(body.data.delivery_state ?? "", en);
        if (rejected) {
          setResult({kind:"error",message:rejected,requestId:body.request_id});
          // Preserve the draft and idempotency key. Repeated clicks cannot resend this command.
          router.refresh(); return;
        }
        if (["shared_uncertain","shared_blocked"].includes(body.data.delivery_state ?? "")) {
          setResult({kind:"uncertain",message:body.data.delivery_state==="shared_blocked"
            ? (en?"Saved to the workspace, but WeChat delivery was blocked. Contact your administrator before sending again.":"消息已记录在工作台，但微信投递被阻止。请联系管理员核查后再发送。")
            : (en?"WeChat delivery is unconfirmed. Do not resend; contact your administrator to reconcile the result.":"微信投递结果待核对。请勿重复发送，请联系管理员核查。"),requestId:body.request_id});
          router.refresh();return;
        }
        drafts.current[mode] = "";
        setContent(""); setKey(newKey()); setLinkedSuggestion(undefined); setResult({ kind: "accepted", silent:mode==='reply'&&body.data.delivery_state==='shared_provider_accepted', message: mode === "note" ? (en ? "Private note saved. Visible to your team only." : "私人便笺已保存，仅团队可见。") : body.data.delivery_state==="shared_provider_accepted" ? (en?"WeChat accepted the reply. This does not indicate that the customer has read it.":"微信接口已接受回复，不代表客户已读。") : (en ? "Reply accepted and awaiting channel delivery." : "回复已受理，正在等待渠道投递。"), requestId: body.request_id }); router.refresh();
      } else if (["send_outcome_uncertain", "request_in_progress"].includes(body.error?.code ?? "")) {
        setResult({ kind: "uncertain", message: en ? "The outcome is uncertain. Do not resend; refresh first." : "发送结果尚未确认，请勿重复发送；请先刷新会话核查。", requestId: body.request_id });
      } else { setKey(newKey()); setResult({ kind: "error", message: body.error?.message ?? (en ? "The reply could not be sent." : "回复发送失败。"), requestId: body.request_id }); }
    } catch { setResult({ kind: "uncertain", message: en ? "The connection ended before confirmation. Do not resend; refresh first." : "连接在结果确认前中断。请勿重复发送，先刷新会话核查。" }); }
    finally { sendInFlight.current = false; setSending(false); }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter used to commit an IME candidate must never send a customer message.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && event.repeat) { event.preventDefault(); return; }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey || event.shiftKey)) {
      event.preventDefault();
      if (!sending && !locked && content.length < characterLimit) insertText("\n");
      return;
    }
    if (quickOpen && quickReplies.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActiveQuick(index => (index + (event.key === "ArrowDown" ? 1 : -1) + quickReplies.length) % quickReplies.length); return; }
      if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); chooseQuick(quickReplies[activeQuick]); return; }
      if (event.key === "Escape") { event.preventDefault(); setQuickOpen(false); return; }
    }
    if (event.key === "Enter" && !event.altKey) { event.preventDefault(); void submit(); }
  }

  const locked = result.kind === "uncertain"; const characterLimit = mode === "reply" && (linkedSuggestion||quickImage) ? 4_000 : 10_000;
  return <div className="relative shrink-0 border-t border-[var(--border-subtle)] bg-white p-2 md:p-3"><div className="mx-auto max-w-3xl">
    {!canReply && mode === "reply" && <Notice kind="error" text={en ? "This conversation is not currently replyable." : "当前会话暂不可回复。"}/>}
    {result.kind !== "idle" && (result.kind==='accepted'&&result.silent?<p role="status" className="sr-only">{result.message}</p>:<Notice kind={result.kind} text={result.message!} requestId={result.requestId}/>)}
    {channel==="shared_wechat" && mode==="reply" && <details className="mb-2 text-xs leading-5 text-slate-500"><summary className="cursor-pointer">{en?"WeChat delivery limits":"微信发送限制说明"}</summary><p>{en?"Customer messages: up to 5 replies within 48 hours. Scan, follow and eligible menu interactions: up to 3 within 1 minute. Shared-account quotas also apply; WeChat's actual response is authoritative. These are rule limits, not your remaining balance. Keep website chat as a fallback.":"客户发消息：48 小时内最多 5 条；扫码、关注及符合条件的菜单交互：1 分钟内最多 3 条。另受共享公众号额度限制，以微信实际返回为准。这里是规则上限，不代表当前剩余额度；请保留网站客服作为备用。"}</p></details>}
    {quickOpen && <div className="absolute bottom-[calc(100%-12px)] z-30 max-h-72 w-[min(34rem,calc(100%-2rem))] overflow-y-auto rounded-2xl border border-[var(--border-subtle)] bg-white p-2 shadow-xl">
      <div className="flex items-center justify-between px-2 py-1"><span className="text-xs font-semibold">{en ? "Quick replies" : "快捷回复"}</span>{manager && <a href="/knowledge#quick-replies" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--brand-700)]"><Plus size={13}/>{en ? "Manage" : "管理"}</a>}</div>
      {quickReplies.length ? quickReplies.map((item, index) => <button type="button" key={item.quick_reply_id} onMouseDown={event => event.preventDefault()} onClick={() => chooseQuick(item)} className={`block w-full rounded-xl px-3 py-2 text-left ${index === activeQuick ? "bg-blue-50" : "hover:bg-slate-50"}`}><span className="text-xs font-semibold text-[var(--brand-700)]">/{item.shortcut}</span><span className="ml-2 text-xs font-medium">{item.title}</span><span className="mt-1 block truncate text-[11px] text-[var(--ink-500)]">{item.image?(item.content?(en?"Image + text · ":"图片＋文字 · "):(en?"Image · ":"图片 · ")):item.reply_type==='image'?(en?"Image unavailable · ":"图片不可用 · "):""}{item.content||item.image?.file_name}</span></button>) : <p className="px-3 py-4 text-xs text-[var(--ink-500)]">{en ? "No matching quick reply." : "没有匹配的快捷回复。"}</p>}
    </div>}
    {emojiOpen && <div className="absolute bottom-[calc(100%-12px)] z-30 overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-white shadow-xl"><EmojiPicker onEmojiClick={(value: EmojiClickData) => insertText(value.emoji)} lazyLoadEmojis searchPlaceHolder={en ? "Search emoji" : "搜索表情"} previewConfig={{ showPreview: false }} width={340} height={300}/></div>}
    <div role="tablist" aria-label={en ? "Composer mode" : "编辑模式"} className="mb-1 flex gap-1">
      {(["reply", "note", "ai"] as const).map(tab => <button key={tab} type="button" role="tab" aria-selected={mode === tab} disabled={sending || locked || attachmentBusy} onClick={() => switchMode(tab)} className={`rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-40 ${mode === tab ? tab === "note" ? "bg-amber-100 text-amber-950"  : "bg-blue-50 text-blue-800" : "text-slate-500"}`}>{tab === "reply" ? (en ? "Reply" : "回复") : tab === "note" ? (en ? "Private note" : "私人便笺") : (en ? "AI suggestion" : "AI 推荐")}</button>)}
    </div>
    <div hidden={mode !== "ai"} ><WorkbenchAiAssistant conversationId={conversationId} initialQuestion={initialQuestion} en={en}/></div>
    <div hidden={mode === "ai"} className={`rounded-2xl border ${mode === "note" ? "bg-amber-50 border-amber-200" : "bg-white"} shadow-sm transition focus-within:border-[var(--brand-500)] ${locked ? "border-amber-300 bg-amber-50/40" : "border-[var(--border-subtle)]"}`}>
      {mode==='reply'&&quickImage&&<div className="m-3 flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] p-3"><img src={`/api/quick-reply-images/${encodeURIComponent(quickImage.image.asset_id)}/content`} alt={en?'Selected quick reply image':'已选择的快捷回复图片'} className="size-20 shrink-0 rounded-lg object-contain" referrerPolicy="no-referrer"/><div className="min-w-0 flex-1 text-xs leading-5"><p className="break-all">{quickImage.image.file_name}</p><p>{quickImageSent?(en?'Image already accepted; retry sends only the remaining text.':'图片已被微信接受，继续发送只处理剩余文字。'):content.trim()?(en?'Preview: image → text; two WeChat replies. Nothing has been sent.':'预览：先图片、后文字，共两条微信回复；尚未发送。'):(en?'Preview: one image reply. Nothing has been sent.':'预览：一条图片回复；尚未发送。')}</p></div><button type="button" className="shrink-0" disabled={sending||locked} aria-label={en?'Remove selected quick reply image':'移除已选择的快捷回复图片'} onClick={()=>{setQuickImage(undefined);quickProgress.current=false;setQuickImageSent(false);setKey(newKey());}}><X size={16}/></button></div>}
      <textarea ref={textarea} value={content} onChange={event => { setContent(event.target.value); if (result.kind === "accepted" || result.kind === "error") setResult({ kind: "idle" }); }} onKeyDown={keyDown} disabled={(mode === "reply" && !canReply) || sending || locked} maxLength={characterLimit} rows={2} aria-label={mode === "note" ? (en ? "Private note" : "私人便笺") : (en ? "Reply to customer" : "回复客户")} placeholder={mode === "note" ? (en ? "Internal note — never sent to the customer" : "内部便笺，仅团队可见，不会发送给客户") : locked ? (en ? "Refresh before another action" : "请刷新核查后再继续操作") : (en ? "Write a reply, or type / for quick replies…" : "输入回复，或输入 / 搜索快捷回复…")} className="block min-h-16 max-h-[clamp(64px,20dvh,176px)] w-full resize-none overflow-y-auto overscroll-contain bg-transparent px-3 py-2 text-sm leading-6 outline-none disabled:cursor-not-allowed disabled:text-slate-500"/>
      <div className="flex h-10 items-center border-t border-[var(--border-subtle)] px-3 text-[11px] text-slate-500">{mode === "note" ? (en ? "Team only · never sent to the customer" : "仅团队可见 · 不会发送给客户") : linkedSuggestion ? (en ? "AI draft linked · review before sending" : "已关联 AI 草稿 · 请核对后发送") : (en ? "Enter to send · Ctrl+Enter for a new line" : "Enter 发送 · Ctrl+Enter 换行")}</div>
      <div className="flex min-h-[52px] items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-3 py-2"><div className="flex min-w-0 items-center gap-1"><button type="button" onClick={() => { setEmojiOpen(value => !value); setQuickOpen(false); }} className="grid size-8 place-items-center rounded-lg hover:bg-slate-100" title={en ? "Emoji" : "表情"}><Smile size={17}/></button><button type="button" onClick={() => { setContent("/"); setQuickOpen(true); setEmojiOpen(false); window.setTimeout(() => textarea.current?.focus(), 0); }} className="grid size-8 place-items-center rounded-lg hover:bg-slate-100" title={en ? "Quick replies" : "快捷回复"}><Zap size={17}/></button><input ref={attachmentInput} type="file" accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.txt,.md,.csv,.docx,.xlsx,.mp4" className="hidden" onChange={event => void uploadAttachment(event.target.files?.[0])}/><button type="button" disabled={mode !== "reply" || attachmentBusy || !canReply || sending || locked || Boolean(pendingMedia)} onClick={() => attachmentInput.current?.click()} className="grid size-8 place-items-center rounded-lg hover:bg-slate-100 disabled:opacity-40" title={en ? "Attach a file" : "添加图片或附件"}>{attachmentBusy ? <LoaderCircle className="animate-spin" size={17}/> : <Paperclip size={17}/>}</button><button type="button" disabled={mode !== "reply" || attachmentBusy || !canReply || sending || locked} onClick={() => void createUploadInvitation()} className="grid size-8 place-items-center rounded-lg hover:bg-slate-100 disabled:opacity-40" title={en ? "Invite customer upload" : "邀请客户上传"}><UploadCloud size={17}/></button><span className="ml-1 hidden sm:inline text-[11px] text-[var(--ink-500)]">{content.length.toLocaleString()}/{characterLimit.toLocaleString()}{linkedSuggestion && <span className="ml-1 text-violet-700">· {en ? "AI linked" : "已关联 AI"}</span>}</span></div>
        <button type="button" onClick={() => void submit()} disabled={(mode === "reply" && !canReply) || sending || locked || attachmentBusy || (!content.trim()&&!(mode==='reply'&&quickImage))} className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-[var(--brand-500)] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45">{sending ? <LoaderCircle className="animate-spin" size={16}/> : <Send size={16}/>} {sending ? (en ? "Sending…" : "发送中…") : (mode === "note" ? (en ? "Add note" : "添加便笺") : quickImage?(quickImageSent?(en?"Send remaining text":"发送剩余文字"):content.trim()?(en?"Send image and text":"发送图文组合"):(en?"Send image quick reply":"发送图片快捷回复")):(en ? "Send reply" : "发送回复"))}</button></div>
    </div>{pendingMedia&&<div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-blue-50 p-3 text-xs"><span className="min-w-0 flex-1 truncate">{pendingMedia.name}</span><button type="button" disabled={mode!=='reply'||!canReply||sending||locked||attachmentBusy} onClick={()=>void submitMedia()} className="rounded-lg bg-blue-600 px-3 py-2 font-semibold text-white disabled:opacity-40">{en?'Send image/video':'发送图片/视频'}</button><button type="button" disabled={sending||locked} onClick={()=>{setPendingMedia(undefined);setTransferNotice('');}} className="px-2 py-1">{en?'Cancel':'取消'}</button></div>}{transferNotice && <p className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-[11px] leading-5 text-blue-800">{transferNotice}</p>}<p className="mt-2 hidden md:block text-[11px] leading-5 text-[var(--ink-500)]">{mode === "ai" ? (en ? "Review sources, then use the draft. Send with Enter or the Send reply button." : "核对引用依据后填入回复，可继续编辑；按 Enter 或点击“发送回复”才会外发。") : mode === "note" ? (en ? "Private notes are visible to your team only." : "私人便笺仅团队可见，不会发送给客户。") : (en ? "Enter to send · Ctrl+Enter for a new line. Review before sending." : "Enter 发送 · Ctrl+Enter 换行。请核对回复内容后发送。")}</p>
  </div></div>;
}

function Notice({ kind, text, requestId }: { kind: "accepted" | "uncertain" | "error"; text: string; requestId?: string }) {
  const accepted = kind === "accepted";
  return <div className={`mb-3 flex items-start gap-2 rounded-xl border px-3 py-2 text-xs leading-5 ${accepted ? "border-green-200 bg-green-50 text-green-800" : kind === "uncertain" ? "border-amber-300 bg-amber-50 text-amber-950" : "border-red-200 bg-red-50 text-red-800"}`}>{accepted ? <CheckCircle2 className="mt-0.5 shrink-0" size={15}/> : <AlertTriangle className="mt-0.5 shrink-0" size={15}/>}<span>{text}{requestId && <span className="ml-1 opacity-70">ID: {requestId}</span>}</span></div>;
}
