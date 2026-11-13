# drc-cloud-sync: runs every 20 s (scheduler drc-cloud-sync).
# Reports the cafe codes and devices online to the panel, then runs the work the
# panel answers: add new codes, delete voided ones, disconnect devices.
# Only outgoing HTTPS: nothing on the router is opened to the internet.
# The panel address and secret key are NOT in this script. They are in the
# script "drc-cloud-config", whose source is one line:  https://PANEL/api/router/sync|KEY
:local re "^[SG][A-HJKMNP-Z2-9]{5}\$"
:local nl "\n"
# Never run twice at the same time. But a run can get stuck forever (e.g. a call
# that hangs when the internet line drops). If an older run has been busy for
# 3 check-ins (~1 minute), stop it and carry on, so check-ins always recover.
:global drcSyncBusy
:if ([:typeof $drcSyncBusy] != "num") do={ :set drcSyncBusy 0 }
:local myJob [:pick [/system script job find where script="drc-cloud-sync"] ([:len [/system script job find where script="drc-cloud-sync"]] - 1)]
:if ([:len [/system script job find where script="drc-cloud-sync"]] > 1) do={
  :set drcSyncBusy ($drcSyncBusy + 1)
  :if ($drcSyncBusy < 3) do={ :error "drc-cloud-sync: previous run still busy" }
  :foreach j in=[/system script job find where script="drc-cloud-sync"] do={
    :if ($j != $myJob) do={ /system script job remove $j }
  }
  :log warning "drc-cloud-sync: an earlier check-in was stuck and has been stopped"
}
:set drcSyncBusy 0
:local cfgId [/system script find where name="drc-cloud-config"]
:if ([:len $cfgId] = 0) do={ :error "drc-cloud-sync: script drc-cloud-config is missing" }
:local cfgS [:tostr [/system script get $cfgId source]]
:local bar [:find $cfgS "|"]
:if ([:typeof $bar] = "nil") do={ :error "drc-cloud-sync: drc-cloud-config must be URL|KEY" }
:local url [:pick $cfgS 0 $bar]
:local key [:pick $cfgS ($bar + 1) [:len $cfgS]]
:local okKey ""
:for i from=0 to=([:len $key] - 1) do={
  :local ch [:pick $key $i ($i + 1)]
  :if (($ch != "\r") && ($ch != "\n") && ($ch != " ")) do={ :set okKey ($okKey . $ch) }
}
# fld <line> <n>: the n-th "|" separated field (0 = first)
:local fld do={
  :local rest $1
  :local i 0
  :while ($i < $2) do={
    :local b [:find $rest "|"]
    :if ([:typeof $b] = "nil") do={ :return "" }
    :set rest [:pick $rest ($b + 1) [:len $rest]]
    :set i ($i + 1)
  }
  :local b [:find $rest "|"]
  :if ([:typeof $b] = "nil") do={ :return $rest }
  :return [:pick $rest 0 $b]
}
# ---- report ------------------------------------------------------------------
:local bc ""
:do { :set bc [/system scheduler get [find where name="drc-backup"] comment] } on-error={}
:local gd ""
:do { :set gd [/ip hotspot user profile get [find where name="group-3h"] shared-users] } on-error={}
:local rl ""
:do { :set rl [/ip hotspot user profile get [find where name="solo-3h"] rate-limit] } on-error={}
:local it ""
:do { :set it [/ip hotspot get [:pick [/ip hotspot find] 0] idle-timeout] } on-error={}
:local body ("v1" . $nl . "i|" . [/system identity get name] . "|" . [/system resource get board-name] . "|" . [/system resource get version] . "|" . $bc . "|" . $gd . "|" . $rl . "|" . $it . $nl)
:foreach id in=[/ip hotspot user find where name~$re] do={
  :local c [:tostr [/ip hotspot user get $id comment]]
  :if ([:typeof [:find $c "start="]] = "nil") do={ :set c "" }
  :local d "0"
  :if ([/ip hotspot user get $id disabled]) do={ :set d "1" }
  :set body ($body . "u|" . [/ip hotspot user get $id name] . "|" . $d . "|" . $c . $nl)
}
:foreach id in=[/ip hotspot active find where user~$re] do={
  :local m [:tostr [/ip hotspot active get $id mac-address]]
  :local tl ""
  :do { :set tl [:tostr [/ip hotspot active get $id session-time-left]] } on-error={}
  :local hn ""
  :do { :set hn [:tostr [/ip dhcp-server lease get [:pick [/ip dhcp-server lease find where mac-address=$m] 0] host-name]] } on-error={}
  :set body ($body . "a|" . [/ip hotspot active get $id user] . "|" . [:tostr [/ip hotspot active get $id address]] . "|" . $m . "|" . [:tostr [/ip hotspot active get $id uptime]] . "|" . $tl . "|" . $hn . $nl)
}
# ---- send, read the answer ------------------------------------------------------
:local data ""
:local hdr ("Authorization: Bearer " . $okKey . ",Content-Type: text/plain")
:onerror err in={
  :local r
  # https (the cloud): the panel's certificate is always checked. http: local testing only.
  :if ([:pick $url 0 8] = "https://") do={
    :set r [/tool fetch url=$url http-method=post http-data=$body http-header-field=$hdr check-certificate=yes output=user as-value]
  } else={
    :set r [/tool fetch url=$url http-method=post http-data=$body http-header-field=$hdr output=user as-value]
  }
  :set data ($r->"data")
} do={ :log warning ("drc-cloud-sync: panel not reachable: " . $err) }
:if ([:pick $data 0 2] != "ok") do={
  :if ([:len $data] > 0) do={ :log warning ("drc-cloud-sync: panel answered " . [:pick $data 0 80]) }
} else={
  :local added 0
  :local removed 0
  :local kicked 0
  :local rest $data
  :while ([:len $rest] > 0) do={
    :local e [:find $rest $nl]
    :if ([:typeof $e] = "nil") do={ :set e [:len $rest] }
    :local line [:pick $rest 0 $e]
    :set rest [:pick $rest ($e + 1) [:len $rest]]
    :local k [$fld $line 0]
    :local n [$fld $line 1]
    :if ($n ~ $re) do={
      :if ($k = "add") do={
        :if ([:len [/ip hotspot user find where name=$n]] = 0) do={
          :do {
            /ip hotspot user add name=$n password=$n profile=[$fld $line 2] limit-uptime=[$fld $line 3] comment=[$fld $line 4]
            :set added ($added + 1)
          } on-error={ :log warning ("drc-cloud-sync: could not add " . $n) }
        }
      }
      :if ($k = "del") do={
        /ip hotspot active remove [find where user=$n]
        /ip hotspot cookie remove [find where user=$n]
        /ip hotspot user remove [find where name=$n]
        :set removed ($removed + 1)
      }
      :if ($k = "kick") do={
        :local m [$fld $line 2]
        :if ($m = "") do={
          /ip hotspot active remove [find where user=$n]
        } else={
          /ip hotspot active remove [find where user=$n && mac-address=$m]
        }
        :set kicked ($kicked + 1)
      }
    }
  }
  :if (($added + $removed + $kicked) > 0) do={
    :log info ("drc-cloud-sync: added " . $added . ", removed " . $removed . ", disconnected " . $kicked)
  }
}
