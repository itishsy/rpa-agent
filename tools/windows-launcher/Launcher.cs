using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class Program
{
    private const string CoreName = "rpa-agent-core.exe";
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr owner, string text, string caption, uint type);

    [STAThread]
    private static int Main(string[] args)
    {
        string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        string inheritedNodeMode = Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE") ?? "";
        Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", null);
        string corePath = Path.Combine(baseDirectory, CoreName);
        WriteDiagnostic(baseDirectory, "launch start user=" + Environment.UserName +
            " session=" + Process.GetCurrentProcess().SessionId +
            " ELECTRON_RUN_AS_NODE=" + inheritedNodeMode +
            " args=" + JoinArguments(args));
        if (!File.Exists(corePath))
        {
            WriteError(baseDirectory, "未找到 " + CoreName + "，请保留完整的 rpa-agent 目录。");
            MessageBox(IntPtr.Zero, "未找到 " + CoreName + "，请保留完整的 rpa-agent 目录。", "rpa-agent 启动失败", 0x10);
            return 2;
        }

        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = corePath,
                // Apply Windows compatibility flags before Chromium initializes.
                // Main-process JavaScript runs after the native sandbox startup.
                Arguments = "--disable-features=TSFImeSupport --no-sandbox --disable-gpu" +
                    (args.Length > 0 ? " " + JoinArguments(args) : ""),
                WorkingDirectory = baseDirectory,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using (Process process = Process.Start(startInfo))
            {
                if (process != null) WriteDiagnostic(baseDirectory, "core pid=" + process.Id);
                if (process != null && process.WaitForExit(3000) && process.ExitCode != 0)
                {
                    string failure = "Electron core exited early with code " + process.ExitCode + " (0x" + process.ExitCode.ToString("X8") + ").";
                    WriteError(baseDirectory, failure);
                    MessageBox(IntPtr.Zero, failure + Environment.NewLine + "诊断日志：" +
                        Path.Combine(baseDirectory, "launcher-error.log"), "rpa-agent 启动失败", 0x10);
                    return 3;
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            WriteError(baseDirectory, error.ToString());
            MessageBox(IntPtr.Zero, error.Message, "rpa-agent 启动失败", 0x10);
            return 1;
        }
    }

    private static string JoinArguments(string[] args)
    {
        var result = new StringBuilder();
        for (int index = 0; index < args.Length; index++)
        {
            if (index > 0) result.Append(' ');
            result.Append(Quote(args[index]));
        }
        return result.ToString();
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        var result = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes++;
            }
            else if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
            }
            else
            {
                result.Append('\\', backslashes);
                result.Append(character);
                backslashes = 0;
            }
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static void WriteError(string baseDirectory, string message)
    {
        try
        {
            File.AppendAllText(Path.Combine(baseDirectory, "launcher-error.log"),
                DateTimeOffset.Now.ToString("O") + " " + message.Replace("\r", " ").Replace("\n", " ") + Environment.NewLine);
        }
        catch
        {
        }
    }

    private static void WriteDiagnostic(string baseDirectory, string message)
    {
        try
        {
            File.AppendAllText(Path.Combine(baseDirectory, "launcher.log"),
                DateTimeOffset.Now.ToString("O") + " " + message.Replace("\r", " ").Replace("\n", " ") + Environment.NewLine);
        }
        catch
        {
        }
    }
}
