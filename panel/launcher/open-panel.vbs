' Don Robert Cafe Wi-Fi panel launcher (used by the desktop icon).
' Opens the cloud panel in its own app window (Chrome or Edge, no tabs or address bar).
Option Explicit
Dim sh, fso, url, browser
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
url = "https://panel-drab-nine.vercel.app/"

browser = FindBrowser()
If browser <> "" Then
  sh.Run """" & browser & """ --app=" & url, 1, False
Else
  sh.Run url
End If

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
