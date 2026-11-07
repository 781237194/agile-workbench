Option Explicit
Dim sh
Dim fso
Dim base
Dim cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = """" & base & "\start.cmd"""
sh.Environment("PROCESS")("AWB_NO_PAUSE") = "1"
sh.Run cmd, 0, False
