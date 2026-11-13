# drc-login: called from the on-login of hotspot user profiles solo-3h and group-3h:
#   :local f [:parse [/system script get drc-login source]]; $f user=$user
# 1) First login of a code: stamp start/end into its comment (clock time starts now).
# 2) Every login: if the code is past its end, disable it and kick it.
# 3) Session-time-left fix: set limit-uptime = uptime so far + clock time left,
#    so the status page countdown matches the clock. Solo always; group only if
#    groupFix is true (turn on only after the group test in PHASE1.md passes).
:local groupFix false
#@include _common.rsc
:local u [:tostr $user]
:if (!($u ~ $re)) do={ :return "" }
:local now [$epoch]
:if ($now = 0) do={ :log warning "drc-login: clock not set, skipping"; :return "" }
:local id [/ip hotspot user find where name=$u]
:if ([:len $id] = 0) do={ :return "" }
:local c [:tostr [/ip hotspot user get $id comment]]
:local endv [$getf $c "end"]
:if ($endv = "") do={
  :local dur [$getf $c "dur"]
  :if ($dur = "") do={ :set dur 10800 } else={ :set dur [:tonum $dur] }
  :set endv ($now + $dur)
  :if ([:pick $c 0 4] != "drc;") do={ :set c ("drc;" . $c) }
  :set c ($c . "start=" . $now . ";end=" . $endv . ";")
  /ip hotspot user set $id comment=$c
  :log info ("drc-login: first login " . $u . ", " . $dur . "s of clock time")
} else={
  :set endv [:tonum $endv]
}
:local left ($endv - $now)
:if ($left <= 0) do={
  /ip hotspot user set $id disabled=yes
  /ip hotspot active remove [find where user=$u]
  :log info ("drc-login: " . $u . " already past its end, kicked")
  :return ""
}
:if (([:pick $u 0 1] = "S") || $groupFix) do={
  :local up [/ip hotspot user get $id uptime]
  /ip hotspot user set $id limit-uptime=($up + [:totime ($left . "s")])
}
