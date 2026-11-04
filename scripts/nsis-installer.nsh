!macro customInit
  ; Best-effort: terminate a running app instance before install/uninstall
  ; to avoid NSIS "app cannot be closed" errors during upgrades.
  nsExec::ExecToLog 'taskkill /IM "${APP_EXECUTABLE_FILENAME}" /F /T'
  Pop $0
  Sleep 800

  ; Data awareness during install. The "existing data detected" reassurance
  ; notice was removed: it was an OK-only box on every upgrade for every
  ; existing user with zero functional effect (data is preserved regardless;
  ; uninstall policy: deleteAppDataOnUninstall=false). Only the Windows.old
  ; notice remains — it is rare and carries an actionable instruction.
  ; NSIS has no $SYSTEMDRIVE constant — an unknown $var silently expands to
  ; the empty string (caught by the first real makensis compile). Read the
  ; Windows environment at runtime instead.
  ReadEnvStr $1 "SystemDrive"
  IfFileExists "$1\Windows.old\Users" 0 _idbots_data_check_done
  MessageBox MB_OK|MB_ICONINFORMATION "A previous Windows installation was found ($1\Windows.old).$\r$\n$\r$\nIf your IDBots data is inside it, finish installing IDBots and launch it once: when it starts with an empty library, it will offer to recover data from known locations (including Windows.old)." /SD OK

_idbots_data_check_done:
!macroend
