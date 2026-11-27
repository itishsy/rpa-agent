Option Explicit

Dim fso, shell, processEnvironment, baseDirectory, corePath, logPath, logFile, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set processEnvironment = shell.Environment("Process")

baseDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
corePath = fso.BuildPath(baseDirectory, "rpa-agent-core.exe")
logPath = fso.BuildPath(baseDirectory, "launcher.log")

If Not fso.FileExists(corePath) Then
  MsgBox "未找到 rpa-agent-core.exe，请保留完整的 rpa-agent 目录。", vbCritical, "rpa-agent 启动失败"
  WScript.Quit 2
End If

processEnvironment("ELECTRON_RUN_AS_NODE") = ""
shell.CurrentDirectory = baseDirectory

On Error Resume Next
Set logFile = fso.OpenTextFile(logPath, 8, True)
If Err.Number = 0 Then
  logFile.WriteLine Now & " launch shortcut"
  logFile.Close
End If
On Error GoTo 0

command = Chr(34) & corePath & Chr(34) & _
  " --no-sandbox --disable-features=TSFImeSupport --disable-gpu"
shell.Run command, 1, False
