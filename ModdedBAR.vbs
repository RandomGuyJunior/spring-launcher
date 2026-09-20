Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d ""C:\GitHub\spring-launcher"" && npm.cmd start", 0, False