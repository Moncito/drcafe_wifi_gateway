// Emergency account tools (uses DATABASE_URL from .env, so it works on the
// cloud database too when run with the production .env):
//   npm run admin -- list
//   npm run admin -- reset-password <username> <new-password>
//   npm run admin -- create-admin <username> <new-password> "<Name>"
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createStaff, listStaff, updateStaff } from "./services/auth.ts";

const [cmd, a, b, c] = process.argv.slice(2);
const cfg = loadConfig();
const db = await openDb(cfg.databaseUrl, cfg.databaseToken);

try {
  if (cmd === "list") {
    for (const s of await listStaff(db)) console.log(`${s.username.padEnd(16)} ${s.role.padEnd(8)} ${s.active ? "active" : "disabled"}  ${s.display_name}`);
  } else if (cmd === "reset-password" && a && b) {
    const s = await db.get<{ id: number }>("SELECT id FROM staff WHERE username = ?", a.toLowerCase());
    if (!s) throw new Error(`No user "${a}"`);
    await updateStaff(db, s.id, { password: b, active: true }, s.id);
    console.log(`Password for ${a} changed (and account enabled).`);
  } else if (cmd === "create-admin" && a && b) {
    await createStaff(db, { username: a, password: b, displayName: c ?? a, role: "admin" }, null);
    console.log(`Admin ${a} created.`);
  } else {
    console.log('Usage: npm run admin -- list | reset-password <user> <pass> | create-admin <user> <pass> "<Name>"');
  }
} catch (e) {
  console.error("Error:", (e as Error).message);
  process.exitCode = 1;
} finally {
  db.close();
}
