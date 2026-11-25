// 桌面整理器 · 启动器
//
// 只做一件事：找到 Node 运行时，把同目录的 server.js 跑起来，然后自己退出。
// 编译成 GUI 程序（没有黑窗口），所以用户看到的就是双击一个 exe、窗口直接打开。
//
// Node 的查找顺序和 桌面整理器.vbs / .bat 完全一致：
//   1) 本目录 node\node.exe（便携版自带）
//   2) 系统 PATH 里的 node.exe
//   3) %ProgramFiles%\nodejs、%ProgramFiles(x86)%\nodejs
//   4) %USERPROFILE%\.workbuddy\binaries\node\versions\*
//
// 找不到、或者 server.js 一启动就退出（非 0）时，弹一个中文提示框，
// 而不是静默失败。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

static class Program
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    const uint MB_ICONERROR = 0x10;
    const uint MB_ICONWARNING = 0x30;

    // 等这么久还没退出，就当它起成功了（server 正常是要一直跑着的）
    const int GRACE_MS = 2500;

    [STAThread]
    static int Main()
    {
        // 高 DPI 下提示框不发虚。老系统没有这个 API，失败就算了。
        try { SetProcessDpiAwarenessContext((IntPtr)(-4)); } catch { }

        string dir = AppDomain.CurrentDomain.BaseDirectory;
        if (dir.EndsWith("\\")) dir = dir.Substring(0, dir.Length - 1);

        try
        {
            return Run(dir);
        }
        catch (Exception e)
        {
            Notify("启动失败：" + e.Message, MB_ICONERROR);
            return 1;
        }
    }

    static int Run(string dir)
    {
        string server = Path.Combine(dir, "server.js");
        if (!File.Exists(server))
        {
            Notify("这个文件夹里没有 server.js，可能压缩包没解压完整。\n\n请重新解压整个压缩包后再双击本程序。", MB_ICONERROR);
            return 1;
        }

        string node = FindNode(dir);
        if (node == null)
        {
            Notify(
                "没找到 Node.js 运行时。\n\n" +
                "如果你用的是「便携版」，正常情况下 node\\node.exe 就在本文件夹里，\n" +
                "现在它不见了 —— 请重新解压整个压缩包。\n\n" +
                "如果用的是「标准版」，请先到 https://nodejs.org 装一个 18 以上版本。\n\n" +
                "也可以用同目录的 桌面整理器.vbs 启动，效果一样。",
                MB_ICONERROR);
            return 1;
        }

        ProcessStartInfo psi = new ProcessStartInfo(node, "\"" + server + "\"");
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;

        Process p = Process.Start(psi);
        if (p == null)
        {
            Notify("无法启动 Node 运行时：\n" + node, MB_ICONERROR);
            return 1;
        }

        // 已经有一个在跑的话，server.js 会自己把窗口叫出来然后正常退出（0），
        // 所以只有非 0 才算真失败。
        if (p.WaitForExit(GRACE_MS))
        {
            int code = p.ExitCode;
            if (code != 0)
            {
                string log = Path.Combine(dir, "data", "error.log");
                Notify(
                    "程序没能启动（退出码 " + code + "）。\n\n" +
                    (File.Exists(log)
                        ? "详细原因记在这里：\n" + log
                        : "没有生成日志文件，通常是 Node 版本太老或文件被拦。") + "\n\n" +
                    "可以试试同目录的 桌面整理器.vbs，或者在文件夹里双击 桌面整理器.bat，\n" +
                    "黑窗口里会显示它找过哪些位置。",
                    MB_ICONERROR);
                return code;
            }
        }

        return 0;
    }

    static string FindNode(string dir)
    {
        List<string> candidates = new List<string>();

        candidates.Add(Path.Combine(dir, "node", "node.exe"));

        string pathVar = Environment.GetEnvironmentVariable("PATH");
        if (!string.IsNullOrEmpty(pathVar))
        {
            foreach (string raw in pathVar.Split(';'))
            {
                string seg = raw.Trim().Trim('"');
                if (seg.Length == 0) continue;
                try
                {
                    string exe = Path.Combine(seg, "node.exe");
                    if (File.Exists(exe)) { candidates.Add(exe); break; }
                }
                catch { }
            }
        }

        AddUnder(candidates, Environment.GetEnvironmentVariable("ProgramFiles"), "nodejs");
        AddUnder(candidates, Environment.GetEnvironmentVariable("ProgramFiles(x86)"), "nodejs");

        try
        {
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string verRoot = Path.Combine(profile, ".workbuddy\\binaries\\node\\versions");
            if (Directory.Exists(verRoot))
            {
                string[] subs = Directory.GetDirectories(verRoot);
                Array.Sort(subs, StringComparer.OrdinalIgnoreCase);
                for (int i = subs.Length - 1; i >= 0; i--) // 新版本排在后面，倒着试
                    candidates.Add(Path.Combine(subs[i], "node.exe"));
            }
        }
        catch { }

        foreach (string c in candidates)
            if (File.Exists(c)) return c;

        return null;
    }

    static void AddUnder(List<string> list, string root, string sub)
    {
        if (string.IsNullOrEmpty(root)) return;
        try { list.Add(Path.Combine(Path.Combine(root, sub), "node.exe")); } catch { }
    }

    // 正常弹提示框；设了 WB_LAUNCHER_SILENT=1 时改成写日志文件（自动化测试用，
    // 顺便也方便以后排查"双击没反应"的机器）。
    static void Notify(string msg, uint icon)
    {
        if (Environment.GetEnvironmentVariable("WB_LAUNCHER_SILENT") == "1")
        {
            try
            {
                string dir = AppDomain.CurrentDomain.BaseDirectory;
                File.AppendAllText(Path.Combine(dir, "launcher-error.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg.Replace("\n", " / ") + "\r\n");
            }
            catch { }
            return;
        }
        MessageBoxW(IntPtr.Zero, msg, "桌面整理器", icon);
    }
}
