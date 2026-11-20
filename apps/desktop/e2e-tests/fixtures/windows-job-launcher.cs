using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class TouchAIStartupJobLauncher
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private static string QuoteArgument(string argument)
    {
        if (
            argument.Length > 0
            && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0
        )
        {
            return argument;
        }

        var result = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in argument)
        {
            if (character == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            if (backslashes > 0)
            {
                result.Append('\\', backslashes);
                backslashes = 0;
            }
            result.Append(character);
        }
        if (backslashes > 0) result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static string BuildCommandLine(string[] arguments)
    {
        var commandLine = new StringBuilder();
        foreach (var argument in arguments)
        {
            if (commandLine.Length > 0) commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }
        return commandLine.ToString();
    }

    private static void Check(bool succeeded, string operation)
    {
        if (succeeded) return;
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    private static int Run(string[] arguments)
    {
        if (arguments.Length == 0) throw new ArgumentException("An application path is required.");

        var job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());

        try
        {
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            var limitsSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            var limitsPointer = Marshal.AllocHGlobal(limitsSize);
            try
            {
                Marshal.StructureToPtr(limits, limitsPointer, false);
                Check(
                    SetInformationJobObject(
                        job,
                        JobObjectExtendedLimitInformation,
                        limitsPointer,
                        (uint)limitsSize
                    ),
                    "SetInformationJobObject"
                );
            }
            finally
            {
                Marshal.FreeHGlobal(limitsPointer);
            }

            var startupInfo = new STARTUPINFO();
            startupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            PROCESS_INFORMATION processInformation;
            Check(
                CreateProcess(
                    arguments[0],
                    new StringBuilder(BuildCommandLine(arguments)),
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED,
                    IntPtr.Zero,
                    null,
                    ref startupInfo,
                    out processInformation
                ),
                "CreateProcess"
            );

            try
            {
                var resumed = false;
                try
                {
                    Check(
                        AssignProcessToJobObject(job, processInformation.hProcess),
                        "AssignProcessToJobObject"
                    );
                    if (ResumeThread(processInformation.hThread) == uint.MaxValue)
                    {
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
                    }
                    resumed = true;
                }
                catch
                {
                    if (!resumed)
                    {
                        if (!TerminateProcess(processInformation.hProcess, 125))
                        {
                            Console.Error.WriteLine(
                                "TerminateProcess failed: " + Marshal.GetLastWin32Error()
                            );
                        }
                        else if (WaitForSingleObject(processInformation.hProcess, 5000) != 0)
                        {
                            Console.Error.WriteLine(
                                "WaitForSingleObject failed after termination: " +
                                Marshal.GetLastWin32Error()
                            );
                        }
                    }
                    throw;
                }

                if (WaitForSingleObject(processInformation.hProcess, INFINITE) != 0)
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed");
                }

                uint exitCode;
                Check(GetExitCodeProcess(processInformation.hProcess, out exitCode), "GetExitCodeProcess");
                TerminateJobObject(job, exitCode);
                return unchecked((int)exitCode);
            }
            finally
            {
                CloseHandle(processInformation.hThread);
                CloseHandle(processInformation.hProcess);
            }
        }
        finally
        {
            CloseHandle(job);
        }
    }

    public static int Main(string[] arguments)
    {
        try
        {
            return Run(arguments);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Startup job launcher failed: " + error);
            return 125;
        }
    }
}
