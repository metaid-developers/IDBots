; Compile every custom macro from scripts/nsis-installer.nsh without the full
; electron-builder payload. Pass IDBOTS_NSIS_SCRIPT and IDBOTS_NSIS_OUTPUT on
; the makensis command line so this harness works from any worktree.
Unicode true
!ifndef IDBOTS_NSIS_SCRIPT
  !error "IDBOTS_NSIS_SCRIPT must point to scripts/nsis-installer.nsh"
!endif
!ifndef IDBOTS_NSIS_OUTPUT
  !error "IDBOTS_NSIS_OUTPUT must point to a temporary output exe"
!endif

!define APP_EXECUTABLE_FILENAME "IDBots.exe"
!define APP_DESCRIPTION "IDBots"
!define APP_ID "ai.idbots.app"
!include "${IDBOTS_NSIS_SCRIPT}"

Var newDesktopLink
Var appExe

!macro WinShell::SetLnkAUMI shortcut appId
  DetailPrint "SetLnkAUMI ${shortcut} ${appId}"
!macroend

OutFile "${IDBOTS_NSIS_OUTPUT}"
Section "harness"
  StrCpy $newDesktopLink "$DESKTOP\IDBots.lnk"
  StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro customInit
  !insertmacro customInstall
SectionEnd
