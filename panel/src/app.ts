import express from "express";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.ts";
import { openDb, type DB } from "./db.ts";
import { buildRoutes } from "./web/routes.ts";

/** Folder holding public/ (on Vercel the function runs from the project root). */
function rootDir(): string {
  if (existsSync(join(process.cwd(), "public", "css", "app.css"))) return process.cwd();
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** The whole panel as an Express app: used by the local server and by Vercel. */
export function createApp(cfg: Config) {
  let dbPromise: Promise<DB> | null = null;
  const db = () => (dbPromise ??= openDb(cfg.databaseUrl, cfg.databaseToken).catch((e) => { dbPromise = null; throw e; }));

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use("/static", express.static(join(rootDir(), "public"), { maxAge: "10m" }));
  app.use(express.urlencoded({ extended: false, limit: "20kb" }));
  app.use(buildRoutes({ db, cfg }));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(new Date().toISOString(), err);
    res.status(500).send(`<p style="font-family:sans-serif">Something went wrong: ${String(err.message).replace(/[<>&]/g, "")}</p><p><a href="/">Back</a></p>`);
  });
  return { app, db };
}
