# Don Robert Café – Customer Wi‑Fi slip system

Customers get a printed slip with a code: 3 hours of Wi‑Fi per drink, everything stops at 1:00 AM.

| Folder | What |
|---|---|
| `router/` | **Phase 1** – MikroTik scripts you import yourself. Start with [router/APPLY.md](router/APPLY.md) |
| `panel/` | **Phase 2** – admin panel + slip printing (cloud website, see [panel/DEPLOY.md](panel/DEPLOY.md)) |
| `router/hotspot/` | **Phase 3** – Don Robert login page for the hotspot. See [router/hotspot/PHASE3.md](router/hotspot/PHASE3.md) |
| `Don-Robert-Cafe-WiFi-System-Plan.pdf` | The agreed plan |

---

## Admin panel (cloud)

A website on Vercel (database: Turso). Opened on the **UTAK terminal**, the admin PC
and the owner's phone, all showing the same data. The router **checks in every 20 s**
(`drc-cloud-sync`): it reports codes in use and devices online, and picks up work
(new codes, voids, disconnects). Nothing on the router or the PLDT modem is opened
to the internet. **Setup and updates: [panel/DEPLOY.md](panel/DEPLOY.md).**

### What's where
- **Today**: slips used (S/G), devices online, time to 1:00 AM, slips per hour, by shift, recent activity. Refreshes every 30 s.
- **Print slips**: today's batch (owner), "+20 solo / +5 group" extras (everyone), reprint a page, void a batch or serial range (owner), past batches.
- **Look up & devices**: find a slip by code (`S3K7PW`) or serial (`S-042`), see its devices, disconnect one, void it (owner).
- **Settings & staff** (owner): time per code and daily counts, router facts and last backup, staff accounts.

### How a batch is made safely
1. The panel saves the codes first (unique serials, codes unique for all time). The batch shows **Waiting for router**.
2. At its next check-in (≤ 20 s) the router adds them, skipping any it already has.
3. Only when the router has reported **every** code does the **Print** button appear.

A lost check-in just means the same work is sent again, so nothing is ever duplicated. A double-clicked form returns the same batch. No batches can be made between 1:00 and 5:00 AM, because the router deletes all codes then.
Voids and disconnects also happen at the router's next check-in (about 20 s).

### Printing the slips
1. *Print slips* → *Create codes & print* (owner, each morning after 5:00 AM). Wait for **Print** to appear (about 20–40 s).
2. On the sheet press **Print**: **A4**, **Scale 100% / Actual size** (*not* "Fit to page"), Margins **Default**, **Headers and footers off**. Black & white is fine.
3. 180 slips = 4 pages. Cut along the dashed lines. Spoiled page? *Reprint a page*.
4. Check one slip with a **non‑bypassed phone**: scan the QR code and it should log straight in.

### Accounts and lock‑outs
Forgot the owner password? On a PC with the repo and the production database settings in `panel/.env`
(`DATABASE_URL` = the Turso URL, `DATABASE_AUTH_TOKEN` = its token):
```
npm run admin -- reset-password owner NEW-PASSWORD-HERE
```

### Development
```
cd panel
npm install
copy .env.example .env      (ROUTER_MODE=mock: a built-in fake router checks in every 5 s)
npm run dev                 (http://127.0.0.1:8080, restarts on file changes)
npm test                    (batches, router check-in round trip, void, disconnect, clock)
npm run check               (TypeScript type check)
npm run build               (bundle for Vercel: api/index.mjs, commit it)
```
The fake router follows the Phase 1 rules (clock time, 7 devices per group code, 1:00–5:00 AM cleanup)
and pretends customers log in, so the dashboard fills up.

---

## Router: restore from backup
Backups: `drc-before-phase1`, `drc-before-hardening`, and the nightly `drc-auto-<mon…sun>` (last 7 days, made at 1:15 AM).

**Normal restore (you can still log in):**
1. Winbox → Files: if the backup isn't on the router any more, drag the `.backup` file in from the laptop.
2. Select it → **Restore** (or `/system backup load name=drc-auto-fri.backup`). The router reboots with that configuration.
3. Codes created after that backup are gone. Re‑create today's batch from the panel if needed (*Print slips*. A voided or missing batch can be made again.)

**Locked out:** see [router/HARDENING.md → If you get locked out](router/HARDENING.md) (Safe Mode, other allowed device, reset button + restore, Netinstall).

**Partial undo of Phase 1 without a reboot:** [router/ROLLBACK.md](router/ROLLBACK.md).

Copy the nightly backups off the router now and then (Winbox → Files → drag to the laptop). If the router dies, the backups on it die with it.
