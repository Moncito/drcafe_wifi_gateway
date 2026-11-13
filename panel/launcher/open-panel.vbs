' Don Robert Cafe Wi-Fi panel launcher (used by the desktop icon).
' 1. If the panel isn't running yet, start it in the background (no black window).
' 2. Open it in its own app window (Chrome or Edge, no tabs or address bar).
Option Explicit
Dim sh, fso, panelDir, url, i, browser
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
panelDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
url = "http://127.0.0.1:8080/"

If Not PanelUp() Then
  sh.CurrentDirectory = panelDir
  sh.Run "cmd /c """ & panelDir & "\start-panel.cmd""", 0, False   ' 0 = hidden window
  For i = 1 To 40
    WScript.Sleep 500
    If PanelUp() Then Exit For
  Next
  If Not PanelUp() Then
    MsgBox "The Wi-Fi panel did not start." & vbCrLf & vbCrLf & _
           "Open the panel folder and double-click start-panel.cmd to see the error.", vbExclamation, "Don Robert Wi-Fi"
    WScript.Quit 1
  End If
End If

browser = FindBrowser()
If browser <> "" Then
  sh.Run """" & browser & """ --app=" & url, 1, False
Else
  sh.Run url
End If

Function PanelUp()
  Dim h
  On Error Resume Next
  Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  h.setTimeouts 800, 800, 800, 800
  h.open "GET", url & "login", False
  h.send
  PanelUp = (Err.Number = 0)
  If PanelUp Then PanelUp = (h.status > 0)
  On Error GoTo 0
End Function

Function FindBrowser()
  Dim c, candidates
  candidates = Array( _
    sh.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe"), _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"), _
    sh.ExpandEnvironmentStrings("%LocalAppData%\Google\Chrome\Application\chrome.exe"), _
    sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"), _
    sh.ExpandEnvironmentStrings("%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"))
  FindBrowser = ""
  For Each c In candidates
    If fso.FileExists(c) Then
      FindBrowser = c
      Exit Function
    End If
  Next
End Function
