Option Explicit
' Desktop Organizer launcher - keeps a hidden Node process in the background.
' Node is located at runtime (bundled node\ -> PATH -> standard dirs -> the
' runtime shipped with WorkBuddy), so this file is not tied to one machine,
' one Node version, or one packaging style.
Dim fso, sh, base, nodeExe, pool, candidates, i, cmd, fromPath, ex, ln, sub_

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

' 0) the Node bundled in this folder (portable build): <here>\node\node.exe.
'    Checked first, so the portable copy always runs on its own runtime and
'    never picks up some older Node that happens to be on PATH.
pool = ""
If fso.FileExists(base & "\node\node.exe") Then pool = pool & base & "\node\node.exe" & vbCrLf

' 1) the node on PATH, if there is one
fromPath = ""
On Error Resume Next
Set ex = sh.Exec(sh.ExpandEnvironmentStrings("%ComSpec%") & " /c where node.exe 2>nul")
If Err.Number = 0 Then
  Do While Not ex.StdOut.AtEndOfStream
    ln = Trim(ex.StdOut.ReadLine())
    If ln <> "" Then
      fromPath = ln
      Exit Do
    End If
  Loop
End If
Err.Clear
On Error GoTo 0

' 2) standard install locations, 3) every version folder shipped with WorkBuddy
If fromPath <> "" Then pool = pool & fromPath & vbCrLf
pool = pool & sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe" & vbCrLf
pool = pool & sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\nodejs\node.exe" & vbCrLf

Dim verRoot, folders
verRoot = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.workbuddy\binaries\node\versions"
Set folders = Nothing
On Error Resume Next
Set folders = fso.GetFolder(verRoot)
On Error GoTo 0
If Not folders Is Nothing Then
  For Each sub_ In folders.SubFolders
    pool = pool & sub_.Path & "\node.exe" & vbCrLf
  Next
End If

candidates = Split(pool, vbCrLf)
nodeExe = ""
For i = 0 To UBound(candidates)
  If candidates(i) <> "" Then
    If fso.FileExists(candidates(i)) Then
      nodeExe = candidates(i)
      Exit For
    End If
  End If
Next

If nodeExe = "" Then
  MsgBox "Node.js was not found." & vbCrLf & vbCrLf & _
         "Please install Node.js 18+ (https://nodejs.org) and run again.", _
         16, "Desktop Organizer"
  WScript.Quit
End If

cmd = """" & nodeExe & """ """ & base & "\server.js"""

On Error Resume Next
sh.Run cmd, 0, False
If Err.Number <> 0 Then
  Err.Clear
  sh.Run "node """ & base & "\server.js""", 0, False
  If Err.Number <> 0 Then
    MsgBox "Could not start the organizer." & vbCrLf & vbCrLf & _
           "Node was found at:" & vbCrLf & nodeExe, 16, "Desktop Organizer"
  End If
End If
