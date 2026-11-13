# Router hardening (05-hardening.rsc)

Goal: a customer on "Don Robert Cafe - Free WiFi" can reach the internet and the
login page, and nothing else: not the router's admin, not other customers, not the
counter PC's panel.

## What it changes and why

| # | Change | Why |
|---|---|---|
| 1 | **Static DHCP leases** for the admin laptop and panel PC, made from their **current** address | The address limits below are by IP. The script refuses to continue unless each device has a *bound* lease where the reserved address equals the address in use, so you can't lock yourself out by a lease that hasn't renewed yet. |
| 2 | Address list `drc-admin` = laptop + panel PC | One list used by the firewall rule in step 6. |
| 3 | `/ip service`: **telnet, ftp, api off**. **winbox, ssh, www, www-ssl, api-ssl** only from the two IPs. proxy, socks, UPnP, SMB, SNMP, bandwidth-test server, RoMON off (if present). SSH strong crypto. | Logged-in customers are on the same LAN as the router. Default firewall trusts the LAN. |
| 4 | **MAC-Telnet, MAC-Winbox, MAC-ping off**. **Neighbor discovery off** | MAC access works at layer 2 and skips the hotspot and IP rules. Any phone with a Winbox app could otherwise see and try to log in to the router before even entering a code. Discovery is what makes the router show up in those apps. |
| 5a | `datapath.client-isolation=yes` on wifi1 and wifi2 | The radio stops passing frames between its own clients (phone ↔ phone on the same band). |
| 5b | Bridge **horizon=1** on wifi1 and wifi2 | Ports with the same horizon don't forward to each other, so a 2.4 GHz client can't reach a 5 GHz client through the bridge. Ethernet ports have no horizon, so the panel PC on ether2 still works normally. |
| 5c | Firewall `forward` drop for bridge → bridge | Closes the last path: asking the router to *route* to another client in 192.168.88.0/24. Internet traffic (bridge → ether1) is unaffected. |
| 6 | Firewall `input` drop for TCP 21, 22, 23, 443, 8291, 8728, 8729 unless from `drc-admin` | Second layer behind step 3, in case a service gets re-enabled later. Port 80 isn't touched because the hotspot login page needs it. |

**Isolation choice:** client-isolation + horizon is done in the Wi-Fi driver and bridge,
needs no per-device rules and keeps working as devices come and go. Bridge firewall
rules (`use-ip-firewall`) would also work, but every customer packet would pass
through the CPU filter, which is slower, and they're easier to get wrong with the hotspot.

**Effect on you:**
- Winbox/WebFig/SSH only from the laptop and panel PC, by IP (not MAC Winbox).
- The laptop and panel PC still talk to each other if one is on Ethernet. If both are on
  Wi-Fi on different bands, they can't (horizon), which isn't needed for the panel anyway.
- **Windows random MAC must be OFF** on both PCs (Settings → Network → Wi-Fi →
  *Random hardware addresses* → Off, for this network). Otherwise the lease, the hotspot
  bypass and the IP rules don't recognise the PC. A cable for the panel PC avoids this entirely.

## Panel PC static lease: confirmed
- `04-panel-access.rsc` creates a **static lease by MAC** at `192.168.88.5` (outside the
  customer pool .10–.254), plus the hotspot bypass. After importing it, run on the panel PC:
  `ipconfig /release` then `ipconfig /renew`, and check `ipconfig` shows 192.168.88.5.
- `05-hardening.rsc` checks it again: it stops with an error unless the panel PC's lease
  is **bound** at its reserved address.

## Applying in Safe Mode
Safe Mode = RouterOS remembers every change, and **undoes them all** if your session
drops before you leave Safe Mode. So if hardening locks you out, it rolls itself back.

1. Upload `05-hardening.local.rsc` (filled-in copy) to Files.
2. In Winbox: **New Terminal**. Press **Ctrl+X**. The prompt shows `<SAFE>`.
3. `/import file-name=05-hardening.local.rsc verbose=yes`
4. **Leave this terminal open.** Do checks H1–H8 (APPLY.md) from *other* windows/devices.
5. All pass → in the same terminal press **Ctrl+X** again. Changes are kept.
   Something's wrong → **Ctrl+D** (or close Winbox): everything since step 2 is undone.

Notes:
- If the session dies (Wi-Fi drop, laptop sleeps), RouterOS reverts. Detection can take
  a few minutes, so wait up to ~10 min before reconnecting.
- Safe Mode holds up to ~100 changes. This file makes far fewer, but don't run other
  big imports in the same Safe Mode session.
- The file saves `drc-before-hardening.backup` and `.rsc` first. **Download both** right after.

## If you get locked out
Try in this order:
1. **Wait ~10 min** if you were in Safe Mode, because it reverts by itself. Then reconnect.
2. **Use the other allowed device.** Winbox from the panel PC (or the laptop) by IP `192.168.88.1`.
3. **Your IP changed?** Plug the laptop into ether2–4 with the same MAC (Wi-Fi random MAC
   off), and it gets its static lease again.
4. **Reset and restore** (last resort, needs the downloaded backup):
   1. Unplug power. Hold the **reset button**, plug power in, keep holding until the
      user LED starts flashing (~5 s), release. The router comes up with MikroTik's default config.
   2. Cable the laptop to **ether2**. In Winbox → Neighbors, connect by **MAC** as `admin`
      (password on the sticker / empty, depending on the device).
   3. Files → drag in `drc-before-hardening.backup` (or `drc-before-phase1.backup` /
      `donrobert-working.backup`) → select → **Restore**. The router reboots with that config.
   4. If restoring `drc-before-hardening`, you're back to before hardening. Fix the MACs and try again.
5. **Netinstall** (router won't boot or reset doesn't work): MikroTik Netinstall + RouterOS
   7.25.1 package, then restore the backup as in step 4.

## Undo hardening without a reset
```
/ip service set winbox address=""
/ip service set ssh address=""
/ip service set www address=""
/ip service set www-ssl address=""
/ip service set api-ssl address=""
/tool mac-server set allowed-interface-list=all
/tool mac-server mac-winbox set allowed-interface-list=all
/ip neighbor discovery-settings set discover-interface-list=LAN
/ip firewall filter remove [find where comment~"^drc: "]
/ip firewall address-list remove [find where list="drc-admin"]
/interface bridge port set [find where interface~"^wifi"] horizon=none
/interface wifi set [find] datapath.client-isolation=no
```
After that, set `www-ssl` back to the panel PC only: `/ip service set www-ssl address=192.168.88.5/32`.
Services turned off (telnet, ftp, api…) can stay off. The exact old values are in
`drc-before-hardening.rsc` if you want them back. The static leases can stay.
