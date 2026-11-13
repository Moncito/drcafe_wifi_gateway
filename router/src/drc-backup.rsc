# drc-backup: 1:15 AM, after closing. Saves drc-auto-<weekday>.backup and .rsc,
# so the router always keeps the last 7 days (each weekday file is overwritten
# a week later). Writes the date into this scheduler's comment for the panel.
:local epoch [:parse [/system script get drc-epoch source]]
:local now [$epoch]
:local wd "nodate"
:if ($now > 0) do={
  :local days (($now / 86400) + 4)
  :local names {"sun";"mon";"tue";"wed";"thu";"fri";"sat"}
  :set wd ($names->($days - (($days / 7) * 7)))
}
:local nm ("drc-auto-" . $wd)
/file remove [find where name=($nm . ".backup")]
/file remove [find where name=($nm . ".rsc")]
/system backup save name=$nm dont-encrypt=yes
/export file=$nm
:delay 3s
:local stamp ([:tostr [/system clock get date]] . " " . [:tostr [/system clock get time]])
/system scheduler set [find where name="drc-backup"] comment=("drc last backup " . $stamp . " " . $nm)
:log info ("drc-backup: saved " . $nm)
