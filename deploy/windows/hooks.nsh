!macro ONEX_STOP_EDGE
  IfFileExists "$INSTDIR\onex.exe" 0 onex_stop_edge_done
  nsExec::Exec /TIMEOUT=5000 '"$INSTDIR\onex.exe" shutdown'
  Pop $0
  onex_stop_edge_done:
!macroend

!macro NSIS_HOOK_PREINSTALL
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
