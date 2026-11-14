# drc-epoch: returns the router's LOCAL clock (Asia/Manila) as seconds since
# 1970-01-01 00:00, i.e. Manila wall time counted as if it were UTC.
# Only used for differences (start/end of a code), so the offset does not matter.
# Returns 0 when the clock is clearly not set (year before 2025).
# Also returns 0 while NTP is not synchronized: this router has no battery
# clock, so after a power cut it starts with an old saved time (seen: 20 hours
# behind for 25 minutes). Trusting that could expire codes early or run the
# 1 AM cleanup in the afternoon.
:local st ""
:do { :set st [:tostr [/system ntp client get status]] } on-error={}
:if ($st != "synchronized") do={ :return 0 }
# Built only from /system clock date+time, so it does not depend on :timestamp.
# Handles both date formats: "2026-11-13" (RouterOS 7.10+) and "nov/13/2026".
:local strip do={
  :if ([:pick $1 0 1] = "0") do={ :return [:tonum [:pick $1 1 [:len $1]]] }
  :return [:tonum $1]
}
:local d [:tostr [/system clock get date]]
:local t [:tostr [/system clock get time]]
:local y 0
:local m 0
:local dd 0
:if ([:pick $d 4 5] = "-") do={
  :set y [:tonum [:pick $d 0 4]]
  :set m [$strip [:pick $d 5 7]]
  :set dd [$strip [:pick $d 8 10]]
} else={
  :local months {"jan";"feb";"mar";"apr";"may";"jun";"jul";"aug";"sep";"oct";"nov";"dec"}
  :set m ([:find $months [:pick $d 0 3]] + 1)
  :set dd [$strip [:pick $d 4 6]]
  :set y [:tonum [:pick $d 7 11]]
}
:if ($y < 2025) do={ :return 0 }
:local hh [$strip [:pick $t 0 2]]
:local mi [$strip [:pick $t 3 5]]
:local ss [$strip [:pick $t 6 8]]
# days since 1970-01-01 (civil-from-days algorithm, integer maths only)
:if ($m <= 2) do={ :set y ($y - 1) }
:local era ($y / 400)
:local yoe ($y - ($era * 400))
:local mp 0
:if ($m > 2) do={ :set mp ($m - 3) } else={ :set mp ($m + 9) }
:local doy ((((153 * $mp) + 2) / 5) + ($dd - 1))
:local doe (((($yoe * 365) + ($yoe / 4)) - ($yoe / 100)) + $doy)
:local days ((($era * 146097) + $doe) - 719468)
:return ((($days * 86400) + ($hh * 3600)) + (($mi * 60) + $ss))
