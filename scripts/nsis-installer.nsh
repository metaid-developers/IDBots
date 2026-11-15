!macro _IDBOTS_SET_PROCESS_ENV
  ReadRegStr $R6 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ClearErrors
  ReadRegStr $R7 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ClearErrors
  System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_INSTALLER_PID", t "$R8")'
  System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_TARGET_DIR", t "$INSTDIR")'
  System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_OLD_USER_DIR", t "$R6")'
  System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_OLD_MACHINE_DIR", t "$R7")'
  System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_EXE_NAME", t "${APP_EXECUTABLE_FILENAME}")'
!macroend

!macro _IDBOTS_FIND_RUNNING_PROCESSES OUT_VAR
  !insertmacro _IDBOTS_SET_PROCESS_ENV
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='SilentlyContinue';$$s=[int]$$env:IDBOTS_INSTALLER_PID;$$sid=(gps -Id $$PID).SessionId;$$n=[IO.Path]::GetFileNameWithoutExtension($$env:IDBOTS_EXE_NAME);$$ds=@($$env:IDBOTS_TARGET_DIR,$$env:IDBOTS_OLD_USER_DIR,$$env:IDBOTS_OLD_MACHINE_DIR)|?{$$_}|%{if($$_.EndsWith('\')){$$_}else{$$_+'\'}}|select -Unique;$$h=$$false;foreach($$p in (gps -Name $$n)){if($$p.Id -ne $$s -and $$p.Id -ne $$PID -and $$p.SessionId -eq $$sid){$$h=$$true;break}};if(-not $$h -and $$ds){foreach($$w in (gcim Win32_Process)){if($$w.ProcessId -ne $$s -and $$w.ProcessId -ne $$PID -and $$w.SessionId -eq $$sid -and $$w.ExecutablePath){foreach($$d in $$ds){if($$w.ExecutablePath.StartsWith($$d,'OrdinalIgnoreCase')){$$h=$$true;break}};if($$h){break}}}};if($$h){exit 0}else{exit 1}"`
  Pop ${OUT_VAR}
  ; Fallback when PowerShell is unavailable or blocked by local policy.
  ${If} ${OUT_VAR} != "0"
  ${AndIf} ${OUT_VAR} != "1"
    nsExec::Exec `"$SYSDIR\cmd.exe" /c ""$SYSDIR\tasklist.exe" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO csv | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}""`
    Pop ${OUT_VAR}
  ${EndIf}
!macroend

!macro _IDBOTS_STOP_RUNNING_PROCESSES
  !insertmacro _IDBOTS_SET_PROCESS_ENV
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='SilentlyContinue';$$s=[int]$$env:IDBOTS_INSTALLER_PID;$$sid=(gps -Id $$PID).SessionId;$$n=[IO.Path]::GetFileNameWithoutExtension($$env:IDBOTS_EXE_NAME);$$ds=@($$env:IDBOTS_TARGET_DIR,$$env:IDBOTS_OLD_USER_DIR,$$env:IDBOTS_OLD_MACHINE_DIR)|?{$$_}|%{if($$_.EndsWith('\')){$$_}else{$$_+'\'}}|select -Unique;gps -Name $$n|?{$$_.Id -ne $$s -and $$_.Id -ne $$PID -and $$_.SessionId -eq $$sid}|spps -Force;if($$ds){gcim Win32_Process|?{$$_.ProcessId -ne $$s -and $$_.ProcessId -ne $$PID -and $$_.SessionId -eq $$sid -and $$_.ExecutablePath}|%{foreach($$d in $$ds){if($$_.ExecutablePath.StartsWith($$d,'OrdinalIgnoreCase')){spps -Id $$_.ProcessId -Force;break}}}}"`
  Pop $0
  ; Do not pass /T to taskkill /IM IDBots.exe: the updater launches this
  ; installer directly, and killing the process tree would kill the installer.
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $R8"`
  Pop $0
!macroend

!macro customCheckAppRunning
  !define _IDBOTS_CHK_ID ${__LINE__}
  System::Call 'kernel32::GetCurrentProcessId() i .R8'
  !insertmacro _IDBOTS_FIND_RUNNING_PROCESSES $R0
  ${If} $R0 == 0
    ${If} ${isUpdated}
      ; Auto-update launches the installer while calling app.quit(). Give the
      ; exiting process up to ~5s to flush SQLite and close children cleanly.
      StrCpy $R1 0
      _idbots_grace_loop_${_IDBOTS_CHK_ID}:
        Sleep 250
        !insertmacro _IDBOTS_FIND_RUNNING_PROCESSES $R0
        ${If} $R0 != 0
          Goto _idbots_not_running_${_IDBOTS_CHK_ID}
        ${EndIf}
        IntOp $R1 $R1 + 1
        ${If} $R1 < 20
          Goto _idbots_grace_loop_${_IDBOTS_CHK_ID}
        ${EndIf}
      Goto _idbots_stop_process_${_IDBOTS_CHK_ID}
    ${EndIf}

    ${IfNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK _idbots_stop_process_${_IDBOTS_CHK_ID}
      Quit
    ${EndIf}

    _idbots_stop_process_${_IDBOTS_CHK_ID}:
    DetailPrint `Closing running "${PRODUCT_NAME}"...`
    StrCpy $R2 "0"

    _idbots_kill_loop_${_IDBOTS_CHK_ID}:
      !insertmacro _IDBOTS_STOP_RUNNING_PROCESSES
      StrCpy $R1 0
      _idbots_wait_exit_${_IDBOTS_CHK_ID}:
        !insertmacro _IDBOTS_FIND_RUNNING_PROCESSES $R0
        ${If} $R0 != 0
          Goto _idbots_not_running_${_IDBOTS_CHK_ID}
        ${EndIf}
        Sleep 400
        IntOp $R1 $R1 + 1
        ${If} $R1 < 8
          Goto _idbots_wait_exit_${_IDBOTS_CHK_ID}
        ${EndIf}

      ; If the app was launched as Administrator while the installer is
      ; non-elevated, retry once via UAC-elevated taskkill before prompting.
      ${IfNot} ${Silent}
      ${AndIfNot} ${UAC_IsAdmin}
      ${AndIf} $R2 == "0"
        StrCpy $R2 "1"
        ExecShellWait "runas" "$SYSDIR\taskkill.exe" '/F /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $R8"' SW_HIDE
        StrCpy $R1 0
        _idbots_wait_uac_${_IDBOTS_CHK_ID}:
          !insertmacro _IDBOTS_FIND_RUNNING_PROCESSES $R0
          ${If} $R0 != 0
            Goto _idbots_not_running_${_IDBOTS_CHK_ID}
          ${EndIf}
          Sleep 400
          IntOp $R1 $R1 + 1
          ${If} $R1 < 6
            Goto _idbots_wait_uac_${_IDBOTS_CHK_ID}
          ${EndIf}
      ${EndIf}

      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY _idbots_kill_loop_${_IDBOTS_CHK_ID}
      Quit

    _idbots_not_running_${_IDBOTS_CHK_ID}:
    ; Allow Windows/Crashpad/AV a brief moment to release file handles before
    ; uninstallOldVersion renames files inside $INSTDIR.
    Sleep 500
  ${EndIf}
  !undef _IDBOTS_CHK_ID
!macroend

!macro customInit
  ; In UAC-elevated assisted installs, installSection.nsh skips CHECK_APP_RUNNING
  ; for the inner elevated instance. Close any running instance here after
  ; elevation succeeds so uninstallOldVersion never hits a locked process.
  ${If} ${UAC_IsInnerInstance}
    !insertmacro customCheckAppRunning
  ${EndIf}

  ; Data awareness during install. The "existing data detected" reassurance
  ; notice was removed: it was an OK-only box on every upgrade for every
  ; existing user with zero functional effect (data is preserved regardless;
  ; uninstall policy: deleteAppDataOnUninstall=false). Only the Windows.old
  ; notice remains -- it is rare and carries an actionable instruction.
  ; NSIS has no $SYSTEMDRIVE constant -- an unknown $var silently expands to
  ; the empty string (caught by the first real makensis compile). Read the
  ; Windows environment at runtime instead.
  IfFileExists "$APPDATA\IDBots\idbots.sqlite" _idbots_data_check_done 0
  ReadEnvStr $1 "SystemDrive"
  IfFileExists "$1\Windows.old\Users" 0 _idbots_data_check_done
  MessageBox MB_OK|MB_ICONINFORMATION "A previous Windows installation was found ($1\Windows.old).$\r$\n$\r$\nIf your IDBots data is inside it, finish installing IDBots and launch it once: when it starts with an empty library, it will offer to recover data from known locations (including Windows.old)." /SD IDOK

_idbots_data_check_done:
!macroend

!macro customInstall
  ; electron-builder preserves shortcuts on upgrade and therefore does not
  ; recreate one the user previously deleted. Restore only a missing link;
  ; an existing shortcut (including its customized target) stays untouched
  ; unless its target is broken or points to a stale IDBots.exe location.
  IfFileExists "$newDesktopLink" _idbots_desktop_shortcut_exists 0
  CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"

_idbots_desktop_shortcut_exists:
  System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_APP_EXE", t "$appExe")'
  System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_INST_DIR", t "$INSTDIR")'
  System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_DESKTOP_LINK", t "$newDesktopLink")'
  System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_STARTMENU_LINK", t "$newStartMenuLink")'
  System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_TASKBAR_LINK", t "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk")'
  System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_EXE_NAME", t "${APP_EXECUTABLE_FILENAME}")'
  System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_SHORTCUT_NAME", t "${SHORTCUT_NAME}")'
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='SilentlyContinue';$$e=$$env:IDBOTS_APP_EXE;$$d=$$env:IDBOTS_INST_DIR;$$n=$$env:IDBOTS_EXE_NAME;if(-not $$e -or -not (Test-Path -LiteralPath $$e)){exit 0};$$w=New-Object -Com WScript.Shell;$$p=Join-Path $$env:PUBLIC ('Desktop\'+$$env:IDBOTS_SHORTCUT_NAME+'.lnk');@($$env:IDBOTS_DESKTOP_LINK,$$env:IDBOTS_STARTMENU_LINK,$$env:IDBOTS_TASKBAR_LINK,$$p)|?{$$_}|select -Unique|%{if(Test-Path -LiteralPath $$_){try{$$sc=$$w.CreateShortcut($$_);$$t=$$sc.TargetPath;if(-not $$t -or -not (Test-Path -LiteralPath $$t) -or ((Split-Path $$t -Leaf) -ieq $$n -and $$t -ine $$e)){$$sc.TargetPath=$$e;$$sc.WorkingDirectory=$$d;if(-not $$sc.IconLocation -or $$sc.IconLocation -like ('*'+$$n+'*')){$$sc.IconLocation=($$e+',0')};$$sc.Save()}}catch{}}}"`
  Pop $0
  ClearErrors
  IfFileExists "$newDesktopLink" 0 _idbots_desktop_shortcut_done
  WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'

_idbots_desktop_shortcut_done:
!macroend
