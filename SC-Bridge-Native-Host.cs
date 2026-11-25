using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

internal static class BridgeLauncher
{
    private static void Main()
    {
        string response = "{\"ok\":false}";
        try
        {
            using (var input = new BinaryReader(Console.OpenStandardInput()))
            {
                int size = input.ReadInt32();
                const string startRequest = "{\"action\":\"start\"}";
                if (size == startRequest.Length && Encoding.UTF8.GetString(input.ReadBytes(size)) == startRequest)
                {
                    var settings = File.ReadAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "bridge-launcher.txt"));
                    int port;
                    if (settings.Length == 2 && int.TryParse(settings[0], NumberStyles.None, CultureInfo.InvariantCulture, out port) &&
                        port >= 1 && port <= 65535 && StartBridge(port, settings[1]))
                    {
                        response = "{\"ok\":true,\"port\":" + port.ToString(CultureInfo.InvariantCulture) + "}";
                    }
                }
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Event Bridge launcher failed: " + error.GetType().Name);
        }

        byte[] message = Encoding.UTF8.GetBytes(response);
        using (var output = new BinaryWriter(Console.OpenStandardOutput()))
        {
            output.Write(message.Length);
            output.Write(message);
        }
    }

    private static bool StartBridge(int port, string script)
    {
        if (!Path.IsPathRooted(script) || Path.GetFileName(script) != "Start-SC-Event-Bridge.ps1" ||
            script.IndexOf('"') >= 0 || !File.Exists(script)) return false;

        var info = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"),
            Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\" -Port " +
                port.ToString(CultureInfo.InvariantCulture),
            WorkingDirectory = Path.GetDirectoryName(script),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        // Chrome and Edge can request the same port at the same time.
        using (var mutex = new Mutex(false, @"Local\LaplaceScEventBridgeStart-" + port))
        {
            try
            {
                if (!mutex.WaitOne(12000)) return false;
            }
            catch (AbandonedMutexException) { }

            try
            {
                using (var process = Process.Start(info))
                {
                    process.StandardInput.Close();
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    if (process.WaitForExit(25000)) return process.ExitCode == 0;
                    process.Kill();
                    return false;
                }
            }
            finally { mutex.ReleaseMutex(); }
        }
    }
}
