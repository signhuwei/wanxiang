!define ONEX_GIT_PREREQUISITE "${__FILEDIR__}\git-prerequisite.ps1"

!macro ONEX_ENSURE_GIT
  Push $0
  InitPluginsDir
  File /oname=$PLUGINSDIR\onex-git-prerequisite.ps1 "${ONEX_GIT_PREREQUISITE}"
  DetailPrint "Checking Git for Windows and installing it if needed..."
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\onex-git-prerequisite.ps1"'
  Pop $0
  Delete "$PLUGINSDIR\onex-git-prerequisite.ps1"
  StrCmp $0 "0" onex_git_ready
  DetailPrint "Git for Windows prerequisite failed (status $0)."
  MessageBox MB_ICONSTOP|MB_OK "OneX Desktop requires Git. Setup could not install or verify Git for Windows. Check your network or software installation policy, then retry setup. See the installer details for the error." /SD IDOK
  Pop $0
  SetErrorLevel 1
  Abort
  onex_git_ready:
  Pop $0
!macroend

!macro ONEX_STOP_EDGE
  IfFileExists "$INSTDIR\onex.exe" 0 onex_stop_edge_done
  nsExec::Exec /TIMEOUT=5000 '"$INSTDIR\onex.exe" shutdown'
  Pop $0
  onex_stop_edge_done:
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ONEX_ENSURE_GIT
  !insertmacro ONEX_STOP_EDGE
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OneXEdge" '"$INSTDIR\onexd.exe"'
  Exec '"$INSTDIR\onexd.exe"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OneXEdge"
  !insertmacro ONEX_STOP_EDGE
!macroend
