# Apply order and pass checklist

Do it on a quiet day (before opening is best). About 1 hour including tests.
Details of each test are in PHASE1.md. Hardening details and lock-out recovery are in HARDENING.md.
Stop at the first ❌ and send me the terminal output.

## Devices you need
| Device | Used for | Must be |
|---|---|---|
| **Laptop** | Winbox, imports | Your admin laptop (bypassed, so it never sees the login page) |
| **Panel PC** | Test 10, H2 | Counter PC on the café LAN (bypassed after step 6) |
| **Phone A** | Hotspot tests 3–7, H3, H4, H5, H7 | **NOT bypassed**: a normal customer phone, joined to *Don Robert Cafe - Free WiFi*. Forget the network first so it starts clean. Wi-Fi **Private/random MAC can stay on** (customers have it on too). |
| **Phone B** | Second device for tests 5–6, H5 | **NOT bypassed**, a second customer phone |

🚫 Never use the laptop or panel PC for hotspot tests: they're bypassed and skip the login page, so a "pass" on them means nothing.

## 0. Prepare (laptop, no router changes)
- [ ] Panel PC and laptop: Wi-Fi **Random hardware addresses = Off** for the café network (or use a cable).
- [ ] Panel PC: Windows network profile = **Public** (Settings → Network & internet → Wi-Fi or Ethernet → the café network → *Network profile type: Public*). It shares the LAN with customer devices. Public turns off network discovery and file/printer sharing, and makes Windows Firewall block incoming connections.
- [ ] Note both MACs (`ipconfig /all` → Physical Address, write as `AA:BB:CC:DD:EE:FF`).
- [ ] `04-panel-access.rsc` → `04-panel-access.local.rsc`: panelMac, panelIp (192.168.88.5), panelPass (20+ random chars, in your password manager).
- [ ] `05-hardening.rsc` → `05-hardening.local.rsc`: laptopMac, panelMac. Check `wifi1`/`wifi2`/`bridge` names match `/interface wifi print` and `/interface bridge print`.
- [ ] Router: `/ip hotspot profile print detail where name=hsprof1` → note `login-by`. If it has more than `cookie,http-chap`, add the extras to the last line of `02-profiles.rsc`.
- [ ] Winbox → Files: drag in `00`, `01`, `02`, `03`, `04-…local`, `05-…local`.

## 1. Backup
```
/import file-name=00-backup.rsc verbose=yes
```
✅ Pass: Files lists `drc-before-phase1.backup` and `drc-before-phase1.rsc`, **and both are downloaded to your laptop**.

## 2. Scripts + timers (customers not affected yet)
```
/import file-name=01-scripts.rsc verbose=yes
/import file-name=03-schedulers.rsc verbose=yes
```
✅ Pass: no error lines. `/system script print where name~"drc"` → 5 scripts (drc-epoch, drc-backup, drc-closing, drc-login, drc-sweep). `/system scheduler print where name~"drc"` → 3 (drc-sweep 1m, drc-closing 01:00, drc-backup 01:15). `/system ntp client print` → enabled, status *synchronized* (may take a minute).

## 3. Tests 1–2
| Test | ✅ Pass looks like |
|---|---|
| 1 Clock maths | First number is not 0. It matches the laptop's `node -e …` result for the printed date+time to within a few seconds. |
| 2 Sweeper | `/system script run drc-sweep` prints nothing. `/log print where message~"drc"` has no errors. |

## 4. Profiles (customers now go through drc-login)
```
/import file-name=02-profiles.rsc verbose=yes
```
✅ Pass: `/ip hotspot user profile print detail` → `solo-3h` shared-users=1 and `group-3h` shared-users=7, both with the on-login line. No `group3-3h` left. `/ip hotspot profile print detail where name=hsprof1` → login-by includes `http-pap` and `mac-cookie`. A real customer code still logs in.

## 5. Tests 3–7
| Test | ✅ Pass looks like |
|---|---|
| 3 Solo clock (STEST2, 5 min) · 📱 **Phone A** | After first login the comment shows `start=…;end=…;` with end − start = 300. Re-login after sleeping doesn't change it. ≤ 6 min after the first login: phone kicked, user disabled (X), comment ends `exp=…;`, a new login is refused. Log: `drc-login: first login STEST2` and `drc-sweep: STEST2 clock time over`. |
| 4 Countdown (STEST3, 15 min) · 📱 **Phone A** | After 3 min online + 4 min off, re-login: `session-time-left` ≈ 8 min (±1). *Partial pass:* ~12 min on that login and ~8 after the next one. Tell me, it's handled in Phase 3. |
| 5 Group clock (GTEST2, 10 min) · 📱 **Phone A + B** (+ more for the 8-device check) | All devices (logged in minutes apart) are cut within the same minute, ~10 min after the **first** login. An 8th simultaneous device is refused. |
| 6 Group countdown (optional) · 📱 **Phone A + B** | Only if you try `groupFix true`: neither device cut before 15 clock minutes, and `session-time-left` drops ~1 min per minute on both. Anything else: back to `false` and tell me. |
| 7 QR link · 📱 **Phone A** | `http://192.168.88.1/login?username=STEST4&password=STEST4` on a not-logged-in phone → straight to "logged in"/status, no code typed. *Fail:* lands on the login page with an empty field. Tell me. |

## 6. Panel connection (cloud)
The panel is a website (panel/DEPLOY.md). The router **checks in** to it every 20 s with the
script `drc-cloud-sync` and a secret key kept in the router script `drc-cloud-config`.
Nothing on the router is opened for the panel. (`04-panel-access.rsc` was for the earlier
PC-only panel and is no longer used.)

✅ Pass: Settings in the panel shows the router as *Checking in*. `/log print where message~"drc-cloud-sync"` shows no warnings.

## 7. Hardening (in Safe Mode)
New Terminal → **Ctrl+X** (prompt shows `<SAFE>`) →
```
/import file-name=05-hardening.local.rsc verbose=yes
```
Keep that terminal open. Do H1–H8 from other windows/devices:

| Check | ✅ Pass looks like |
|---|---|
| H1 Laptop admin · 💻 laptop | A **new** Winbox window from the laptop connects to `192.168.88.1` by IP. |
| H2 Panel PC REST · 🖥 panel PC | Test 10 `identity` curl from the panel PC still works. |
| H3 Customer can't reach admin · 📱 **Phone A** | Phone logged in with a code: `https://192.168.88.1` and `http://192.168.88.1:8291` in the browser don't load. A Winbox/MikroTik app on the phone shows **no** neighbors and can't connect. |
| H4 Hotspot still works · 📱 **Phone A** (log out first, or forget + rejoin the network) | Phone A, not logged in: login page pops up, a code logs in, the status page shows. The QR link (test 7) still works. |
| H5 Customers isolated · 📱 **Phone A + Phone B** | Two phones logged in (try same band, then one on 2.4 and one on 5 GHz): a ping or network-scan app (e.g. Fing) on phone A doesn't see or ping phone B. It only sees 192.168.88.1. |
| H6 Settings applied | `/interface wifi print detail where name~"wifi"` shows client-isolation=yes (if the import printed a WARNING, tell me). `/interface bridge port print where interface~"wifi"` shows horizon=1. `/ip firewall filter print where comment~"drc"` shows 2 rules. `/ip service print` shows telnet/ftp/api disabled and the others limited to the two IPs. |
| H7 Internet speed · 📱 **Phone A** | A logged-in phone browses normally. A speed test shows ~5 Mbps. |
| H8 Static leases | `/ip dhcp-server lease print where comment~"DRC"` shows 2 static, bound leases (laptop + panel PC). |

✅ All pass → **Ctrl+X** in the Safe Mode terminal (commit). Download `drc-before-hardening.backup` + `.rsc`.
❌ Any fail → **Ctrl+D** / close Winbox (auto-undo), send me the output.

## 8. Closing + backup (when no customer codes are in use)
Either run them by hand **before opening** (test 8 deletes ALL S/G codes):
```
/system script run drc-closing
/system script run drc-backup
```
…or let them run overnight and check the next morning.

✅ Pass: log `drc-closing: removed N codes`. `/ip hotspot user print` has no S/G codes left. Files has `drc-auto-<day>.backup` + `.rsc`. `/system scheduler print detail where name=drc-backup` comment = `drc last backup <date> <time> drc-auto-<day>`.

## 9. Clean up
- [ ] `/ip hotspot user remove [find where name~"TEST"]`
- [ ] Delete `04-panel-access.local.rsc` and `05-hardening.local.rsc` from router Files **and** your laptop.
- [ ] Keep these off the router, somewhere safe: `drc-before-phase1.*`, `drc-before-hardening.*`. The panel password goes in your password manager.

## 10. Switch off the old PLDT "Customer" SSID
Only after steps 1–9 pass and the new Wi-Fi has run fine for at least one busy shift.
Staff Wi-Fi (*Don Robert Cafe - Admin*) is **not** touched.

Before switching off, check that **nothing** uses *Don Robert Cafe - Customer (2.4G)*:
- [ ] POS terminal(s): Wi-Fi settings → connected network name.
- [ ] Receipt / kitchen printers: print the printer's network/config page (usually hold FEED at power-on) → SSID.
- [ ] Card terminal, CCTV/DVR, smart TV/music player, staff phones, owner's devices.
- [ ] PLDT modem admin page → connected devices / DHCP clients on the 2.4G Customer SSID: note every device still on it and identify each one.

Anything found → move it to the **Admin** SSID first (not to the MikroTik customer Wi-Fi: it would hit the login page and the 3-hour limit) and check it works.
Then, in the PLDT modem admin page: WLAN → *Don Robert Cafe - Customer* → **Disable** (don't delete, so it can be re-enabled in a minute if something breaks).

✅ Pass: the SSID no longer shows on a phone's Wi-Fi list. POS, printers and payments work through a full shift. Customers only see *Don Robert Cafe - Free WiFi*. Update the PDF's network table to "turned off <date>".

## 11. First real batch (needs the Phase 2 panel)
On the panel PC, after 05:00 (closed window is 01:00–05:00):
1. Log in to the panel as owner → **Print slips** → today's date, 150 S + 30 G → **Create codes & print**.
2. Print the 4 A4 pages (scale 100%, "Fit to page" OFF).
3. Laptop Winbox: `/ip hotspot user print count-only where name~"^[SG]"` → **180**.
4. Cut one solo and one group slip. 📱 **Phone A** (not bypassed, not logged in): open the camera, scan the solo slip's QR, tap the link.
5. 📱 **Phone B**: type the group slip's code by hand on the login page.

✅ Pass:
- Panel shows the batch as *On router · printed*, 180 codes, serials S-001–S-150 and G-001–G-030.
- Router count = 180.
- Print: grid lines up with the dashed cut lines and nothing is clipped at the page edges. Codes are readable and QR codes are sharp.
- Phone A logs in straight from the QR, without typing.
- Phone B logs in with the typed group code.
- Within 1 minute both slips show **Active** with a first-login time on the panel's Look up screen, and 2 devices online on Today.
- `/ip hotspot user print detail where name=<that code>` comment has `start=…;end=…;`.

Hand those two slips' codes to no one. Void them from the panel (Look up → Void this code) so they aren't reused, and check they leave the router.

## 12. Don Robert login page (Phase 3)
Can be done any time after step 4. Follow **router/hotspot/PHASE3.md**: drag `router/hotspot/drc-hotspot` into Winbox Files, then
```
/ip hotspot profile set [find where name="hsprof1"] html-directory=drc-hotspot
```
✅ Pass: tests P1–P11 in PHASE3.md, all on 📱 **non-bypassed phones** (plus one non-bypassed laptop for P10).
Rollback: `/ip hotspot profile set [find where name="hsprof1"] html-directory=hotspot`.
