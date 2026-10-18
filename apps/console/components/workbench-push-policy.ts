export function shouldPromptForPush(permission: string, active: boolean, snoozedUntil: number, now: number) {
  return permission!=="denied" && !active && !(snoozedUntil>now);
}
