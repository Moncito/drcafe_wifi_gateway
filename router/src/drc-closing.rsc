# drc-closing: 1:00 AM. Disconnect every S/G device and delete every S/G code
# (used, unused, expired, void). Other hotspot users and ip-bindings are untouched.
:local re "^[SG][A-HJKMNP-Z2-9]{5}\$"
# After a power cut the clock is wrong until NTP syncs (see drc-epoch): never
# clean up on a guessed time. drc-sweep runs this again once the clock is right.
:local st ""
:do { :set st [:tostr [/system ntp client get status]] } on-error={}
:if ($st != "synchronized") do={ :log warning "drc-closing: clock not synced yet, skipped"; :return "" }
:local n [:len [/ip hotspot user find where name~$re]]
/ip hotspot active remove [find where user~$re]
/ip hotspot cookie remove [find where user~$re]
/ip hotspot user remove [find where name~$re]
:log info ("drc-closing: removed " . $n . " codes")
