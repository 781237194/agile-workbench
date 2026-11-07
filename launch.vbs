Option Explicit
' PM工作台隐藏启动器：由桌面快捷方式调用，不显示 cmd 控制台。
Dim shell, fso, base, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = """" & base & "\start.cmd"""
shell.Environment("PROCESS")("AWB_NO_PAUSE") = "1"
' 0 = 隐藏窗口，False = 不等待 start.cmd 退出（Electron 自己保持运行）。
shell.Run cmd, 0, False
