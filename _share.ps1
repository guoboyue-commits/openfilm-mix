
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class ShareRead {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint creation, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool ReadFile(IntPtr h, byte[] buf, uint n, out uint read, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr h);
  public static string Copy(string src, string dst) {
    const uint GENERIC_READ = 0x80000000;
    const uint SHARE_ALL = 0x1 | 0x2 | 0x4;
    const uint OPEN_EXISTING = 3;
    const uint FLAG_BACKUP = 0x02000000;
    IntPtr h = CreateFileW(src, GENERIC_READ, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FLAG_BACKUP, IntPtr.Zero);
    if (h == new IntPtr(-1)) return "ERR CreateFile " + Marshal.GetLastWin32Error();
    try {
      using (var outS = new FileStream(dst, FileMode.Create, FileAccess.Write)) {
        byte[] buf = new byte[65536];
        uint read;
        while (ReadFile(h, buf, (uint)buf.Length, out read, IntPtr.Zero) && read > 0) {
          outS.Write(buf, 0, (int)read);
        }
      }
      return "OK " + new FileInfo(dst).Length;
    } finally { CloseHandle(h); }
  }
}
"@
$src = 'C:\Users\kwok\AppData\Local\Google\Chrome\User Data\Default\Network\Cookies'
$dst = 'C:\Users\kwok\AppData\Local\Temp\of-chrome-prof\Default\Network\Cookies'
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
[ShareRead]::Copy($src, $dst)
