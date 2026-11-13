# 04-panel-access.rsc - lets the counter PC's admin panel talk to the router.
#
# BEFORE IMPORTING: copy this file to 04-panel-access.local.rsc, fill in the
# three values below in the COPY, import the copy, then delete the copy from
# the router (Files) and from the PC. Never commit the filled-in copy.
#
# What it does (everything stays on the LAN side; nothing is opened on WAN):
#   - static DHCP lease for the panel PC (outside the customer pool .10-.254)
#   - hotspot ip-binding type=bypassed so the PC skips the login page
#   - self-signed certificate "drc-rest" for 192.168.88.1
#   - www-ssl (REST API) on port 8443 with that certificate, ONLY from the panel PC
#     (443 is taken by RouterOS 7.25's reverse-proxy service)
#     NOTE: this also limits WebFig-over-HTTPS to the panel PC. If you use
#     https://192.168.88.1:8443 from your laptop, add its IP to the address list.
#   - user group "drc-panel" with policy read,write,api,rest-api (no policy,
#     sensitive, ftp, reboot, ssh, winbox, web). RouterOS 7.25 REST also needs "api".
#   - user "drc-panel", allowed to log in only from the panel PC's IP
# Safe to re-import (existing items are updated, not duplicated).
{
:local panelMac "AA:BB:CC:DD:EE:FF"
:local panelIp "192.168.88.5"
:local panelPass "CHANGE-ME"

:if (($panelPass = "CHANGE-ME") || ($panelMac = "AA:BB:CC:DD:EE:FF")) do={
  :error "04-panel-access: fill in panelMac and panelPass first (see top of file)"
}
:if ([:len $panelPass] < 16) do={ :error "04-panel-access: panelPass must be 16+ characters" }

# 1. Fixed address for the panel PC
/ip dhcp-server lease remove [find where mac-address=$panelMac && dynamic=yes]
:if ([:len [/ip dhcp-server lease find where mac-address=$panelMac]] = 0) do={
  /ip dhcp-server lease add mac-address=$panelMac address=$panelIp comment="DRC panel PC"
} else={
  /ip dhcp-server lease set [find where mac-address=$panelMac] address=$panelIp comment="DRC panel PC"
}

# 2. Panel PC skips the hotspot login page
:if ([:len [/ip hotspot ip-binding find where mac-address=$panelMac]] = 0) do={
  /ip hotspot ip-binding add mac-address=$panelMac type=bypassed comment="DRC panel PC"
} else={
  /ip hotspot ip-binding set [find where mac-address=$panelMac] type=bypassed comment="DRC panel PC"
}

# 3. Certificate for the REST API (10 years). RouterOS 7.25 won't self-sign a
#    server certificate ("CA not found"), so a small local CA signs it.
:if ([:len [/certificate find where name="drc-ca"]] = 0) do={
  /certificate add name=drc-ca common-name=drc-ca key-size=2048 days-valid=3650 key-usage=key-cert-sign,crl-sign
  /certificate sign drc-ca
}
:if ([:len [/certificate find where name="drc-rest"]] = 0) do={
  /certificate add name=drc-rest common-name=192.168.88.1 subject-alt-name=IP:192.168.88.1 \
      key-size=2048 days-valid=3650 key-usage=digital-signature,key-encipherment,tls-server
  /certificate sign drc-rest ca=drc-ca
}
:local i 0
:while (([:len [/certificate find where name="drc-rest" && private-key=yes]] = 0) && ($i < 60)) do={
  :delay 1s
  :set i ($i + 1)
}
:if ([:len [/certificate find where name="drc-rest" && private-key=yes]] = 0) do={
  :error "04-panel-access: certificate drc-rest not ready - run the file again in a minute"
}

# 4. REST API over HTTPS, reachable only from the panel PC
/ip service set www-ssl certificate=drc-rest port=8443 address=($panelIp . "/32") disabled=no

# 5. Limited router account for the panel
:if ([:len [/user group find where name="drc-panel"]] = 0) do={
  /user group add name=drc-panel policy=read,write,api,rest-api \
      comment="Don Robert Cafe admin panel (REST only)"
} else={
  /user group set [find where name="drc-panel"] policy=read,write,api,rest-api
}
:if ([:len [/user find where name="drc-panel"]] = 0) do={
  /user add name=drc-panel group=drc-panel password=$panelPass address=($panelIp . "/32") \
      comment="Don Robert Cafe admin panel"
} else={
  /user set [find where name="drc-panel"] group=drc-panel password=$panelPass address=($panelIp . "/32")
}

:put ("04-panel-access done. Panel PC " . $panelIp . " -> https://192.168.88.1:8443/rest/ as drc-panel")
:put ("Certificate fingerprint (put in panel .env): " . [/certificate get [find where name="drc-rest"] fingerprint])
}
