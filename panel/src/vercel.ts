// Vercel entry. Bundled by `npm run build` into api/index.mjs.
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const { app } = createApp(loadConfig());
export default app;
