import { migrate, pool } from "./database.js";
import { hashConsolePassword } from "./console-password.js";

await migrate();
const email = (process.env.PLATFORM_ADMIN_EMAIL ?? "admin@example.com").trim().toLowerCase();
const displayName = (process.env.PLATFORM_ADMIN_DISPLAY_NAME ?? "ReplyNest Owner").trim();
const role = process.env.PLATFORM_ADMIN_ROLE ?? "owner";
const password = process.env.PLATFORM_ADMIN_PASSWORD ?? "";
if (!password) throw new Error("PLATFORM_ADMIN_PASSWORD is required");
if (!['owner','admin','support','auditor'].includes(role)) throw new Error("Invalid PLATFORM_ADMIN_ROLE");
const passwordHash = await hashConsolePassword(password);
await pool.query(`INSERT INTO platform_admin_accounts(email,display_name,password_hash,role,status)
  VALUES($1,$2,$3,$4,'active') ON CONFLICT(email) DO UPDATE SET display_name=EXCLUDED.display_name,password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,status='active',session_version=platform_admin_accounts.session_version+1,updated_at=NOW()`, [email, displayName, passwordHash, role]);
console.log(`platform_admin_bootstrapped email=${email} role=${role}`);
await pool.end();
