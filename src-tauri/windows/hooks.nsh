; Crochets de l'installateur NSIS de la version Tauri (voir bundle.windows.nsis.installerHooks
; dans tauri.conf.json).
;
; Passage depuis la version Electron : avant d'installer, on désinstalle silencieusement
; l'ancienne app si elle est présente. Sa config (%APPDATA%\ElectrumOverlay\config) n'est PAS
; touchée par cette désinstallation (electron-builder la conserve par défaut) et la version Tauri
; la reprend telle quelle.
;
; Reconnaissance de l'ancienne app dans le registre (HKCU, installation par utilisateur) :
; - nom affiché « ElectrumOverlay <version> » (electron-builder ajoute la version ; la version
;   Tauri s'affiche « ElectrumOverlay » tout court) ;
; - désinstalleur nommé « Uninstall ElectrumOverlay.exe ».
; Désinstaller AVANT d'installer évite que l'ancien désinstalleur ne supprime les nouveaux
; raccourcis, qui portent le même nom.

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $0 0
  electrum_cherche_ancienne:
    EnumRegKey $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" electrum_fin
    IntOp $0 $0 + 1
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    StrCpy $3 $2 16
    StrCmp $3 "ElectrumOverlay " 0 electrum_cherche_ancienne
    ReadRegStr $4 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "QuietUninstallString"
    StrCmp $4 "" 0 electrum_desinstalle
    ReadRegStr $4 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    StrCmp $4 "" electrum_cherche_ancienne
    StrCpy $4 "$4 /S"
  electrum_desinstalle:
    DetailPrint "Désinstallation de l'ancienne version ($2)..."
    ExecWait $4
  electrum_fin:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; Désinstallation (pas lors d'une mise à jour, qui passe aussi par le désinstalleur avec /UPDATE) :
; retire l'entrée « démarrer avec Windows » créée depuis Paramètres › Application.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ElectrumOverlay"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "ElectrumOverlay"
  ${EndIf}
!macroend
