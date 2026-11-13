# Phase 3 – Don Robert login page (hotspot files)

The folder **`drc-hotspot/`** is what goes on the router. Everything in it is self-contained:
CSS and JavaScript are inline, there are no fonts or links to the internet (customers have no
internet before they log in), and the only asset is `img/logo.png` (14 KB).

| File | Shown when |
|---|---|
| `login.html` | The login page: one code box. The code is sent as both username and password (CHAP, with PAP as the fallback). Lower case and spaces are cleaned up, and obviously wrong codes are caught before sending. Side-by-side layout on laptops. |
| `alogin.html` | Right after a successful login: "You're online", the code, **Start browsing** / **See time left** |
| `status.html` | Countdown ring. Switches to **Need a refill?** at 15 min left and **Your cup is empty** at 0. Never counts past 1:00 AM. |
| `logout.html` | After **Log out** |
| `error.html` | Hotspot errors |
| `errors.txt` | The wording of error messages (e.g. wrong / used-up code, group code full) |
| `redirect.html`, `rlogin.html` | Invisible 302 redirects, same behaviour as MikroTik's defaults |

**Editing:** change files in `src/`, then run `node router/hotspot/build.mjs`. It rebuilds `drc-hotspot/` and also writes
`preview/*.html` (every page with sample values: login, error, solo, group, low time, time up…) that you can open in a browser.
The build refuses to run if a `$(` sneaks into the CSS/JS, because MikroTik would treat it as a variable.

**Status page and the clock rule:**
- **Solo codes:** the countdown comes from `$(session-time-left)`, which Phase 1's login script keeps equal to the real clock time left (test 4 in APPLY.md).
- **Group codes:** with `groupFix false` (default) the router gives no countdown. The page then shows "3h · from first use · by 1:00 AM" instead of guessing. After 1:00 AM it switches to "time is up" either way.
- **What actually ends the code** is the router's minute check (`drc-sweep`), not this page.

**Changed from the design:**
- The **"2 of 7 connected"** counter and the **QR code to share a group code** aren't on the status page. The router doesn't give the page a device count. A QR generator would add ~20 KB of script to every page load. Friends type the code instead (the page says so).
- **"Scan the QR on your slip"** is a hint, not a button: a web page can't open the camera app.
- **"Wi‑Fi terms" link** left out: there's no terms text yet. Send me the wording and I'll add it.

## Install (5 min)
1. Winbox → **Files**. Drag the whole **`router/hotspot/drc-hotspot`** folder from your laptop into the file list.
   Check that Files now shows `drc-hotspot/login.html`, `…/status.html`, `…/img/logo.png` and so on.
   (If your existing hotspot files are under `flash/hotspot`, put this folder at `flash/drc-hotspot` and use that name below.)
2. Note the current folder (for rollback):
   ```
   /ip hotspot profile print detail where name=hsprof1
   ```
   `html-directory` is usually `hotspot`.
3. Switch:
   ```
   /ip hotspot profile set [find where name="hsprof1"] html-directory=drc-hotspot
   ```
   Pages are read from disk on each request, so the change is immediate. Devices already logged in aren't affected.

**Rollback:** `/ip hotspot profile set [find where name="hsprof1"] html-directory=hotspot` (or whatever step 2 showed).
**Update later:** rebuild, drag the folder in again (replace the files). No other change is needed.

## Tests: use NON-bypassed phones (Phone A / Phone B), never the admin laptop or panel PC
Make test codes in the panel (*Print slips → +20 solo / +5 group*), or by hand as in PHASE1.md test 3.

| # | Test | ✅ Pass looks like |
|---|---|---|
| P1 | 📱A joins *Don Robert Cafe - Free WiFi* | Login pops up with the dark header, logo, coffee cup and "Welcome, kape lover." The logo loads (no broken image). |
| P2 | 📱A types a solo code **in lower case with a space** (`s3k 7pw`) | Logs in. "You're online" page shows the code in capitals. **Start browsing** opens a website. |
| P3 | 📱A **See time left** | Countdown about 3:00 (less if the code was used before), and "ends h:mm AM/PM" = the end time in the panel's Look up (±1 min). After 10 PM it shows "closing 1:00 AM". |
| P4 | 📱A log out → type `S12` → then `SOOOOO` | Logged-out page → Enter a code. `S12`: "Wi‑Fi codes have 6 characters…". `SOOOOO`: "Codes never contain 0, O, 1, I or L…". Neither is sent to the router. |
| P5 | 📱A types a made-up but valid-looking code (`S2222X`) | Router answers with the red box "That code doesn't work. It may be mistyped, its time may be up…". |
| P6 | 📱B scans a slip's QR code with the camera (not logged in) | Logs in without typing, then the "You're online" page. |
| P7 | 📱A + 📱B on one **group** code | Both online. The status page shows "Group code · up to 7 devices" and "3h · from first use". |
| P8 | Code with 20 min left (`dur=1200` test code) | At ≤ 15 min the status page turns amber, "Almost up" + **Need a refill?**. At 0 it shows **Your cup is empty**, and within 1 min the phone is offline (router). |
| P9 | A **used-up** code typed again | The red box with the "doesn't work … time may be up" message. |
| P10 | Any non-bypassed **laptop** | Side-by-side layout: dark left with the 3 steps, code box on the right. Login works the same. |
| P11 | **Android** and **iPhone** pop-up (captive portal window) | The page fits without zooming. The keyboard opens in capitals. After login the pop-up offers **Done** / closes, and the browser works. |

If something fails, send me a photo of the phone screen and the output of
`/log print where topics~"hotspot"` (last ~20 lines).
