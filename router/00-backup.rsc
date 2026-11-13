# 00-backup.rsc - run FIRST, before any other Phase 1 file.
# Saves a full binary backup and a readable export of the current config.
# Afterwards download both from Winbox > Files and keep them off the router.
/system backup save name=drc-before-phase1 dont-encrypt=yes
/export file=drc-before-phase1
:log info "drc: saved drc-before-phase1.backup and drc-before-phase1.rsc"
:put "Saved drc-before-phase1.backup + .rsc - download them from Files before continuing."
