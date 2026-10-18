import { readFile } from "node:fs/promises";

const stateFile = process.env.STATE_FILE ?? "/data/state.json";
const maxAgeMs = Number(process.env.HEALTH_MAX_AGE_MS ?? 240_000);
try {
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  if (!Number.isFinite(state.last_cycle_at) || Date.now() - state.last_cycle_at > maxAgeMs) process.exit(1);
  process.exit(0);
} catch {
  process.exit(1);
}
