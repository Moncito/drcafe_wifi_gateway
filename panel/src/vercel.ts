// Vercel entry. Bundled by `npm run build` into index.mjs (Vercel builds it on every deploy).
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const { app } = createApp(loadConfig());
export default app;
