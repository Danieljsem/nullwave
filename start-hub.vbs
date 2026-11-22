' Nullwave hub: starts the local server for the live wallpaper, hidden (no window).
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "node """ & root & "\hub\server.js""", 0, False
