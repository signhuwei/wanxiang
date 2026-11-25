!define ONEX_GIT_PREREQUISITE "${__FILEDIR__}\git-prerequisite.ps1"
!define ONEX_CLI_PATH "${__FILEDIR__}\cli-path.ps1"
!include WinMessages.nsh

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

!macro ONEX_UPDATE_CLI_PATH action
  Push $0
  InitPluginsDir
  File /oname=$PLUGINSDIR\onex-cli-path.ps1 "${ONEX_CLI_PATH}"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "$PLUGINSDIR\onex-cli-path.ps1" -Action ${action} -InstallDir "$INSTDIR"'
  Pop $0
  Delete "$PLUGINSDIR\onex-cli-path.ps1"
  StrCmp $0 "0" onex_cli_path_ready_${action}
  DetailPrint "OneX CLI PATH ${action} did not complete (status $0)."
  !if "${action}" == "Install"
    MessageBox MB_ICONEXCLAMATION|MB_OK "Setup could not register the onex command. You can start it directly at $INSTDIR\onex.exe. See the installer details." /SD IDOK
  !else
    MessageBox MB_ICONEXCLAMATION|MB_OK "Setup could not remove the OneX entry from your user PATH. See the installer details." /SD IDOK
  !endif
  Goto onex_cli_path_done_${action}
  onex_cli_path_ready_${action}:
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=2000
  onex_cli_path_done_${action}:
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ONEX_ENSURE_GIT
  !insertmacro ONEX_STOP_EDGE
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OneXEdge" '"$INSTDIR\onexd.exe"'
  Exec '"$INSTDIR\onexd.exe"'
  !insertmacro ONEX_UPDATE_CLI_PATH Install
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "OneXEdge"
  !insertmacro ONEX_STOP_EDGE
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro ONEX_UPDATE_CLI_PATH Uninstall
!macroend
