Option Explicit
Dim sh, fso, q, d, target
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
q = Chr(34)
d = fso.GetParentFolderName(WScript.ScriptFullName)
target = d & "\connect_h3_cloud.bat"
sh.CurrentDirectory = d
sh.Run q & target & q, 1, False
