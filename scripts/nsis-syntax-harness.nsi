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

!include "LogicLib.nsh"

!define APP_EXECUTABLE_FILENAME "IDBots.exe"
!define APP_DESCRIPTION "IDBots"
!define APP_ID "ai.idbots.app"
!define PRODUCT_NAME "IDBots"
!define SHORTCUT_NAME "IDBots"
!define INSTALL_REGISTRY_KEY "Software\ai.idbots.app"

!macro _HarnessFlag _a _b _t _f
  StrCmp "0" "1" `${_t}` `${_f}`
!macroend
!define isUpdated `"" _HarnessFlag ""`
!define UAC_IsInnerInstance `"" _HarnessFlag ""`
!define UAC_IsAdmin `"" _HarnessFlag ""`

!macro WinShell::SetLnkAUMI shortcut appId
  DetailPrint "SetLnkAUMI ${shortcut} ${appId}"
!macroend

LangString appRunning 0 "IDBots is running."
LangString appCannotBeClosed 0 "IDBots cannot be closed."

!include "${IDBOTS_NSIS_SCRIPT}"

Var newDesktopLink
Var newStartMenuLink
Var appExe

OutFile "${IDBOTS_NSIS_OUTPUT}"
Section "harness"
  StrCpy $newDesktopLink "$DESKTOP\IDBots.lnk"
  StrCpy $newStartMenuLink "$SMPROGRAMS\IDBots.lnk"
  StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro customCheckAppRunning
  !insertmacro customInit
  !insertmacro customInstall
SectionEnd
