/**
 * Plain-text protocol between the router script (router/src/drc-cloud-sync.rsc)
 * and the panel. Line based and "|" separated, because RouterOS scripting has
 * no reliable JSON on every version and text is easy to build there.
 *
 * Router -> panel (POST /api/router/sync):
 *   v1
 *   i|identity|board|version|backupComment|groupDevices|rateLimit|idleTimeout
 *   u|CODE|disabled(0/1)|comment-if-used          one per S/G code on the router
 *   a|CODE|address|mac|uptime|sessionTimeLeft|hostName    one per logged-in device
 *
 * Panel -> router (response):
 *   ok
 *   add|CODE|profile|limitUptime|comment
 *   del|CODE
 *   kick|CODE|mac        (mac empty = every device on that code)
 */
import { CODE_RE } from "../codes.ts";
import type { RouterActive, RouterInfo, RouterUser } from "./types.ts";

export interface RouterReport {
  info: RouterInfo;
  users: RouterUser[];
  active: RouterActive[];
}

export class ProtocolError extends Error {}

const clean = (s: string) => s.replace(/[|\r\n]/g, " ").trim();

export function parseReport(text: string): RouterReport {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.length > 0);
  if (lines[0] !== "v1") throw new ProtocolError("unknown report version");
  const report: RouterReport = {
    info: { identity: "", board: "", version: "", backupComment: "", groupDevices: "", rateLimit: "", idleTimeout: "" },
    users: [],
    active: [],
  };
  for (const line of lines.slice(1)) {
    const f = line.split("|");
    if (f[0] === "i") {
      report.info = {
        identity: f[1] ?? "", board: f[2] ?? "", version: f[3] ?? "", backupComment: f[4] ?? "",
        groupDevices: f[5] ?? "", rateLimit: f[6] ?? "", idleTimeout: f[7] ?? "",
      };
    } else if (f[0] === "u" && CODE_RE.test(f[1] ?? "")) {
      report.users.push({ id: f[1]!, name: f[1]!, disabled: f[2] === "1", comment: f[3] ?? "", profile: "" });
    } else if (f[0] === "a" && CODE_RE.test(f[1] ?? "")) {
      report.active.push({
        id: `${f[1]}|${f[3] ?? ""}`, user: f[1]!, address: f[2] ?? "", mac: (f[3] ?? "").toUpperCase(),
        uptime: f[4] ?? "", sessionTimeLeft: f[5] ?? "", hostName: f[6] ?? "",
      });
    }
  }
  return report;
}

export type RouterCommand =
  | { kind: "add"; code: string; profile: string; limitUptime: string; comment: string }
  | { kind: "del"; code: string }
  | { kind: "kick"; code: string; mac: string };

export function formatCommands(cmds: RouterCommand[]): string {
  const out = ["ok"];
  for (const c of cmds) {
    if (c.kind === "add") out.push(["add", c.code, clean(c.profile), clean(c.limitUptime), clean(c.comment)].join("|"));
    else if (c.kind === "del") out.push(["del", c.code].join("|"));
    else out.push(["kick", c.code, clean(c.mac)].join("|"));
  }
  return out.join("\n") + "\n";
}

export function parseCommands(text: string): RouterCommand[] {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines[0] !== "ok") throw new ProtocolError("bad response");
  return lines.slice(1).map((l) => {
    const f = l.split("|");
    if (f[0] === "add") return { kind: "add", code: f[1]!, profile: f[2]!, limitUptime: f[3]!, comment: f[4] ?? "" };
    if (f[0] === "del") return { kind: "del", code: f[1]! };
    return { kind: "kick", code: f[1]!, mac: f[2] ?? "" };
  });
}

/** Build a report the way the router script does (used by the mock router and tests). */
export function formatReport(r: RouterReport): string {
  const i = r.info;
  const lines = ["v1", ["i", i.identity, i.board, i.version, i.backupComment, i.groupDevices, i.rateLimit, i.idleTimeout].map(clean).join("|")];
  for (const u of r.users) lines.push(["u", u.name, u.disabled ? "1" : "0", u.comment.includes("start=") ? clean(u.comment) : ""].join("|"));
  for (const a of r.active) lines.push(["a", a.user, a.address, a.mac, a.uptime, a.sessionTimeLeft, clean(a.hostName)].join("|"));
  return lines.join("\n") + "\n";
}
