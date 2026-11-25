Option Explicit
' Creates a desktop shortcut for this tool.
' Node is located at runtime (bundled node\ -> PATH -> standard dirs -> the
' runtime shipped with WorkBuddy), so this file works on any machine.
Dim fso, sh, base, nodeExe, pool, candidates, i, cmd, fromPath, ex, ln, sub_, verRoot, folders

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

' 0) the Node bundled in this folder (portable build), checked first
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

cmd = """" & nodeExe & """ """ & base & "\install-shortcut.js"""

On Error Resume Next
sh.Run cmd, 1, True
If Err.Number <> 0 Then
  MsgBox "Could not create the shortcut." & vbCrLf & vbCrLf & _
         "Node was found at:" & vbCrLf & nodeExe, 16, "Desktop Organizer"
  WScript.Quit
End If
On Error GoTo 0

MsgBox "A shortcut named 'Desktop Organizer' has been created on your Desktop.", 64, "Desktop Organizer"
