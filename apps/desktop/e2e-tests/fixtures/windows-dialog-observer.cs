using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class TouchAIStartupDialogObserver
{
    private const uint WM_CLOSE = 0x0010;

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximumLength);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder className, int maximumLength);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    private static string WindowText(IntPtr window)
    {
        var text = new StringBuilder(512);
        GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }

    private static string WindowClass(IntPtr window)
    {
        var className = new StringBuilder(256);
        GetClassName(window, className, className.Capacity);
        return className.ToString();
    }

    private static IntPtr FindStartupDialog()
    {
        var match = IntPtr.Zero;
        EnumWindows(
            (window, _) =>
            {
                if (!IsWindowVisible(window)) return true;
                if (WindowClass(window) != "#32770" || WindowText(window) != "TouchAI") return true;
                match = window;
                return false;
            },
            IntPtr.Zero
        );
        return match;
    }

    private static void PrintVisibleWindows()
    {
        Console.Error.WriteLine("Startup dialog not found. Visible top-level windows:");
        EnumWindows(
            (window, _) =>
            {
                if (IsWindowVisible(window))
                {
                    uint processId;
                    GetWindowThreadProcessId(window, out processId);
                    Console.Error.WriteLine(
                        "pid=" + processId + " class=" + WindowClass(window) + " title=" + WindowText(window)
                    );
                }
                return true;
            },
            IntPtr.Zero
        );
    }

    public static int Main(string[] arguments)
    {
        var timeoutMilliseconds = 12000;
        if (arguments.Length > 0 && !int.TryParse(arguments[0], out timeoutMilliseconds))
        {
            Console.Error.WriteLine("Dialog timeout must be an integer.");
            return 2;
        }

        var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
        while (DateTime.UtcNow < deadline)
        {
            var dialog = FindStartupDialog();
            if (dialog != IntPtr.Zero)
            {
                uint processId;
                GetWindowThreadProcessId(dialog, out processId);
                var closed = PostMessage(dialog, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                Console.WriteLine(
                    "found=true pid="
                        + processId
                        + " class=#32770 title=TouchAI closed="
                        + closed.ToString().ToLowerInvariant()
                );
                return closed ? 0 : 1;
            }
            Thread.Sleep(100);
        }

        PrintVisibleWindows();
        Console.Error.WriteLine("Startup dialog did not appear within " + timeoutMilliseconds + "ms.");
        return 3;
    }
}
