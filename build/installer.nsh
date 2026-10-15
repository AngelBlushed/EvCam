; EvCam – extra install / uninstall steps (included by electron-builder's NSIS template)
; This file is saved as UTF-8 WITH a byte-order mark so that the accented text below is read correctly.

!macro customInstall
  ; Make "EvCam" appear as a webcam in every application.
  ; Per-user installs register for the current user only (no administrator rights needed);
  ; all-users installs register system-wide and open the firewall so the phone can connect.
  ${if} $installMode == "all"
    nsExec::Exec '"$INSTDIR\resources\vcam\x64\evcam-vcam-setup.exe" --register --machine "$INSTDIR\resources\vcam\x64\evcam_vcam.dll"'
    Pop $0
    nsExec::Exec '"$INSTDIR\resources\vcam\x86\evcam-vcam-setup.exe" --register --machine "$INSTDIR\resources\vcam\x86\evcam_vcam.dll"'
    Pop $0
    nsExec::Exec 'netsh advfirewall firewall delete rule name="EvCam"'
    Pop $0
    nsExec::Exec 'netsh advfirewall firewall add rule name="EvCam" dir=in action=allow program="$INSTDIR\EvCam.exe" enable=yes profile=any'
    Pop $0
  ${else}
    nsExec::Exec '"$INSTDIR\resources\vcam\x64\evcam-vcam-setup.exe" --register "$INSTDIR\resources\vcam\x64\evcam_vcam.dll"'
    Pop $0
    nsExec::Exec '"$INSTDIR\resources\vcam\x86\evcam-vcam-setup.exe" --register "$INSTDIR\resources\vcam\x86\evcam_vcam.dll"'
    Pop $0
  ${endif}

  ; Virtual microphone for people who do not have the free VB-CABLE driver yet: ask first, then EvCam downloads
  ; the official package, checks its signature and installs it (Windows asks for the administrator approval).
  ${ifNot} ${Silent}
    ExecWait '"$INSTDIR\EvCam.exe" --mic-present' $0
    ${if} $0 != 0
      MessageBox MB_YESNO|MB_ICONQUESTION "Micro virtuel pour vos applications$\r$\n$\r$\nEvCam peut créer le micro « EvCam Micro » (Discord, Zoom, OBS…) en installant le pilote audio gratuit VB-CABLE, de VB-Audio.$\r$\n$\r$\n•  Téléchargement officiel depuis vb-audio.com (environ 1,3 Mo), signature numérique vérifiée$\r$\n•  Windows vous demandera l’autorisation administrateur$\r$\n$\r$\nInstaller le micro virtuel maintenant ?" /SD IDNO IDNO evcam_mic_skip
      ExecWait '"$INSTDIR\EvCam.exe" --setup-mic'
      evcam_mic_skip:
    ${endif}
  ${endif}
!macroend

!macro customUnInstall
  ${if} $installMode == "all"
    nsExec::Exec '"$INSTDIR\resources\vcam\x64\evcam-vcam-setup.exe" --unregister --machine "$INSTDIR\resources\vcam\x64\evcam_vcam.dll"'
    Pop $0
    nsExec::Exec '"$INSTDIR\resources\vcam\x86\evcam-vcam-setup.exe" --unregister --machine "$INSTDIR\resources\vcam\x86\evcam_vcam.dll"'
    Pop $0
    nsExec::Exec 'netsh advfirewall firewall delete rule name="EvCam"'
    Pop $0
  ${endif}
  ; the per-user registration may exist in either mode (the app repairs it on start)
  nsExec::Exec '"$INSTDIR\resources\vcam\x64\evcam-vcam-setup.exe" --unregister "$INSTDIR\resources\vcam\x64\evcam_vcam.dll"'
  Pop $0
  nsExec::Exec '"$INSTDIR\resources\vcam\x86\evcam-vcam-setup.exe" --unregister "$INSTDIR\resources\vcam\x86\evcam_vcam.dll"'
  Pop $0
  ; "start with Windows" entry written by the app
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.evcam.app"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "EvCam"
!macroend
