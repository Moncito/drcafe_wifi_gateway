// Local server: development and testing on a PC (npm run dev / npm start).
// In production the same app runs on Vercel (src/vercel.ts).
import { join } from "node:path";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { MockRouter } from "./router/mock.ts";
import { handleRouterReport } from "./services/routerlink.ts";

const cfg = loadConfig();
const { app, db } = createApp(cfg);

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`Don Robert Café Wi-Fi panel: http://${cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host}:${cfg.port}  (router: ${cfg.routerMode === "mock" ? "built-in mock" : "real router checks in at /api/router/sync"})`);
});

// Mock mode: a fake router "checks in" every 5 s, exactly like drc-cloud-sync does.
let timer: NodeJS.Timeout | null = null;
if (cfg.routerMode === "mock") {
  const dataDir = cfg.databaseUrl.startsWith("file:") ? join(cfg.databaseUrl.slice(5), "..") : null;
  const mock = new MockRouter({ dataDir, simulate: cfg.mockSimulate });
  const checkIn = async () => {
    try {
      mock.apply(await handleRouterReport(await db(), cfg, mock.report()));
    } catch (e) {
      console.error("mock router check-in failed:", (e as Error).message);
    }
  };
  void checkIn();
  timer = setInterval(() => void checkIn(), 5000);
}

const stop = () => {
  if (timer) clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
