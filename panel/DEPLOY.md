# Deploying the panel to Vercel (cloud)

The panel is a website on Vercel with a Turso (libSQL) database. The MikroTik
**calls the panel** every 20 s (`drc-cloud-sync`). Nothing on the router or the PLDT
modem is opened to the internet.

```
UTAK terminal / PC / phone ──► https://<project>.vercel.app ◄── router (every 20 s, HTTPS + secret key)
                                        │
                                   Turso database
```

## 1. Vercel project (once)
1. Vercel dashboard → the **easyhire** team → **Add New… → Project** → import
   `Moncito/drcafe_wifi_gateway` from GitHub.
2. **Root Directory:** `panel`. **Framework Preset:** Other. Leave the build settings
   alone (they come from `panel/vercel.json`).
3. Don't deploy yet. First do steps 2 and 3.

## 2. Database (once)
Project → **Storage** → **Create** → **Turso** (Marketplace) → region **Singapore** →
connect it to this project. That adds `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
to the project's environment variables automatically.

## 3. Environment variables
Project → Settings → **Environment Variables** (Production):

| Name | Value |
|---|---|
| `ROUTER_MODE` | `router` |
| `ROUTER_TOKEN` | the long random key (copy from `panel/.env` on the admin PC, line `ROUTER_TOKEN=`). The router uses the same one. |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | added by step 2 |

Optional: `WIFI_NAME`, `QR_LOGIN_URL`, `SOLO_PROFILE`, `GROUP_PROFILE` (defaults match Phase 1).

## 4. Deploy
**Deployments → Redeploy** (or push to `main`). Open `https://<project>.vercel.app`.
The first visit asks you to create the **owner** account.

## 5. Point the router at the cloud
On the router (SSH or Winbox terminal), one line, with your project address and the same key:
```
/system script set [find where name="drc-cloud-config"] source="https://<project>.vercel.app/api/router/sync|<ROUTER_TOKEN>"
```
Within 20 s, **Settings** in the panel shows the router as *Checking in*. The router log
shows nothing unless something goes wrong (`/log print where message~"drc-cloud-sync"`).

## 6. UTAK terminal and phones
Chrome → `https://<project>.vercel.app` → log in → ⋮ → **Add to Home screen**.

## Updating
Change code in `panel/src`, then:
```
npm run check
npm test
npm run build      (regenerates api/index.mjs, which Vercel runs. Commit it.)
```
Push to `main`; Vercel deploys automatically.

## If the internet is down
The panel can't be reached and the router can't check in. Codes already on the
router keep working, but customer Wi-Fi has no internet anyway, so nothing is lost.
When the internet returns, the router catches up at its next check-in.

## Changing the router key
New random key in Vercel (`ROUTER_TOKEN`) → redeploy → update `drc-cloud-config`
on the router (step 5) → update `panel/.env` on the PC.
