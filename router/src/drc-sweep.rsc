# drc-sweep: runs every minute.
# - Codes whose clock time is over: disable, kick all devices, drop cookies.
# - Closed window 01:00-04:59: if any S/G codes exist (e.g. the router was off
#   at 1:00 AM), run the closing cleanup. Batches are only made from 05:00.
#@include _common.rsc
:local now [$epoch]
:if ($now = 0) do={ :return "" }
:local t [:tostr [/system clock get time]]
:local hh [:tonum [:pick $t 0 2]]
:if ([:pick $t 0 1] = "0") do={ :set hh [:tonum [:pick $t 1 2]] }
# Late night: while a scheduler named drc-late-close exists, closing is 03:00 not 01:00
:local closeH 1
:if ([:len [/system scheduler find where name="drc-late-close"]] > 0) do={ :set closeH 3 }
:if (($hh >= $closeH) && ($hh < 5)) do={
  :if ([:len [/ip hotspot user find where name~$re]] > 0) do={ /system script run drc-closing }
  :return ""
}
:foreach id in=[/ip hotspot user find where name~$re && disabled=no && comment~";end="] do={
  :local c [:tostr [/ip hotspot user get $id comment]]
  :local e [:tonum [$getf $c "end"]]
  :if ($now >= $e) do={
    :local n [/ip hotspot user get $id name]
    /ip hotspot user set $id disabled=yes comment=($c . "exp=" . $now . ";")
    /ip hotspot active remove [find where user=$n]
    /ip hotspot cookie remove [find where user=$n]
    :log info ("drc-sweep: " . $n . " clock time over, disabled")
  }
}
