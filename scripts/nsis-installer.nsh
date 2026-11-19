; Declared ONLY for the installer pass, and every reference stays inside
; that same guard: the BUILD_UNINSTALLER pass instantiates the install-mode
; page function with the un. prefix (assistedInstaller's !else branch) and
; compiles customInstallMode there, but customInit — the only writer of
; these snapshots — is installer-pass-only, so in the uninstaller pass the
; force logic could only ever read empty strings. Guarding the body keeps
; the uninstaller pass at its v1.1.1 shape (no references, no warnings
; under -WX on any NSIS version) while the installer-side force logic from
; 791fc96c4 is untouched (run 44502506341's packaging failure).
!ifndef BUILD_UNINSTALLER
  Var IdbotsPrevUserDir
  Var IdbotsPrevMachineDir
!endif

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

!macro _IDBOTS_FIND_MAIN_EXE OUT_VAR
  nsExec::Exec `"$SYSDIR\cmd.exe" /c ""$SYSDIR\tasklist.exe" /NH /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FI "PID ne $R8" /FO CSV | "$SYSDIR\find.exe" /I "${APP_EXECUTABLE_FILENAME}""`
  Pop ${OUT_VAR}
!macroend

!macro _IDBOTS_FIND_BUNDLED_CANDIDATES OUT_VAR
  nsExec::Exec `"$SYSDIR\cmd.exe" /c ""$SYSDIR\tasklist.exe" /NH /FI "PID ne $R8" /FO CSV | "$SYSDIR\findstr.exe" /I /C:"\"${APP_EXECUTABLE_FILENAME}\"" /C:"\"python.exe\"" /C:"\"bash.exe\"" /C:"\"git.exe\"" /C:"\"sh.exe\"" /C:"\"ffmpeg-win32-x64.exe\"""`
  Pop ${OUT_VAR}
!macroend

!macro _IDBOTS_FIND_RUNNING_PROCESSES OUT_VAR
  ; Fast path (~25ms, zero PowerShell): check native tasklist for IDBots.exe or
  ; any bundled helper binary name first. In normal upgrades where IDBots has
  ; exited and no bundled tool name is running, this avoids cold-starting
  ; PowerShell + AMSI/CIM completely.
  !insertmacro _IDBOTS_FIND_MAIN_EXE ${OUT_VAR}
  ${If} ${OUT_VAR} != 0
    !insertmacro _IDBOTS_FIND_BUNDLED_CANDIDATES ${OUT_VAR}
    ${If} ${OUT_VAR} == 0
      !insertmacro _IDBOTS_SET_PROCESS_ENV
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='SilentlyContinue';$$s=[int]$$env:IDBOTS_INSTALLER_PID;$$sid=(gps -Id $$PID).SessionId;$$ds=@($$env:IDBOTS_TARGET_DIR,$$env:IDBOTS_OLD_USER_DIR,$$env:IDBOTS_OLD_MACHINE_DIR)|?{$$_}|%{if($$_.EndsWith('\')){$$_}else{$$_+'\'}}|select -Unique;$$h=$$false;if($$ds){foreach($$p in (gps -Name python,bash,git,sh,ffmpeg-win32-x64 -EA SilentlyContinue)){if($$p.Id -ne $$s -and $$p.Id -ne $$PID -and $$p.SessionId -eq $$sid -and $$p.Path){foreach($$d in $$ds){if($$p.Path.StartsWith($$d,'OrdinalIgnoreCase')){$$h=$$true;break}};if($$h){break}}}};if($$h){exit 0}else{exit 1}"`
      Pop ${OUT_VAR}
      ${If} ${OUT_VAR} != "0"
      ${AndIf} ${OUT_VAR} != "1"
        StrCpy ${OUT_VAR} "1"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro _IDBOTS_STOP_RUNNING_PROCESSES
  ; Do not pass /T to taskkill /IM IDBots.exe: the updater launches this
  ; installer directly, and killing the process tree would kill the installer.
  ;
  ; Session-scoped kill (2026-11-19 review P2): a bare /IM is machine-wide —
  ; under fast user switching (same account in a second session) or an
  ; elevated all-users run it force-killed ANOTHER session's instance,
  ; losing that session's in-flight bot work. ProcessIdToSessionId + the
  ; SESSION filter keep the fast native path while touching only this
  ; installer's own session. A foreign-session instance on a machine-scope
  ; install is left running: the loop below then degrades to the
  ; "$(appCannotBeClosed)" prompt instead of silently destroying another
  ; session's work. Failure to resolve our session id kills NOTHING here
  ; (fail closed); the UAC-elevated retry below keeps its machine-wide
  ; form because it exists precisely to reach the other ELEVATION of our
  ; own user's app.
  System::Call 'kernel32::ProcessIdToSessionId(i $R8, *i .R9) i .R7'
  ${If} $R7 == 0
    StrCpy $R9 "-1"
  ${EndIf}
  nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}" /FI "PID ne $R8" /FI "SESSION eq $R9"`
  Pop $0
  !insertmacro _IDBOTS_FIND_BUNDLED_CANDIDATES $0
  ${If} $0 == 0
    !insertmacro _IDBOTS_SET_PROCESS_ENV
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='SilentlyContinue';$$s=[int]$$env:IDBOTS_INSTALLER_PID;$$sid=(gps -Id $$PID).SessionId;$$n=[IO.Path]::GetFileNameWithoutExtension($$env:IDBOTS_EXE_NAME);$$ds=@($$env:IDBOTS_TARGET_DIR,$$env:IDBOTS_OLD_USER_DIR,$$env:IDBOTS_OLD_MACHINE_DIR)|?{$$_}|%{if($$_.EndsWith('\')){$$_}else{$$_+'\'}}|select -Unique;gps -Name $$n -EA SilentlyContinue|?{$$_.Id -ne $$s -and $$_.Id -ne $$PID -and $$_.SessionId -eq $$sid}|spps -Force;if($$ds){gps -Name python,bash,git,sh,ffmpeg-win32-x64 -EA SilentlyContinue|?{$$_.Id -ne $$s -and $$_.Id -ne $$PID -and $$_.SessionId -eq $$sid -and $$_.Path}|%{foreach($$d in $$ds){if($$_.Path.StartsWith($$d,'OrdinalIgnoreCase')){spps -Id $$_.Id -Force;break}}}}"`
    Pop $0
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !define _IDBOTS_CHK_ID ${__LINE__}
  System::Call 'kernel32::GetCurrentProcessId() i .R8'
  !insertmacro _IDBOTS_FIND_RUNNING_PROCESSES $R0
  ${If} $R0 == 0
    ${If} ${isUpdated}
      ; Auto-update launches the installer while calling app.quit(). Poll the
      ; fast native tasklist check for up to ~30s: the app's own cleanup
      ; watchdog gives an updater-driven quit 15s (big sql.js saves and the
      ; session-log flush need it), and the force-kill below must never land
      ; inside that window. The fast tasklist check exits the loop the moment
      ; the app is really gone; PowerShell is never spawned on the hot path.
      StrCpy $R1 0
      _idbots_grace_loop_${_IDBOTS_CHK_ID}:
        Sleep 250
        !insertmacro _IDBOTS_FIND_MAIN_EXE $R0
        ${If} $R0 != 0
          !insertmacro _IDBOTS_FIND_RUNNING_PROCESSES $R0
          ${If} $R0 != 0
            Goto _idbots_not_running_${_IDBOTS_CHK_ID}
          ${EndIf}
          Goto _idbots_stop_process_${_IDBOTS_CHK_ID}
        ${EndIf}
        IntOp $R1 $R1 + 1
        ${If} $R1 < 120
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
        Sleep 300
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
          Sleep 300
          IntOp $R1 $R1 + 1
          ${If} $R1 < 6
            Goto _idbots_wait_uac_${_IDBOTS_CHK_ID}
          ${EndIf}
      ${EndIf}

      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY _idbots_kill_loop_${_IDBOTS_CHK_ID}
      Quit

    _idbots_not_running_${_IDBOTS_CHK_ID}:
    !ifndef BUILD_UNINSTALLER
      ; Allow Windows/Crashpad/AV a brief moment to release file handles before
      ; uninstallOldVersion renames files inside $INSTDIR.
      Sleep 300
    !endif
  ${EndIf}
  !undef _IDBOTS_CHK_ID
!macroend

!macro customInit
  ; Electron 41 (Chromium 142) cannot run on Windows 7/8/8.1, and our payload
  ; is x64-only. On those machines the NSIS install itself completes fine and
  ; the app then never opens (the x64 process cannot start), which users report
  ; as "the installer is broken". Refuse the install with an explicit message
  ; instead. The uninstaller build is exempt so an existing install can still
  ; be removed from an unsupported machine.
  !ifndef BUILD_UNINSTALLER
    ; HKLM\...\CurrentVersion is a shared registry key (not redirected under
    ; WOW64) and holds "6.1"/"6.2"/"6.3" on Win7/8/8.1, "10.0" on Win10/11.
    ; Block the known-legacy list rather than allowlisting "10.0" so an
    ; unreadable value (or a future Windows) fails OPEN, not closed.
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" CurrentVersion
    ClearErrors
    ${If} $R1 == "5.0"
    ${OrIf} $R1 == "5.1"
    ${OrIf} $R1 == "5.2"
    ${OrIf} $R1 == "6.0"
    ${OrIf} $R1 == "6.1"
    ${OrIf} $R1 == "6.2"
    ${OrIf} $R1 == "6.3"
      MessageBox MB_OK|MB_ICONSTOP "IDBots requires Windows 10 (64-bit) or later. This computer is running an older version of Windows that IDBots cannot support. Please upgrade Windows and run this installer again." /SD IDOK
      Quit
    ${EndIf}
    ; 32-bit Windows: a 32-bit installer process reports PROCESSOR_ARCHITECTURE
    ; =x86 with NO PROCESSOR_ARCHITEW6432 override (on 64-bit Windows the
    ; override is always set, so both conditions are required).
    ReadEnvStr $R2 "PROCESSOR_ARCHITEW6432"
    ${If} $R2 == ""
      ReadEnvStr $R2 "PROCESSOR_ARCHITECTURE"
      ${If} $R2 == "x86"
        MessageBox MB_OK|MB_ICONSTOP "IDBots requires a 64-bit edition of Windows. This computer is running a 32-bit edition of Windows, which IDBots cannot support." /SD IDOK
        Quit
      ${EndIf}
    ${EndIf}
  !endif

  ; Snapshot previous install directories before registryAddInstallInfo updates
  ; them so customInstall only runs PowerShell shortcut retargeting when an
  ; install path actually changed.
  ReadRegStr $IdbotsPrevUserDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ClearErrors
  ReadRegStr $IdbotsPrevMachineDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ClearErrors

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

; electron-builder's install-mode page (per-user vs per-machine) has no
; skipPageIfUpdated, so every "auto" update asked the user a question whose
; answer could fork a second install into a different directory. This hook
; runs inside the page's pre function: force the previous install's scope and
; electron-builder aborts the page itself. customInit snapshotted the
; pre-upgrade registry values into $IdbotsPrevUserDir/$IdbotsPrevMachineDir
; BEFORE registryAddInstallInfo touched them, so they are authoritative here.
; A fresh install (both snapshots empty) keeps the interactive page.
!macro customInstallMode
  ; The BUILD_UNINSTALLER pass compiles this body too (the un.-prefixed
  ; install-mode page function instantiates it), but $IdbotsPrevUserDir /
  ; $IdbotsPrevMachineDir are snapshot by customInit — installer-pass-only —
  ; so in the uninstaller pass the force logic could only read empty strings
  ; and skip a page the user is entitled to see. Compile it installer-side
  ; only; the uninstall-mode page keeps its v1.1.1 interactive behavior.
  !ifndef BUILD_UNINSTALLER
    ${If} ${isUpdated}
      ${If} $IdbotsPrevUserDir != ""
        StrCpy $isForceCurrentInstall "1"
      ${ElseIf} $IdbotsPrevMachineDir != ""
        StrCpy $isForceMachineInstall "1"
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!macro customInstall
  ; electron-builder preserves shortcuts on upgrade and therefore does not
  ; recreate one the user previously deleted. Restore only a missing link;
  ; an existing shortcut (including its customized target) stays untouched
  ; unless a previous install directory moved to a new $INSTDIR.
  IfFileExists "$newDesktopLink" _idbots_desktop_shortcut_exists 0
  CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  ; WinShell is an NSIS PLUGIN, not a macro: `Name::Call` syntax always
  ; resolves as a plugin invocation (a same-named !define or !macro is never
  ; reached). The syntax harness's brew/CI NSIS distributions do not carry the
  ; WinShell.dll that electron-builder's NSIS bundle ships, so the harness
  ; build compiles with IDBOTS_NSIS_SYNTAX_HARNESS defined and skips exactly
  ; these three fixed-string plugin one-liners. The real install defines no
  ; such flag and keeps them all.
  !ifndef IDBOTS_NSIS_SYNTAX_HARNESS
  WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  !endif

_idbots_desktop_shortcut_exists:
  StrCpy $R9 "0"
  ${If} $IdbotsPrevUserDir != ""
  ${AndIf} $IdbotsPrevUserDir != "$INSTDIR"
    StrCpy $R9 "1"
  ${EndIf}
  ${If} $IdbotsPrevMachineDir != ""
  ${AndIf} $IdbotsPrevMachineDir != "$INSTDIR"
    StrCpy $R9 "1"
  ${EndIf}
  ${If} $R9 == "1"
    System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_APP_EXE", t "$appExe")'
    System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_INST_DIR", t "$INSTDIR")'
    System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_DESKTOP_LINK", t "$newDesktopLink")'
    System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_STARTMENU_LINK", t "$newStartMenuLink")'
    System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_TASKBAR_LINK", t "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${SHORTCUT_NAME}.lnk")'
    System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_EXE_NAME", t "${APP_EXECUTABLE_FILENAME}")'
    System::Call 'kernel32::SetEnvironmentVariable(t "IDBOTS_SHORTCUT_NAME", t "${SHORTCUT_NAME}")'
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference='SilentlyContinue';$$e=$$env:IDBOTS_APP_EXE;$$d=$$env:IDBOTS_INST_DIR;$$n=$$env:IDBOTS_EXE_NAME;if(-not $$e -or -not (Test-Path -LiteralPath $$e)){exit 0};$$w=New-Object -Com WScript.Shell;$$p=Join-Path $$env:PUBLIC ('Desktop\'+$$env:IDBOTS_SHORTCUT_NAME+'.lnk');@($$env:IDBOTS_DESKTOP_LINK,$$env:IDBOTS_STARTMENU_LINK,$$env:IDBOTS_TASKBAR_LINK,$$p)|?{$$_}|select -Unique|%{if(Test-Path -LiteralPath $$_){try{$$sc=$$w.CreateShortcut($$_);$$t=$$sc.TargetPath;if(-not $$t -or -not (Test-Path -LiteralPath $$t) -or ((Split-Path $$t -Leaf) -ieq $$n -and $$t -ine $$e)){$$sc.TargetPath=$$e;$$sc.WorkingDirectory=$$d;if(-not $$sc.IconLocation -or $$sc.IconLocation -like ('*'+$$n+'*')){$$sc.IconLocation=($$e+',0')};$$sc.Save()}}catch{}}}"`
    Pop $0
  ${EndIf}
  ClearErrors
  IfFileExists "$newStartMenuLink" 0 +2
  !ifndef IDBOTS_NSIS_SYNTAX_HARNESS
  WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  !endif
  ClearErrors
  IfFileExists "$newDesktopLink" 0 _idbots_desktop_shortcut_done
  !ifndef IDBOTS_NSIS_SYNTAX_HARNESS
  WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  !endif
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'

_idbots_desktop_shortcut_done:
!macroend

!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function _IdbotsLaunchFromUserProcess
      SetOutPath "$INSTDIR"
      ClearErrors
      Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" $1'
      ${If} ${Errors}
        ClearErrors
        ExecShell "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$1" SW_SHOWNORMAL
      ${EndIf}
      ${If} ${Errors}
        StrCpy $0 "error"
      ${Else}
        StrCpy $0 "ok"
      ${EndIf}
    FunctionEnd

    Function StartApp
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      SetOutPath "$INSTDIR"
      StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"

      ; 1. UAC-elevated inner installer: execute CreateProcess directly inside
      ;    the original non-elevated outer installer process. Launching $appExe
      ;    instead of $launchLink (.lnk) avoids Windows Shell dropping .lnk
      ;    launches when --updated arguments are supplied (electron-builder#5988).
      ${If} ${UAC_IsInnerInstance}
        StrCpy $0 "error"
        !insertmacro UAC_AsUser_Call Function _IdbotsLaunchFromUserProcess ${UAC_SYNCREGISTERS}|${UAC_SYNCOUTDIR}|${UAC_SYNCINSTDIR}
        ${If} $0 == "ok"
          Return
        ${EndIf}
      ${EndIf}

      ; 2. Non-elevated per-user install (the default): already running as the
      ;    interactive user, so spawn IDBots.exe directly via CreateProcess
      ;    without round-tripping through Explorer IShellDispatch2 COM.
      ${IfNot} ${UAC_IsAdmin}
        ClearErrors
        Exec '"$appExe" $1'
        ${IfNot} ${Errors}
          Return
        ${EndIf}
        ExecShell "" "$appExe" "$1" SW_SHOWNORMAL
        Return
      ${EndIf}

      ; 3. Directly elevated admin installer (e.g. Run as administrator or UAC
      ;    disabled on older Windows): de-elevate via Explorer on $appExe, then
      ;    verify IDBots.exe actually entered the process table across ~5x250ms
      ;    before retrying the DE-ELEVATED shell launch once. The old direct
      ;    elevated Exec fallback is deliberately gone (2026-11-19 review P2):
      ;    on a slow shell it spawned a second, admin-elevated IDBots.exe; the
      ;    single-instance lock absorbed the duplicate but the surviving
      ;    process kept an admin token. A missed auto-launch (the user clicks
      ;    the icon) beats an accidental admin process.
      System::Call 'kernel32::GetCurrentProcessId() i .R8'
      ${StdUtils.ExecShellAsUser} $0 "$appExe" "open" "$1"
      ; ${__LINE__} expands to the CURRENT line, so the label and its Goto
      ; must share ONE define (mirroring _IDBOTS_CHK_ID above) or they never
      ; resolve to the same name. (Caught by the makensis harness on its very
      ; first compile — the exact class of bug the harness exists for.)
      !define _IDBOTS_FV_ID ${__LINE__}
      ${If} $0 == "ok"
        StrCpy $R2 "0"
        _idbots_finish_verify_${_IDBOTS_FV_ID}:
          Sleep 250
          !insertmacro _IDBOTS_FIND_MAIN_EXE $R0
          ${If} $R0 == 0
            Return
          ${EndIf}
          IntOp $R2 $R2 + 1
          ${If} $R2 < 5
            Goto _idbots_finish_verify_${_IDBOTS_FV_ID}
          ${EndIf}
        ; Explorer COM occasionally swallows the first ShellDispatch call on a
        ; cold session — retry the de-elevated launch once, wait, re-check.
        ${StdUtils.ExecShellAsUser} $0 "$appExe" "open" "$1"
        Sleep 400
        !insertmacro _IDBOTS_FIND_MAIN_EXE $R0
        ${If} $R0 == 0
          Return
        ${EndIf}
      ${EndIf}
      ; Still not running: leave the launch to the user. No elevated spawn.
      !undef _IDBOTS_FV_ID
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !endif
  !insertmacro MUI_PAGE_FINISH
!macroend
