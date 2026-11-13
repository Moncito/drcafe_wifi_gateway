# 05-hardening.rsc - lock the router down so customers can't see or reach it.
# Run LAST (after 04-panel-access), IN SAFE MODE (see HARDENING.md).
#
# BEFORE IMPORTING: copy to 05-hardening.local.rsc, fill in the two MACs in the
# COPY, import the copy, then delete it. Check the interface names below match
# (/interface wifi print, /interface bridge print).
#
# Order inside this file (each step relies on the one before):
#   0. backup drc-before-hardening
#   1. static DHCP leases for admin laptop + panel PC (their CURRENT address);
#      aborts if either device isn't connected with a bound lease
#   2. address-list drc-admin = those two IPs
#   3. /ip service: telnet/ftp/api off; winbox, ssh, www, www-ssl, api-ssl only
#      from drc-admin; other unused servers off
#   4. MAC-Telnet, MAC-Winbox, MAC-ping, neighbor discovery off
#   5. customer isolation: wifi client-isolation + bridge horizon + no routing
#      between LAN devices
#   6. firewall: router management ports only from drc-admin (second layer)
# Safe to re-import.
{
:local laptopMac "AA:BB:CC:DD:EE:01"
:local panelMac "AA:BB:CC:DD:EE:02"
:local bridgeName "bridge"
:local wifiIfs {"wifi1";"wifi2"}

:if (($laptopMac = "AA:BB:CC:DD:EE:01") || ($panelMac = "AA:BB:CC:DD:EE:02")) do={
  :error "05-hardening: fill in laptopMac and panelMac first (see top of file)"
}

# ---- 0. backup ----------------------------------------------------------
/system backup save name=drc-before-hardening dont-encrypt=yes
/export file=drc-before-hardening

# ---- 1. static leases ---------------------------------------------------
# Makes the device's lease static at the address it has RIGHT NOW, so the
# address restrictions below match what the device is really using.
:local lockIp do={
  :local id [/ip dhcp-server lease find where mac-address=$mac]
  :if ([:len $id] = 0) do={ :error ($label . ": no DHCP lease for " . $mac . " - connect it to the cafe network first") }
  :if ([:len $id] > 1) do={ :error ($label . ": more than one lease for " . $mac . " - remove the extra one") }
  :if ([/ip dhcp-server lease get $id dynamic]) do={
    /ip dhcp-server lease make-static $id
    :set id [/ip dhcp-server lease find where mac-address=$mac]
  }
  :local addr [:tostr [/ip dhcp-server lease get $id address]]
  :local act [:tostr [/ip dhcp-server lease get $id active-address]]
  :local st [:tostr [/ip dhcp-server lease get $id status]]
  :if (($st != "bound") || ($act != $addr)) do={
    :error ($label . ": lease is " . $st . " (active " . $act . ", reserved " . $addr . "). On that PC run ipconfig /release then ipconfig /renew, then import again")
  }
  /ip dhcp-server lease set $id comment=$label
  :return $addr
}
:local lapIp [$lockIp mac=$laptopMac label="DRC admin laptop"]
:local panIp [$lockIp mac=$panelMac label="DRC panel PC"]
:if ($lapIp = $panIp) do={ :error "05-hardening: laptop and panel PC have the same address" }
:local allow ($lapIp . "/32," . $panIp . "/32")
:put ("admin laptop = " . $lapIp . ", panel PC = " . $panIp)

# ---- 2. address list ----------------------------------------------------
/ip firewall address-list remove [find where list="drc-admin"]
/ip firewall address-list add list=drc-admin address=$lapIp comment="DRC admin laptop"
/ip firewall address-list add list=drc-admin address=$panIp comment="DRC panel PC"

# ---- 3. services --------------------------------------------------------
/ip service set telnet disabled=yes
/ip service set ftp disabled=yes
/ip service set api disabled=yes
/ip service set winbox address=$allow disabled=no
/ip service set ssh address=$allow
/ip service set www address=$allow
/ip service set www-ssl address=$allow
/ip service set api-ssl address=$allow
:do { /ip ssh set strong-crypto=yes } on-error={}
:do { /ip proxy set enabled=no } on-error={}
:do { /ip socks set enabled=no } on-error={}
:do { /ip upnp set enabled=no } on-error={}
:do { /ip smb set enabled=no } on-error={}
:do { /snmp set enabled=no } on-error={}
:do { /tool bandwidth-server set enabled=no } on-error={}
:do { /tool romon set enabled=no } on-error={}
# RouterOS 7.25 reverse-proxy on 443: not used here
:do { /ip service set reverse-proxy disabled=yes } on-error={}

# ---- 4. layer-2 access and discovery -----------------------------------
/tool mac-server set allowed-interface-list=none
/tool mac-server mac-winbox set allowed-interface-list=none
:do { /tool mac-server ping set enabled=no } on-error={}
/ip neighbor discovery-settings set discover-interface-list=none

# ---- 5. customer isolation ---------------------------------------------
# a) same radio: the AP stops forwarding between its own clients
# b) between radios (2.4 <-> 5 GHz): same bridge horizon = bridge won't forward
#    between wifi1 and wifi2. Ethernet ports have no horizon (panel PC on ether2 is fine)
:foreach w in=$wifiIfs do={
  :do {
    /interface wifi set [find where name=$w] datapath.client-isolation=yes
  } on-error={ :put ("WARNING: client-isolation not set on " . $w . " - see HARDENING.md test H6") }
  /interface bridge port set [find where interface=$w] horizon=1
}
# c) a client could still send to the router and ask it to route to another
#    client in the same subnet: drop all routed LAN-to-LAN traffic.
/ip firewall filter remove [find where comment~"^drc: "]
:local firstFwd [:pick [/ip firewall filter find where chain=forward && dynamic=no] 0]
:if ([:typeof $firstFwd] = "nil") do={
  /ip firewall filter add chain=forward in-interface=$bridgeName out-interface=$bridgeName action=drop \
      comment="drc: no routing between cafe LAN devices"
} else={
  /ip firewall filter add chain=forward in-interface=$bridgeName out-interface=$bridgeName action=drop \
      comment="drc: no routing between cafe LAN devices" place-before=$firstFwd
}

# ---- 6. firewall: management ports only from drc-admin ------------------
# (second layer behind /ip service addresses; port 80 is left alone for the hotspot)
:local firstIn [:pick [/ip firewall filter find where chain=input && dynamic=no] 0]
:if ([:typeof $firstIn] = "nil") do={
  /ip firewall filter add chain=input protocol=tcp dst-port=21,22,23,443,8443,8291,8728,8729 \
      src-address-list=!drc-admin action=drop comment="drc: router management only from admin laptop + panel PC"
} else={
  /ip firewall filter add chain=input protocol=tcp dst-port=21,22,23,443,8443,8291,8728,8729 \
      src-address-list=!drc-admin action=drop comment="drc: router management only from admin laptop + panel PC" \
      place-before=$firstIn
}

:put "05-hardening done. Do the H-checks in APPLY.md BEFORE leaving Safe Mode."
}
