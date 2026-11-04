!macro customInit
  ; Best-effort: terminate a running app instance before install/uninstall
  ; to avoid NSIS "app cannot be closed" errors during upgrades.
  nsExec::ExecToLog 'taskkill /IM "${APP_EXECUTABLE_FILENAME}" /F /T'
  Pop $0
  Sleep 800

  ; feat/legacy-data-recovery ④: data awareness during install. A reinstall
  ; must never look like a silent data reset — tell the user when existing
  ; IDBots data (or a previous Windows installation carrying it) is present.
  ; Existing data is preserved and picked up automatically (uninstall policy:
  ; deleteAppDataOnUninstall=false).
  IfFileExists "$APPDATA\IDBots\idbots.sqlite" _idbots_existing_data_found _idbots_windows_old_check

_idbots_existing_data_found:
  MessageBox MB_OK|MB_ICONINFORMATION "Existing IDBots data detected in $APPDATA\IDBots.$\r$\n$\r$\nYour bots, sessions and settings will be kept, and this installation will continue to use this data."
  Goto _idbots_data_check_done

_idbots_windows_old_check:
  ; NSIS has no $SYSTEMDRIVE constant — an unknown $var silently expands to
  ; the empty string (caught by the first real makensis compile). Read the
  ; Windows environment at runtime instead.
  ReadEnvStr $1 "SystemDrive"
  IfFileExists "$1\Windows.old\Users" 0 _idbots_data_check_done
  MessageBox MB_OK|MB_ICONINFORMATION "A previous Windows installation was found ($1\Windows.old).$\r$\n$\r$\nIf your IDBots data is inside it, finish installing IDBots and launch it once: when it starts with an empty library, it will offer to recover data from known locations (including Windows.old)."

_idbots_data_check_done:
!macroend
