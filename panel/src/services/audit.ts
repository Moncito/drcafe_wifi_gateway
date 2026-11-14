import type { DB } from "../db.ts";

export type AuditAction =
  | "login" | "login_failed" | "logout"
  | "batch_created" | "batch_pushed" | "batch_push_failed" | "batch_printed"
  | "void" | "disconnect" | "issued"
  | "first_login" | "expired"
  | "settings_saved" | "staff_added" | "staff_changed" | "password_reset";

export async function audit(db: DB, action: AuditAction, opts: { staffId?: number | null; code?: string | null; detail?: string | null; at?: number } = {}) {
  await db.run("INSERT INTO audit (at, staff_id, action, code, detail) VALUES (?, ?, ?, ?, ?)",
    opts.at ?? Date.now(), opts.staffId ?? null, action, opts.code ?? null, opts.detail ?? null);
}

export interface AuditRow { id: number; at: number; action: AuditAction; code: string | null; detail: string | null; staff_name: string | null; serial: number | null; type: string | null }

export function recentActivity(db: DB, limit: number, actions?: AuditAction[]): Promise<AuditRow[]> {
  const filter = actions?.length ? `WHERE a.action IN (${actions.map(() => "?").join(",")})` : "";
  return db.all<AuditRow>(`
    SELECT a.id, a.at, a.action, a.code, a.detail, s.display_name AS staff_name, c.serial, c.type
    FROM audit a
    LEFT JOIN staff s ON s.id = a.staff_id
    LEFT JOIN codes c ON c.code = a.code
    ${filter}
    ORDER BY a.at DESC, a.id DESC LIMIT ?`, ...(actions ?? []), limit);
}
