; Syntax harness for scripts/nsis-installer.nsh — mimics how electron-builder
; consumes it: defines the APP_* macros, includes the .nsh (macro definitions),
; and expands customInit so the whole macro body gets compiled.
Unicode true
!define APP_EXECUTABLE_FILENAME "IDBots.exe"
!include "/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/nsis-systemdrive/scripts/nsis-installer.nsh"
OutFile "/tmp/nsis-harness-output.exe"
Section "harness"
  !insertmacro customInit
SectionEnd
