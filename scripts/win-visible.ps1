# Is there a *visible* top-level window owned by this process id?
param([Parameter(Mandatory = $true)][int]$Pid2)
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinVis {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<IntPtr> Tops = new List<IntPtr>();
  public static bool Cb(IntPtr h, IntPtr l) { Tops.Add(h); return true; }
  public static List<IntPtr> All() { Tops.Clear(); EnumWindows(Cb, IntPtr.Zero); return Tops; }
}
"@
$visible = @()
foreach ($h in [WinVis]::All()) {
  $p = 0
  [void][WinVis]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -ne $Pid2) { continue }
  if (-not [WinVis]::IsWindowVisible($h)) { continue }
  $sb = New-Object System.Text.StringBuilder 512
  [void][WinVis]::GetWindowText($h, $sb, 512)
  $t = $sb.ToString()
  if ($t.Length -eq 0) { continue }
  $visible += ("hwnd=" + $h + " minimized=" + [WinVis]::IsIconic($h) + " title='" + $t + "'")
}
Write-Output ("VISIBLE_WINDOWS=" + $visible.Count)
foreach ($v in $visible) { Write-Output ("  " + $v) }
