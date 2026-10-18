"use client";

import { CheckCircle2, Download, MonitorDown, Share2, Smartphone, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BodyPortal } from "./body-portal";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type Props = {
  locale: "zh" | "en";
  tenantId?: string;
  contextualEligible?: boolean;
  openOnLoad?: boolean;
  className?: string;
};

function isStandalone() {
  if (typeof window === "undefined") return false;
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || navigatorWithStandalone.standalone === true;
}

function isIos() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export function PwaInstall({ locale, tenantId, contextualEligible = false, openOnLoad = false, className = "" }: Props) {
  const en = locale === "en";
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [contextPromptOpen, setContextPromptOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const ios = useMemo(isIos, []);
  const storageKey = `replynest:pwa-context-prompt:v1:${tenantId ?? "anonymous"}`;

  useEffect(() => {
    if (!dialogOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[aria-labelledby="pwa-install-title"]');
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') ?? []);
    focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDialogOpen(false);
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [dialogOpen]);

  useEffect(() => {
    setInstalled(isStandalone());
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }

    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDialogOpen(false);
      setContextPromptOpen(false);
      localStorage.setItem(storageKey, "installed");
    };
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [storageKey]);

  useEffect(() => {
    if (openOnLoad && !installed) setDialogOpen(true);
  }, [installed, openOnLoad]);

  useEffect(() => {
    if (!contextualEligible || installed || localStorage.getItem(storageKey)) return;
    const timer = window.setTimeout(() => setContextPromptOpen(true), 1200);
    return () => window.clearTimeout(timer);
  }, [contextualEligible, installed, storageKey]);

  function dismissContextPrompt() {
    localStorage.setItem(storageKey, new Date().toISOString());
    setContextPromptOpen(false);
  }

  async function install() {
    if (!installPrompt) return;
    setInstalling(true);
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") {
        localStorage.setItem(storageKey, "installed");
        setContextPromptOpen(false);
      } else {
        localStorage.setItem(storageKey, new Date().toISOString());
      }
      setInstallPrompt(null);
    } finally {
      setInstalling(false);
      setDialogOpen(false);
    }
  }

  if (installed) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-white px-2.5 text-sm font-semibold text-[var(--ink-700)] shadow-sm hover:bg-slate-50 sm:px-3 ${className}`}
        title={en ? "Install ReplyNest app" : "安装答巢应用"}
        aria-label={en ? "Install ReplyNest app" : "安装答巢应用"}
      >
        <Download className="size-4 shrink-0" />
        <span className="hidden xl:inline">{en ? "Install app" : "安装应用"}</span>
      </button>

      <BodyPortal>{contextPromptOpen && !dialogOpen && (
        <aside className="fixed bottom-4 left-4 right-4 z-[70] rounded-2xl border border-blue-200 bg-white p-4 shadow-2xl sm:left-auto sm:right-6 sm:w-[390px]" aria-label={en ? "Install ReplyNest" : "安装答巢应用"}>
          <button type="button" onClick={dismissContextPrompt} className="absolute right-3 top-3 grid size-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100" aria-label={en ? "Dismiss" : "暂不安装"}><X size={17} /></button>
          <div className="flex gap-3 pr-8"><div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-blue-50 text-blue-700"><Smartphone size={21} /></div><div><h2 className="font-semibold">{en ? "Do not miss new customer messages" : "不错过新的客户消息"}</h2><p className="mt-1 text-sm leading-6 text-[var(--ink-500)]">{en ? "Install ReplyNest for faster access from your desktop or Home Screen. You can enable browser notifications separately after installation." : "安装答巢后，可从桌面或主屏幕快速进入客服工作台；安装后还可按需开启浏览器消息提醒。"}</p></div></div>
          <div className="mt-4 flex gap-2"><button type="button" onClick={() => { setDialogOpen(true); setContextPromptOpen(false); }} className="flex-1 rounded-xl bg-[var(--brand-500)] px-4 py-2.5 text-sm font-semibold text-white">{en ? "See install steps" : "查看安装方式"}</button><button type="button" onClick={dismissContextPrompt} className="rounded-xl border px-4 py-2.5 text-sm font-semibold text-slate-600">{en ? "Not now" : "暂不"}</button></div>
        </aside>
      )}

      {dialogOpen && (
        <div className="fixed inset-0 z-[80] grid place-items-center bg-slate-950/45 p-4" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setDialogOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="pwa-install-title" className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-6 text-slate-900 shadow-2xl">
            <div className="flex items-start justify-between gap-4"><div><div className="grid size-11 place-items-center rounded-2xl bg-blue-50 text-blue-700"><MonitorDown size={21} /></div><h2 id="pwa-install-title" className="mt-4 text-xl font-semibold">{en ? "Install ReplyNest" : "安装答巢应用"}</h2><p className="mt-2 text-sm leading-6 text-[var(--ink-500)]">{en ? "Use the same account and workspace in a focused app window. Customer data still requires an online connection and is not saved in the offline cache." : "使用同一账号与企业工作区，在独立应用窗口中专注处理消息。客户数据仍需联网获取，不会写入离线缓存。"}</p></div><button type="button" onClick={() => setDialogOpen(false)} className="grid size-9 shrink-0 place-items-center rounded-xl text-slate-500 hover:bg-slate-100" aria-label={en ? "Close" : "关闭"}><X size={18} /></button></div>

            {installPrompt ? (
              <button type="button" onClick={install} disabled={installing} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--brand-500)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"><Download size={17} />{installing ? (en ? "Opening installer…" : "正在打开安装程序…") : (en ? "Install now" : "立即安装")}</button>
            ) : ios ? (
              <ol className="mt-5 space-y-3 rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-700">
                <li className="flex gap-3"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-white font-semibold text-blue-700">1</span><span>{en ? "Open this page in Safari." : "请先使用 Safari 打开本页面。"}</span></li>
                <li className="flex gap-3"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-white font-semibold text-blue-700">2</span><span className="inline-flex items-center gap-1.5">{en ? "Tap Share" : "点击分享"}<Share2 size={16} />{en ? "in the toolbar." : "按钮。"}</span></li>
                <li className="flex gap-3"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-white font-semibold text-blue-700">3</span><span>{en ? "Choose Add to Home Screen, then confirm Add." : "选择“添加到主屏幕”，再确认“添加”。"}</span></li>
              </ol>
            ) : (
              <div className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm leading-6 text-slate-700"><p className="font-semibold">{en ? "Use your browser menu" : "通过浏览器菜单安装"}</p><p className="mt-1">{en ? "In Chrome or Edge, open the browser menu and choose Install ReplyNest / Install app. On Android Chrome, choose Install app or Add to Home screen." : "Chrome 或 Edge 请打开浏览器菜单并选择“安装答巢/安装应用”；安卓 Chrome 可选择“安装应用”或“添加到主屏幕”。"}</p></div>
            )}

            <div className="mt-4 flex items-start gap-2 text-xs leading-5 text-[var(--ink-500)]"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600" /><span>{en ? "Installation never enables notifications automatically. You remain in control of browser notification permission." : "安装不会自动申请通知权限；是否开启浏览器通知始终由您决定。"}</span></div>
            <a href={en ? "https://docs.replynest.cn/en/install-app" : "https://docs.replynest.cn/install-app"} target="_blank" rel="noopener noreferrer" className="mt-4 block text-center text-sm font-semibold text-[var(--brand-700)]">{en ? "View PC, iOS and Android guide" : "查看 PC、iOS 与安卓教程"}</a>
          </section>
        </div>
      )}
      </BodyPortal>
    </>
  );
}
