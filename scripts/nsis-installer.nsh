!macro customInit
  ; electron-builder's CHECK_APP_RUNNING owns process shutdown during the
  ; install section. Do not taskkill /T here: the updater launches this
  ; installer directly, and killing the whole tree would kill the installer.
  ; Data awareness during install. The "existing data detected" reassurance
  ; notice was removed: it was an OK-only box on every upgrade for every
  ; existing user with zero functional effect (data is preserved regardless;
  ; uninstall policy: deleteAppDataOnUninstall=false). Only the Windows.old
  ; notice remains -- it is rare and carries an actionable instruction.
  ; NSIS has no $SYSTEMDRIVE constant -- an unknown $var silently expands to
  ; the empty string (caught by the first real makensis compile). Read the
  ; Windows environment at runtime instead.
  ReadEnvStr $1 "SystemDrive"
  IfFileExists "$1\Windows.old\Users" 0 _idbots_data_check_done
  MessageBox MB_OK|MB_ICONINFORMATION "A previous Windows installation was found ($1\Windows.old).$\r$\n$\r$\nIf your IDBots data is inside it, finish installing IDBots and launch it once: when it starts with an empty library, it will offer to recover data from known locations (including Windows.old)." /SD IDOK

_idbots_data_check_done:
!macroend

!macro customInstall
  ; electron-builder preserves shortcuts on upgrade and therefore does not
  ; recreate one the user previously deleted. Restore only a missing link;
  ; an existing shortcut (including its customized target) stays untouched.
  IfFileExists "$newDesktopLink" _idbots_desktop_shortcut_done 0
  CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'

_idbots_desktop_shortcut_done:
!macroend
