export type PlatformApprovalMode = "single" | "dual";

export function platformApprovalMode(): PlatformApprovalMode {
  return process.env.PLATFORM_APPROVAL_MODE === "single" ? "single" : "dual";
}
