' note-studio watchdog launcher (hidden, no console window)
' Invoked by scheduled task NoteStudio-AutoStart at logon.
' Launches watchdog.ps1 hidden and returns immediately.
Option Explicit
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""D:\VibeCoding\note apps\note-studio\watchdog.ps1""", 0, False
Set sh = Nothing
