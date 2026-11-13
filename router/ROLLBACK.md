# Rollback – Phase 1

## Full restore (everything back to before Phase 1)
The router reboots and loses everything done since the backup, **including today's codes**.
```
/system backup load name=drc-before-phase1.backup
```
If that file is gone from the router, drag your saved copy into Winbox → Files first.
Older known-good: `donrobert-working.backup`.
If a backup won't load (e.g. different RouterOS version), use the readable export:
reset with no default config, then `/import file-name=drc-before-phase1.rsc`.

## Partial undo (no reboot), run in this order

Stop the timers and on-login hook first, so nothing acts on codes:
```
/system scheduler remove [find where name~"^drc-"]
/ip hotspot user profile set [find where name="solo-3h"] on-login=""
/ip hotspot user profile set [find where name="group-3h"] on-login="" shared-users=3 name=group3-3h
```
Re-enable codes the sweeper disabled, and give group codes their uptime cap back (optional):
```
/ip hotspot user set [find where name~"^[SG][A-HJKMNP-Z2-9]{5}\$"] disabled=no
/ip hotspot user set [find where name~"^G[A-HJKMNP-Z2-9]{5}\$"] limit-uptime=3h
```
Remove the scripts:
```
/system script remove [find where name~"^drc-"]
```
Login methods back (use what you noted in install step 3). This removes http-pap and mac-cookie:
```
/ip hotspot profile set [find where name="hsprof1"] login-by=cookie,http-chap
```
Panel access (replace the MAC with the panel PC's):
```
/user remove [find where name="drc-panel"]
/user group remove [find where name="drc-panel"]
/ip service set www-ssl disabled=yes address="" certificate=none
/certificate remove [find where name="drc-rest" or name="drc-ca"]
/ip hotspot ip-binding remove [find where comment="DRC panel PC"]
/ip dhcp-server lease remove [find where comment="DRC panel PC"]
```
If `www-ssl` was already enabled before Phase 1 (check `drc-before-phase1.rsc` →
`/ip service`), set it back to what it was instead of disabling it.

NTP was only switched on. Leave it (harmless), or `/system ntp client set enabled=no`.
Auto backups `drc-auto-*` can stay or be deleted in Files.
