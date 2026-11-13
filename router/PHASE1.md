# Phase 1 – Router rules

Everything here is pasted/imported into the MikroTik **by you**. Nothing in this
repo connects to the router.

## Files

| File | What it does |
|---|---|
| `00-backup.rsc` | Full backup + export (`drc-before-phase1`) – run first |
| `01-scripts.rsc` | **Generated.** Installs 5 scripts: `drc-epoch`, `drc-login`, `drc-sweep`, `drc-closing`, `drc-backup` |
| `02-profiles.rsc` | `group3-3h` → `group-3h` (7 devices), on-login hook on both profiles, `http-pap` on `hsprof1` |
| `03-schedulers.rsc` | NTP on; `drc-sweep` every 1 min, `drc-closing` 01:00, `drc-backup` 01:15 |
| `04-panel-access.rsc` | Panel PC lease + bypass, HTTPS cert, REST restricted to panel PC, limited `drc-panel` user |
| `05-hardening.rsc` | Static leases, services and MAC access locked to laptop + panel PC, customer isolation (see HARDENING.md) |
| `src/*.rsc` | Readable script sources. Edit these, then `node router/tools/build-scripts.mjs` |
| `tools/epoch.test.mjs` | Checks the date maths (`node router/tools/epoch.test.mjs`) |
| **`APPLY.md`** | **Exact apply order + what "pass" looks like for every test. Start here.** |
| `HARDENING.md` | Why each hardening change, Safe Mode, lock-out recovery |
| `ROLLBACK.md` | How to undo Phase 1 |

> The "Install" section below is superseded by **APPLY.md**, which includes 04 and 05 in the right order.

## How the rules work

### Clock-time 3 hours (why this design)
Each code is a hotspot user whose **comment** carries its state:

```
drc;dur=10800;                                   ← created by the panel (unused)
drc;dur=10800;start=1794600000;end=1794610800;   ← after first login (active)
drc;dur=10800;start=…;end=…;exp=1794610860;      ← after expiry (disabled)
```

- **On first login** (`drc-login`, from the profile's on-login): writes `start` and
  `end = start + dur`. Later logins don't change it, so leaving the café doesn't pause the clock.
- **Every minute** (`drc-sweep`): any S/G code with `now ≥ end` is **disabled**, its devices
  are kicked and its cookies dropped. A disabled code can't log in again.
- **Why not `limit-uptime`:** uptime is counted per connected session, so 7 devices
  on a group code would use it up about 7× faster, and idle phones don't count at all.
  The clock rule is the same for 1 device or 7.
- **Why a sweeper and not one scheduler per code:** state lives on the code itself, so a reboot,
  a re-import or 180 codes a day leave nothing behind. Worst case a code runs ≤ 1 min over.
- `dur` comes from the comment, so a duration change in the panel applies to the
  next batch only (as in the design). Missing `dur` → 3 h.
- Times are "Manila wall-clock seconds since 1970" computed from `/system clock`
  date + time (`drc-epoch`). It does **not** use `:timestamp`, so a different
  `:timestamp` behaviour on 7.25.1 can't break it. Both date formats
  (`2026-11-13` and `nov/13/2026`) work. If the year is before 2025 (clock not set
  after a reboot without NTP), the scripts do nothing rather than expire codes wrongly.

### Status page "time left" (session-time-left fix)
MikroTik's `$(session-time-left)` comes from `limit-uptime`, not the clock. On every
login, `drc-login` sets `limit-uptime = uptime so far + clock time left`, so the
countdown matches the clock again.

- **Solo:** on (1 device, so uptime adds up in a simple way).
- **Group:** **off** by default (`:local groupFix false` in `src/drc-login.rsc`).
  Group codes have `limit-uptime=0s` (no cap) and are ended by the sweeper only. Test 6
  below shows whether it's safe to switch on. If it isn't, the group status page will
  show "ends at…/stops at 1:00 AM" instead of a countdown (Phase 3).
- The sweeper always enforces the real end, whatever the countdown shows.

### 1:00 AM closing
`drc-closing` kicks every S/G device and deletes **every** S/G code (name
`^[SG][A-HJKMNP-Z2-9]{5}$`). Other users, your laptop's bypass and the panel PC are untouched.
**Safety net:** between 01:00 and 04:59 the sweeper reruns the cleanup if any S/G code
exists (e.g. the router was off at 1:00). So **don't create batches between 01:00 and 05:00**.
The panel will block that.

### Daily backup
`drc-backup` at 01:15 saves `drc-auto-<mon|tue|…>.backup` and `.rsc`. Each weekday
overwrites the one from a week ago, so the last 7 days are always kept. It writes
`drc last backup <date> <time> <name>` into the `drc-backup` scheduler's comment,
which the panel reads (read-only) to show the date.
Backups are saved **unencrypted** on the router (`dont-encrypt=yes`) so you can restore
without a separate password. They contain secrets: download them only to the
owner's PC, and don't share them.

### Panel access
- Panel PC: static lease (default `192.168.88.5`, outside the customer pool) + hotspot bypass.
- REST at `https://192.168.88.1:8443/rest/`, self-signed cert `drc-rest`. `www-ssl` only
  accepts the panel PC's IP. The `drc-panel` user also only logs in from that IP.
- Group `drc-panel` = `read,write,api,rest-api` (7.25 REST needs `api` too). No `policy`, `sensitive`, `ftp`,
  `reboot`, `ssh`, `winbox`, `web`.
- ⚠ RouterOS has no finer permission than `write`: the panel user can change config
  (not users, passwords or secrets). The IP restriction + a long random password are the
  real protection. Keep `.env` on the counter PC only.

## Install (about 15 min, do it when the café is quiet)

1. On your laptop: `node router/tools/build-scripts.mjs` (only needed if you edited `src/`).
2. Copy `04-panel-access.rsc` to `04-panel-access.local.rsc` and fill in:
   `panelMac` (counter PC's MAC, `ipconfig /all` → Physical Address, written `AA:BB:…`),
   `panelIp` (keep `192.168.88.5` unless taken) and `panelPass`
   (20+ random characters. Save it in your password manager, the panel `.env` needs it).
3. Check the hotspot's current login methods and note them:
   `/ip hotspot profile print detail where name=hsprof1`. If `login-by` has more than
   `cookie,http-chap`, add the extras to the last line of `02-profiles.rsc`.
4. Winbox → **Files** → drag in `00-backup.rsc`, `01-scripts.rsc`, `02-profiles.rsc`,
   `03-schedulers.rsc`, `04-panel-access.local.rsc`.
5. In **New Terminal**, one at a time, and read the output of each:
   ```
   /import file-name=00-backup.rsc verbose=yes
   ```
   → Download `drc-before-phase1.backup` and `.rsc` from Files to your laptop **now**.
   ```
   /import file-name=01-scripts.rsc verbose=yes
   /import file-name=03-schedulers.rsc verbose=yes
   ```
   Run tests 1–2 below **before** 02 (the profiles don't call the scripts yet, so nothing changes for customers).
   ```
   /import file-name=02-profiles.rsc verbose=yes
   /import file-name=04-panel-access.local.rsc verbose=yes
   ```
   Copy the printed certificate fingerprint for the panel's `.env` (Phase 2).
6. Delete `04-panel-access.local.rsc` from Files and from your laptop.
7. Do tests 3–9.

If an import stops with an error, nothing after that line ran. Send me the
`verbose=yes` output and I'll fix it.

## Tests

Test codes below use real code shape (`STEST2`, `GTEST2`) so the scripts treat them
like real slips. Remove them afterwards.

**1. Clock maths.**
```
{:local f [:parse [/system script get drc-epoch source]]; :put [$f]; :put [/system clock get date]; :put [/system clock get time]}
```
On your laptop, check the number:
`node -e "const [d,t]=process.argv.slice(1);console.log(Date.parse(d+'T'+t+'Z')/1000)" 2026-11-13 18:38:00`
(use the date and time the router printed). The values should match to within a few seconds.
If the first value is `0`, the clock isn't set (check NTP: `/system ntp client print`).
If you get an error or a wildly different number, send me the three lines.
Also, for information only: `:put [:timestamp]` (not used, but useful to know on 7.25.1).

**2. Sweeper runs clean.**
`/system script run drc-sweep` → no output, no error. Check `/log print where message~"drc"`.

**3. Solo clock time (5-minute code).**
```
/ip hotspot user add name=STEST2 password=STEST2 profile=solo-3h limit-uptime=5m comment="drc;dur=300;"
```
Log in on a phone with `STEST2`. Then `/ip hotspot user print detail where name=STEST2`:
comment now has `start=…;end=…;` (end − start = 300). Put the phone to sleep for 2 minutes
and log in again: comment unchanged. Within 6 minutes of the **first** login, the phone is
kicked, the user shows **X** (disabled) and the comment ends with `exp=…;`. Logging in again fails.

**4. Countdown fix (solo).** New code `STEST3`, `dur=900`, `limit-uptime=15m`. Log in, wait 3 min,
disconnect from Wi-Fi for 4 min, reconnect and log in. `/ip hotspot active print detail where user=STEST3`
→ `session-time-left` should be about **8 min** (15 − 7), not 12. If it shows ~12 on that login
but ~8 after the *next* login, RouterOS computes it before on-login runs. Tell me, and I'll handle that in Phase 3.

**5. Group: shared clock, 7 devices.**
```
/ip hotspot user add name=GTEST2 password=GTEST2 profile=group-3h limit-uptime=0s comment="drc;dur=600;"
```
Log in with 2–3 devices a few minutes apart. All are cut **together** about 10 minutes after
the **first** login. Try an 8th device on a group code if you have that many (should be refused at 7).

**6. Group countdown experiment (optional).** In `src/drc-login.rsc` set `:local groupFix true`,
rebuild, re-import `01-scripts.rsc`. New `GTEST3` with `dur=900`, `limit-uptime=15m`. Log in 2 devices.
Watch `/ip hotspot active print detail where user=GTEST3` for 5 min. **Safe** only if neither device
is cut before 15 clock minutes and `session-time-left` falls about 1 min per minute on both.
If either is cut early or the countdown drops too fast, set `groupFix false` again, rebuild and re-import.
Tell me the result.

**7. QR link.** On a phone joined to the café Wi-Fi (not logged in), open
`http://192.168.88.1/login?username=STEST4&password=STEST4` (create STEST4 like test 3).
It should log in straight away. If it lands on the login page instead, the hotspot's DNS-name
redirect is dropping the query string. Tell me, and the fix is either `dst=` handling in Phase 3
or clearing `dns-name` on hsprof1.

**8. Closing.** ⚠ **Only when no customer codes are in use** (it deletes ALL S/G codes):
`/system script run drc-closing` → test users gone, log says `drc-closing: removed N codes`.

**9. Backup.** `/system script run drc-backup` → Files shows `drc-auto-<today>.backup` and `.rsc`.
`/system scheduler print detail where name=drc-backup` → comment `drc last backup …`.

**10. Panel REST (from the counter PC, PowerShell):**
```
curl.exe -k -u drc-panel:YOURPASS https://192.168.88.1:8443/rest/system/identity
curl.exe -k -u drc-panel:YOURPASS https://192.168.88.1:8443/rest/ip/hotspot/user
curl.exe -k -u drc-panel:YOURPASS -X PUT https://192.168.88.1:8443/rest/ip/hotspot/user -H "content-type: application/json" -d "{\"name\":\"STEST5\",\"password\":\"STEST5\",\"profile\":\"solo-3h\",\"comment\":\"drc;dur=300;\"}"
```
Then remove it: get its `.id` from the list and
`curl.exe -k -u drc-panel:YOURPASS -X DELETE https://192.168.88.1:8443/rest/ip/hotspot/user/*ID`.
The same command from your laptop (another IP) must **fail**.
If the PC gets `401`/`not enough permissions` although the password is right, add
`api` to the group: `/user group set drc-panel policy=read,write,rest-api,api` and tell me.

**Clean up:** `/ip hotspot user remove [find where name~"TEST"]`.

## Still open (not router-blocking)
- Owner questions from the plan: drinks per group code, PLDT plan speed (7 × 5 Mbps per group).
- Router hardening: now in `05-hardening.rsc` (see HARDENING.md).
