# --- shared block (inserted by tools/build-scripts.mjs) ---
# Café code names: S or G + 5 chars from ABCDEFGHJKMNPQRSTUVWXYZ23456789
:local re "^[SG][A-HJKMNP-Z2-9]{5}\$"
# Code comments look like:  drc;dur=10800;start=<epoch>;end=<epoch>;exp=<epoch>;
# getf <comment> <key>  -> value as string, or "" if missing
:local getf do={
  :local k (";" . $2 . "=")
  :local p [:find $1 $k]
  :if ([:typeof $p] = "nil") do={ :return "" }
  :local s ($p + [:len $k])
  :local e [:find $1 ";" ($s - 1)]
  :if ([:typeof $e] = "nil") do={ :set e [:len $1] }
  :return [:pick $1 $s $e]
}
:local epoch [:parse [/system script get drc-epoch source]]
# --- end shared block ---
