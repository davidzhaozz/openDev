# Resident process-table host for OpenDev IDE.
#
# Launched once per session by src/main/psHost.ts and kept alive; it answers
# newline-delimited queries on stdin and terminates each reply with a sentinel
# line. See that file for why this is a resident host rather than one spawn
# per query (short version: a spawn costs 1.5-2.8s on an EDR-monitored box,
# and the services panel polls every 4s).
#
# This ships as a plain, readable script on disk and is run with -File rather
# than being passed to -EncodedCommand. Base64 on a PowerShell command line is
# a high-signal indicator for every EDR product on the market, and this script
# does nothing that needs hiding — an analyst reading it should be able to see
# that in full within about a minute. It is Authenticode-signed at build time
# with the same certificate as the app binaries, so it also satisfies an
# AllSigned execution policy and survives a Mark-of-the-Web.
#
# The two sentinel strings below are duplicated in src/main/psHost.ts (READY
# and SENTINEL). Change one, change the other.

$ErrorActionPreference = 'SilentlyContinue'
$script:UseNative = $false
try {
  # The C# is emitted with (char)44 / (char)10 rather than '\,' / '\n' escapes
  # on purpose: this source passes through a PowerShell here-string before the
  # C# compiler sees it, and the escape does not survive both intact.
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OpenDevProc {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct PROCESSENTRY32W {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID;
    public IntPtr th32DefaultHeapID; public uint th32ModuleID; public uint cntThreads;
    public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr h);
  public static string Snapshot() {
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return "";
    try {
      StringBuilder sb = new StringBuilder(16384);
      PROCESSENTRY32W e = new PROCESSENTRY32W();
      e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (Process32FirstW(snap, ref e)) {
        do { sb.Append(e.th32ProcessID).Append((char)44).Append(e.th32ParentProcessID).Append((char)10); }
        while (Process32NextW(snap, ref e));
      }
      return sb.ToString();
    } finally { CloseHandle(snap); }
  }
}
'@
  # Prove it actually runs before committing to it; a type that compiles but
  # throws on call would otherwise blank the port display every poll.
  if ([OpenDevProc]::Snapshot().Length -gt 0) { $script:UseNative = $true }
} catch { $script:UseNative = $false }

[Console]::Out.WriteLine('<<OPENDEV-READY>>')
[Console]::Out.Flush()

while ($true) {
  $cmd = [Console]::In.ReadLine()
  if ($null -eq $cmd -or $cmd -eq 'quit') { break }
  try {
    if ($cmd -eq 'pmap') {
      if ($script:UseNative) {
        [Console]::Out.Write([OpenDevProc]::Snapshot())
      } else {
        Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId FROM Win32_Process' |
          ForEach-Object { [Console]::Out.WriteLine("$($_.ProcessId),$($_.ParentProcessId)") }
      }
    }
  } catch { }
  [Console]::Out.WriteLine('<<OPENDEV-EOF>>')
  [Console]::Out.Flush()
}
