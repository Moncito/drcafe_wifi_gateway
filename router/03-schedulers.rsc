# 03-schedulers.rsc - timers. Needs 01-scripts.rsc first. Safe to re-import.
#   drc-sweep    every minute: end codes whose 3 hours of clock time are up
#   drc-closing  01:00 daily:  kick all S/G devices, delete all S/G codes
#   drc-backup   01:15 daily:  drc-auto-<weekday>.backup/.rsc (last 7 days kept)
#   drc-cloud-sync every 20 s: check in with the cloud panel
#                (needs the script drc-cloud-config, see panel/DEPLOY.md)

# The clock must be right for all of the above. Turn on NTP (Asia/Manila zone
# is already set). If NTP is already configured, this only re-applies it.
/system ntp client set enabled=yes servers=0.ph.pool.ntp.org,1.asia.pool.ntp.org,time.cloudflare.com

/system scheduler remove [find where name~"^drc-"]
/system scheduler add name=drc-sweep start-time=startup interval=1m \
    policy=read,write,test on-event="/system script run drc-sweep" \
    comment="Don Robert Cafe Wi-Fi: end codes after 3h clock time"
/system scheduler add name=drc-closing start-time=01:00:00 interval=1d \
    policy=read,write,test on-event="/system script run drc-closing" \
    comment="Don Robert Cafe Wi-Fi: 1:00 AM closing cleanup"
/system scheduler add name=drc-backup start-time=01:15:00 interval=1d \
    policy=ftp,read,write,policy,test,sensitive on-event="/system script run drc-backup" \
    comment="drc last backup: none yet"
/system scheduler add name=drc-cloud-sync start-time=startup interval=20s \
    policy=read,write,test on-event="/system script run drc-cloud-sync" \
    comment="Don Robert Cafe Wi-Fi: check in with the panel"

:put "03-schedulers done: drc-sweep (1m), drc-closing (01:00), drc-backup (01:15), drc-cloud-sync (20s)."
