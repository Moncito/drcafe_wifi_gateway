# drc-closing: 1:00 AM. Disconnect every S/G device and delete every S/G code
# (used, unused, expired, void). Other hotspot users and ip-bindings are untouched.
:local re "^[SG][A-HJKMNP-Z2-9]{5}\$"
:local n [:len [/ip hotspot user find where name~$re]]
/ip hotspot active remove [find where user~$re]
/ip hotspot cookie remove [find where user~$re]
/ip hotspot user remove [find where name~$re]
:log info ("drc-closing: removed " . $n . " codes")
