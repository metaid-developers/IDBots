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
!define isUpdated `"" HarnessFlag ""`
!define UAC_IsInnerInstance `"" HarnessFlag ""`
!define UAC_IsAdmin `"" HarnessFlag ""`
!define UAC_SYNCREGISTERS 0x1
!define UAC_SYNCOUTDIR 0x4
!define UAC_SYNCINSTDIR 0x8

!macro UAC_AsUser_Call type name flags
  Call ${name}
!macroend

!macro _HarnessExecShlUser out file verb args
  DetailPrint "ExecShellAsUser ${file} ${verb} ${args}"
  StrCpy ${out} "ok"
!macroend
!define StdUtils.ExecShellAsUser `!insertmacro _HarnessExecShlUser`

!macro MUI_PAGE_FINISH
  Page instfiles
  Page custom StartApp
!macroend

!macro WinShell::SetLnkAUMI shortcut appId
  DetailPrint "SetLnkAUMI ${shortcut} ${appId}"
!macroend

LangString appRunning 0 "IDBots is running."
LangString appCannotBeClosed 0 "IDBots cannot be closed."

!include "${IDBOTS_NSIS_SCRIPT}"

!ifndef BUILD_UNINSTALLER
  Var newDesktopLink
  Var newStartMenuLink
  Var appExe

  !insertmacro customFinishPage
!endif

OutFile "${IDBOTS_NSIS_OUTPUT}"
!ifdef BUILD_UNINSTALLER
Section "harness"
  WriteUninstaller "${IDBOTS_NSIS_OUTPUT}.uninst.exe"
SectionEnd
Section "un.harness"
  !insertmacro customCheckAppRunning
SectionEnd
!else
Section "harness"
  StrCpy $newDesktopLink "$DESKTOP\IDBots.lnk"
  StrCpy $newStartMenuLink "$SMPROGRAMS\IDBots.lnk"
  StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro customCheckAppRunning
  !insertmacro customInit
  !insertmacro customInstall
SectionEnd
!endif
