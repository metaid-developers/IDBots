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

; WinShell::SetLnkAUMI in nsis-installer.nsh is a PLUGIN call (an NSIS
; `Name::Call` token always resolves as a plugin — a same-named define or
; macro is never reached) and the harness NSIS distributions (brew / choco)
; do not carry the WinShell.dll that electron-builder's NSIS bundle ships.
; The harness therefore compiles with IDBOTS_NSIS_SYNTAX_HARNESS defined,
; which gates exactly those three fixed-string plugin one-liners inside
; customInstall. Every other line of the production macros still compiles
; here under -WX.

LangString appRunning 0 "IDBots is running."
LangString appCannotBeClosed 0 "IDBots cannot be closed."

!include "${IDBOTS_NSIS_SCRIPT}"

; Mirror electron-builder's REAL per-pass compile surface (verified against
; app-builder-lib 24.13.3 templates, run 44502506341's packaging failure):
;
;  - installer pass: .onInit's !else branch inserts customInit; the install
;    section body inserts customInstall; assistedInstaller's page block
;    (guarded !ifndef BUILD_UNINSTALLER) inserts customFinishPage and
;    PAGE_INSTALL_MODE, whose page function body inserts customInstallMode.
;  - uninstaller pass: NONE of the page block compiles, and .onInit /
;    install-section bodies are empty — EXCEPT assistedInstaller's !else
;    branch inserts PAGE_INSTALL_MODE again, whose !else branch
;    instantiates the page function with the un. prefix, so
;    customInstallMode's body STILL compiles (and its uninstall-mode page
;    variant runs at uninstall time). A $var it references must therefore
;    be declared in BOTH passes; a declaration guarded by
;    !ifndef BUILD_UNINSTALLER becomes warning 6000 here — fatal under
;    electron-builder's -WX — and silently empties the reference at
;    uninstaller runtime (run 44502506341 died exactly there).
;  - $appExe/$launchLink are template-declared installer-pass-only
;    (installer.nsi !else branch); newDesktopLink/newStartMenuLink are
;    template-declared unconditionally but referenced by no uninstaller-pass
;    code — newer NSIS (local brew 3.13) 6001-fatalizes unused vars under
;    -WX while the pinned 3.0.4.1 does not, so the wrapper declares them
;    installer-pass-only to stay green on BOTH gate NSIS versions.
!ifndef BUILD_UNINSTALLER
  Var appExe
  Var newDesktopLink
  Var newStartMenuLink
  Var isForceCurrentInstall
  Var isForceMachineInstall
!endif

!ifndef BUILD_UNINSTALLER
  !insertmacro customFinishPage
!endif

OutFile "${IDBOTS_NSIS_OUTPUT}"
!ifdef BUILD_UNINSTALLER
Section "harness"
  WriteUninstaller "${IDBOTS_NSIS_OUTPUT}.uninst.exe"
SectionEnd
Section "un.harness"
  ; The real uninstaller pass compiles uninstaller.nsh, whose only fragment
  ; hook is customUnInstall (undefined in this repo) — an empty uninstall
  ; payload is the faithful mirror; the section shell only exists so
  ; WriteUninstaller has something to embed.
SectionEnd
; The real BUILD_UNINSTALLER pass still compiles customInstallMode's body:
; assistedInstaller's !else branch inserts PAGE_INSTALL_MODE, whose !else
; branch instantiates the install-mode page function with the un. prefix,
; and that function body's !ifmacrodef customInstallmode (NSIS resolves
; macro names case-insensitively) compiles our customInstallMode. Mirror it
; so an installer-only $var declaration fails right here, exactly like the
; real pass (run 44502506341 died there under -WX).
Section "harness.uninstallmode-surface"
  !insertmacro customInstallMode
SectionEnd
!else
Section "harness"
  StrCpy $newDesktopLink "$DESKTOP\IDBots.lnk"
  StrCpy $newStartMenuLink "$SMPROGRAMS\IDBots.lnk"
  StrCpy $appExe "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro customCheckAppRunning
  !insertmacro customInit
  !insertmacro customInstallMode
  !insertmacro customInstall
SectionEnd
!endif
