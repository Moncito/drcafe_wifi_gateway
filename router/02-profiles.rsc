# 02-profiles.rsc - code profiles + login methods. Needs 01-scripts.rsc first.
# - group3-3h is renamed group-3h and allows 7 devices at once
# - both profiles call drc-login on every login (clock-time stamp + checks)
# - hsprof1 accepts http-pap so the QR link with ?username=&password= logs in
# Safe to re-import.

# Rename the group profile (only if the old name still exists)
:if ([:len [/ip hotspot user profile find where name="group3-3h"]] > 0) do={
  /ip hotspot user profile set [find where name="group3-3h"] name=group-3h
}

/ip hotspot user profile set [find where name="group-3h"] shared-users=7 \
    on-login=":local f [:parse [/system script get drc-login source]]; \$f user=\$user"
/ip hotspot user profile set [find where name="solo-3h"] shared-users=1 \
    on-login=":local f [:parse [/system script get drc-login source]]; \$f user=\$user"

# Group codes: uptime adds up per device, so a 3h uptime cap would run out early
# with several devices. The clock rule (drc-sweep) ends group codes instead.
/ip hotspot user set [find where name~"^G[A-HJKMNP-Z2-9]{5}\$"] limit-uptime=0s

# Login methods. CHECK FIRST with:  /ip hotspot profile print detail where name=hsprof1
# If login-by shows more than cookie,http-chap (e.g. trial), add it below before importing.
#   http-pap   = the QR link (?username=&password=) logs in
#   mac-cookie = a phone that slept / dropped Wi-Fi gets back in silently while its
#                code still has time (no login page, no Safari). drc-login still runs on
#                every such login, and expired codes are disabled, so it can't extend time.
/ip hotspot profile set [find where name="hsprof1"] login-by=cookie,http-chap,http-pap,mac-cookie

:put "02-profiles done: group-3h = 7 devices, on-login set, http-pap enabled."
