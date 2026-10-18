"use client";

import { createElement, useEffect, useState } from "react";
import type { ConsoleLocale } from "../lib/console-i18n";

export function CaptchaWidget({ siteKey, disabled = false, locale = "zh" }: { siteKey?: string; disabled?: boolean; locale?: ConsoleLocale }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!siteKey || disabled) return;
    window.CAP_CUSTOM_WASM_URL = "/captcha/assets/cap_wasm_bg.wasm";
    void import("cap-widget").then(() => setReady(true));
  }, [siteKey, disabled]);
  if (!siteKey || disabled) return null;
  const en = locale === "en";
  return <div className="replynest-captcha min-h-[62px]">
    {ready ? createElement("cap-widget", {
      required: true,
      "data-cap-api-endpoint": `/captcha/${encodeURIComponent(siteKey)}/`,
      "data-cap-disable-haptics": "",
      "data-cap-i18n-initial-state": en ? "Complete human verification" : "请完成人机验证",
      "data-cap-i18n-verifying-label": en ? "Verifying…" : "正在验证…",
      "data-cap-i18n-solved-label": en ? "Verified" : "验证通过",
      "data-cap-i18n-error-label": en ? "Verification failed. Try again." : "验证失败，请重试",
      "data-cap-i18n-troubleshooting-label": en ? "Troubleshoot" : "排查问题",
      "data-cap-i18n-wasm-disabled": en ? "Enable WebAssembly to complete verification" : "请启用 WebAssembly 以完成验证",
      "data-cap-i18n-verify-aria-label": en ? "Start human verification" : "点击开始人机验证",
      "data-cap-i18n-verifying-aria-label": en ? "Human verification in progress" : "正在进行人机验证",
      "data-cap-i18n-verified-aria-label": en ? "Human verification complete" : "人机验证已通过",
      "data-cap-i18n-required-label": en ? "Complete human verification first" : "请先完成人机验证",
      "data-cap-i18n-error-aria-label": en ? "Human verification error. Try again." : "人机验证出错，请重试"
    }) : <p className="px-2 py-3 text-sm text-[var(--ink-500)]">{en ? "Loading human verification…" : "正在加载人机验证…"}</p>}
  </div>;
}
