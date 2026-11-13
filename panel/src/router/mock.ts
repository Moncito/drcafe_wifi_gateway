import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CODE_RE, parseRouterComment } from "../codes.ts";
import { isClosedWindow, msToRouterEpoch } from "../time.ts";
import { formatReport, parseCommands } from "./protocol.ts";
import type { RouterActive, RouterUser } from "./types.ts";

interface MockState { nextId: number; users: RouterUser[]; active: RouterActive[] }

const DEVICES = ["iPhone", "Android", "Galaxy-S24", "Redmi-Note", "iPad", "MacBook-Air", "LAPTOP-HP", "OPPO-A78", "vivo-Y36", "Pixel-8"];

/**
 * Fake MikroTik for development and tests. It follows the Phase 1 router rules
 * (clock time, 7 devices per group, 01:00–05:00 cleanup) and talks to the panel
 * exactly like the real drc-cloud-sync script: report() builds the text the
 * router would POST, apply() runs the panel's answer.
 */
export class MockRouter {
  private state: MockState = { nextId: 1, users: [], active: [] };
  private readonly file: string | null;
  private readonly simulate: boolean;
  private readonly now: () => number;

  constructor(opts: { dataDir: string | null; simulate: boolean; now?: () => number }) {
    this.file = opts.dataDir ? join(opts.dataDir, "mock-router.json") : null;
    this.simulate = opts.simulate;
    this.now = opts.now ?? Date.now;
    if (this.file) {
      try { this.state = JSON.parse(readFileSync(this.file, "utf8")) as MockState; } catch { /* fresh */ }
    }
  }

  private save() {
    if (!this.file) return;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state));
  }

  /** Router-side rules: minute check (expiry) and the closed-window cleanup. */
  tick() {
    const now = this.now();
    const epoch = msToRouterEpoch(now);
    if (isClosedWindow(now)) {
      this.state.users = this.state.users.filter((u) => !CODE_RE.test(u.name));
      this.state.active = this.state.active.filter((a) => !CODE_RE.test(a.user));
      return;
    }
    for (const u of this.state.users) {
      const st = parseRouterComment(u.comment);
      if (!u.disabled && st.end !== undefined && epoch >= st.end) {
        u.disabled = true;
        u.comment += `exp=${epoch};`;
        this.state.active = this.state.active.filter((a) => a.user !== u.name);
      }
    }
    if (this.simulate) this.simulateCustomers();
  }

  /** Pretend a customer logs in with this code on a new device. */
  login(name: string, deviceName?: string): RouterActive {
    const u = this.state.users.find((x) => x.name === name);
    if (!u || u.disabled) throw new Error(`Mock router: ${name} can't log in`);
    const max = name.startsWith("G") ? 7 : 1;
    if (this.state.active.filter((a) => a.user === name).length >= max) throw new Error(`Mock router: ${name} has no free device slots`);
    const epoch = msToRouterEpoch(this.now());
    const st = parseRouterComment(u.comment);
    if (st.end === undefined) {
      const dur = st.dur ?? 10800;
      u.comment = (u.comment.startsWith("drc;") ? u.comment : "drc;") + `start=${epoch};end=${epoch + dur};`;
    }
    const n = this.state.nextId++;
    const mac = `02:00:00:00:${(n >> 8).toString(16).padStart(2, "0")}:${(n & 255).toString(16).padStart(2, "0")}`.toUpperCase();
    const a: RouterActive = { id: `${name}|${mac}`, user: name, address: `192.168.88.${10 + (n % 240)}`, mac, uptime: "0s", sessionTimeLeft: "", hostName: deviceName ?? DEVICES[n % DEVICES.length]! };
    this.state.active.push(a);
    this.save();
    return a;
  }

  private simulateCustomers() {
    const unused = this.state.users.filter((u) => !u.disabled && parseRouterComment(u.comment).start === undefined);
    if (unused.length && Math.random() < 0.4) {
      try { this.login(unused[Math.floor(Math.random() * unused.length)]!.name); } catch { /* ignore */ }
    }
    const groups = this.state.users.filter((u) => u.name.startsWith("G") && !u.disabled && parseRouterComment(u.comment).start !== undefined);
    if (groups.length && Math.random() < 0.25) {
      try { this.login(groups[Math.floor(Math.random() * groups.length)]!.name); } catch { /* full */ }
    }
    if (this.state.active.length && Math.random() < 0.15) {
      this.state.active.splice(Math.floor(Math.random() * this.state.active.length), 1);
    }
  }

  /** What the router POSTs to /api/router/sync. */
  report(): string {
    this.tick();
    this.save();
    const epoch = msToRouterEpoch(this.now());
    return formatReport({
      info: { identity: "hAP (mock)", board: "hAP ax S (mock)", version: "7.25.1 (mock)", backupComment: "drc last backup 2026-11-14 01:15:02 drc-auto-sat", groupDevices: "7", rateLimit: "5M/5M", idleTimeout: "5m" },
      users: this.state.users.filter((u) => CODE_RE.test(u.name)),
      active: this.state.active.map((a) => {
        const st = parseRouterComment(this.state.users.find((u) => u.name === a.user)?.comment);
        const left = st.end !== undefined && a.user.startsWith("S") ? Math.max(0, st.end - epoch) : null;
        return { ...a, sessionTimeLeft: left === null ? "" : `${Math.floor(left / 3600)}h${Math.floor((left % 3600) / 60)}m` };
      }),
    });
  }

  /** Run the panel's answer, like drc-cloud-sync does. */
  apply(answer: string) {
    for (const c of parseCommands(answer)) {
      if (c.kind === "add") {
        if (!this.state.users.some((u) => u.name === c.code)) {
          this.state.users.push({ id: `*${(this.state.nextId++).toString(16).toUpperCase()}`, name: c.code, comment: c.comment, disabled: false, profile: c.profile });
        }
      } else if (c.kind === "del") {
        this.state.active = this.state.active.filter((a) => a.user !== c.code);
        this.state.users = this.state.users.filter((u) => u.name !== c.code);
      } else {
        this.state.active = this.state.active.filter((a) => !(a.user === c.code && (!c.mac || a.mac === c.mac.toUpperCase())));
      }
    }
    this.save();
  }

  users() { return this.state.users; }
  active() { return this.state.active; }
}
