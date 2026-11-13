import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** panel/ folder: relative paths in .env are relative to it, wherever the panel is started from. */
const PANEL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface Config {
  /** local server only (npm run dev / start). On Vercel the platform handles this. */
  host: string;
  port: number;
  /** libSQL URL: "file:./data/panel.db" locally, "libsql://….turso.io" in the cloud */
  databaseUrl: string;
  databaseToken: string;
  /** Shared secret the router sends in "Authorization: Bearer …" (drc-cloud-sync). */
  routerToken: string;
  /** mock = built-in fake router (local development only); router = the real MikroTik calls in */
  routerMode: "mock" | "router";
  soloProfile: string;
  groupProfile: string;
  wifiName: string;
  qrLoginUrl: string;
  mockSimulate: boolean;
}

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

export function loadConfig(): Config {
  const mode = env("ROUTER_MODE", "mock");
  if (mode !== "mock" && mode !== "router") throw new Error(`ROUTER_MODE must be mock or router, got "${mode}"`);
  let databaseUrl = env("DATABASE_URL", env("TURSO_DATABASE_URL", "file:./data/panel.db"));
  if (databaseUrl.startsWith("file:") && !databaseUrl.startsWith("file:/") && !/^file:[A-Za-z]:/.test(databaseUrl)) {
    databaseUrl = "file:" + resolve(PANEL_DIR, databaseUrl.slice(5)).replace(/\\/g, "/");
  }
  const cfg: Config = {
    host: env("PANEL_HOST", "127.0.0.1"),
    port: Number(env("PANEL_PORT", "8080")),
    databaseUrl,
    databaseToken: env("DATABASE_AUTH_TOKEN", env("TURSO_AUTH_TOKEN")),
    routerToken: env("ROUTER_TOKEN"),
    routerMode: mode,
    soloProfile: env("SOLO_PROFILE", "solo-3h"),
    groupProfile: env("GROUP_PROFILE", "group-3h"),
    wifiName: env("WIFI_NAME", "Don Robert Cafe - Free WiFi"),
    qrLoginUrl: env("QR_LOGIN_URL", "http://192.168.88.1/login"),
    mockSimulate: env("MOCK_SIMULATE", "1") === "1",
  };
  if (cfg.routerMode === "router" && cfg.routerToken.length < 32) {
    throw new Error("ROUTER_MODE=router needs ROUTER_TOKEN (32+ random characters, same as on the router)");
  }
  return cfg;
}
