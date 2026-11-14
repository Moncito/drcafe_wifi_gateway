# drc-closing: 1:00 AM. Disconnect every S/G device and delete the S/G codes that
# were used (comment has start=) or are disabled. Unused codes carry over to the next
# days; the panel deletes them when they reach their validity (30 days).
# Other hotspot users and ip-bindings are untouched.
:local re "^[SG][A-HJKMNP-Z2-9]{5}\$"
# After a power cut the clock is wrong until NTP syncs (see drc-epoch): never
# clean up on a guessed time. drc-sweep runs this again once the clock is right.
:local st ""
:do { :set st [:tostr [/system ntp client get status]] } on-error={}
:if ($st != "synchronized") do={ :log warning "drc-closing: clock not synced yet, skipped"; :return "" }
:local used [/ip hotspot user find where name~$re && (comment~"start=" || disabled=yes)]
:local n [:len $used]
/ip hotspot active remove [find where user~$re]
/ip hotspot cookie remove [find where user~$re]
/ip hotspot user remove $used
:if ($n > 0) do={ :log info ("drc-closing: removed " . $n . " used codes; unused slips carry over") }
