/**
 * Embedded Windows sandbox launcher. PowerShell is only the bootstrap host;
 * the child itself is created by Win32 CreateProcess with AppContainer
 * security capabilities and assigned to a kill-on-close Job Object.
 *
 * Keeping this source in the Bun bundle avoids a sidecar installation gap.
 */
export const WINDOWS_APPCONTAINER_HELPER = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$Policy,
  [Parameter(Mandatory = $true)][string]$Executable,
  [Parameter(Mandatory = $true)][string]$TraceMode,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$TargetArgs
)

$ErrorActionPreference = "Stop"
$traceEnabled = $TraceMode -eq "on"
if ($traceEnabled) { [Console]::Error.WriteLine("[zap-sandbox-trace] bootstrap entered") }
$normalized = $Policy.Replace('-', '+').Replace('_', '/')
while (($normalized.Length % 4) -ne 0) { $normalized += '=' }
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($normalized))
$spec = $json | ConvertFrom-Json

if (-not ("ZapCode.AppContainerLauncher" -as [type])) {
$launcherAssembly = [string]$spec.launcherAssembly
if (Test-Path -LiteralPath $launcherAssembly -PathType Leaf) {
  if ($traceEnabled) { [Console]::Error.WriteLine("[zap-sandbox-trace] loading cached launcher") }
  try { Add-Type -Path $launcherAssembly }
  catch { Remove-Item -LiteralPath $launcherAssembly -Force -ErrorAction SilentlyContinue }
}
if (-not ("ZapCode.AppContainerLauncher" -as [type])) {
if ($traceEnabled) { [Console]::Error.WriteLine("[zap-sandbox-trace] compiling launcher") }
$temporaryAssembly = $launcherAssembly + "." + $PID + ".tmp.dll"
Remove-Item -LiteralPath $temporaryAssembly -Force -ErrorAction SilentlyContinue
Add-Type -Language CSharp -OutputAssembly $temporaryAssembly -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace ZapCode {
  public static class AppContainerLauncher {
    const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009;
    const uint SE_GROUP_ENABLED = 0x00000004;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES {
      public IntPtr Sid;
      public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_CAPABILITIES {
      public IntPtr AppContainerSid;
      public IntPtr Capabilities;
      public uint CapabilityCount;
      public uint Reserved;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
      public int cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public uint dwX;
      public uint dwY;
      public uint dwXSize;
      public uint dwYSize;
      public uint dwXCountChars;
      public uint dwYCountChars;
      public uint dwFillAttribute;
      public uint dwFlags;
      public short wShowWindow;
      public short cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX {
      public STARTUPINFO StartupInfo;
      public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public IntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int CreateAppContainerProfile(
      string pszAppContainerName,
      string pszDisplayName,
      string pszDescription,
      IntPtr pCapabilities,
      uint dwCapabilityCount,
      out IntPtr ppSidAppContainerSid);

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int DeleteAppContainerProfile(string pszAppContainerName);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSidToSid(string StringSid, out IntPtr Sid);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern IntPtr FreeSid(IntPtr pSid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(
      IntPtr lpAttributeList,
      int dwAttributeCount,
      int dwFlags,
      ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(
      IntPtr lpAttributeList,
      uint dwFlags,
      IntPtr Attribute,
      IntPtr lpValue,
      IntPtr cbSize,
      IntPtr lpPreviousValue,
      IntPtr lpReturnSize);

    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(
      string lpApplicationName,
      StringBuilder lpCommandLine,
      IntPtr lpProcessAttributes,
      IntPtr lpThreadAttributes,
      bool bInheritHandles,
      uint dwCreationFlags,
      IntPtr lpEnvironment,
      string lpCurrentDirectory,
      ref STARTUPINFOEX lpStartupInfo,
      out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(
      IntPtr hJob,
      int JobObjectInfoClass,
      IntPtr lpJobObjectInfo,
      uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int nStdHandle);

    sealed class AclLease : IDisposable {
      readonly string path;
      readonly bool directory;
      readonly string originalSddl;

      AclLease(string path, bool directory, string originalSddl) {
        this.path = path;
        this.directory = directory;
        this.originalSddl = originalSddl;
      }

      public static AclLease Grant(string path, SecurityIdentifier sid, bool writable) {
        bool isDirectory = Directory.Exists(path);
        if (!isDirectory && !File.Exists(path)) throw new FileNotFoundException("sandbox grant path does not exist", path);
        FileSystemSecurity security = isDirectory
          ? (FileSystemSecurity)Directory.GetAccessControl(path, AccessControlSections.Access)
          : File.GetAccessControl(path, AccessControlSections.Access);
        string original = security.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
        FileSystemRights rights = writable
          ? FileSystemRights.Modify | FileSystemRights.Synchronize
          : FileSystemRights.ReadAndExecute | FileSystemRights.ReadAttributes | FileSystemRights.ReadExtendedAttributes | FileSystemRights.ReadPermissions;
        InheritanceFlags inheritance = isDirectory
          ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit
          : InheritanceFlags.None;
        security.AddAccessRule(new FileSystemAccessRule(sid, rights, inheritance, PropagationFlags.None, AccessControlType.Allow));
        if (isDirectory) Directory.SetAccessControl(path, (DirectorySecurity)security);
        else File.SetAccessControl(path, (FileSecurity)security);
        return new AclLease(path, isDirectory, original);
      }

      public static AclLease ProtectReadOnly(string path, SecurityIdentifier sid) {
        bool isDirectory = Directory.Exists(path);
        if (!isDirectory && !File.Exists(path)) throw new FileNotFoundException("protected sandbox path does not exist", path);
        FileSystemSecurity security = isDirectory
          ? (FileSystemSecurity)Directory.GetAccessControl(path, AccessControlSections.Access)
          : File.GetAccessControl(path, AccessControlSections.Access);
        string original = security.GetSecurityDescriptorSddlForm(AccessControlSections.Access);
        // A broad writable workspace grant is inherited by nested control
        // directories. Freeze inheritance, remove every rule for this package
        // SID, then add back only the access needed to inspect the directory.
        // Restoring originalSddl in Dispose returns the inheritance flags and
        // DACL to their exact pre-run state.
        security.SetAccessRuleProtection(true, true);
        security.PurgeAccessRules(sid);
        FileSystemRights rights = FileSystemRights.ReadAndExecute |
          FileSystemRights.ReadAttributes | FileSystemRights.ReadExtendedAttributes |
          FileSystemRights.ReadPermissions | FileSystemRights.Synchronize;
        InheritanceFlags inheritance = isDirectory
          ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit
          : InheritanceFlags.None;
        security.AddAccessRule(new FileSystemAccessRule(sid, rights, inheritance, PropagationFlags.None, AccessControlType.Allow));
        if (isDirectory) Directory.SetAccessControl(path, (DirectorySecurity)security);
        else File.SetAccessControl(path, (FileSecurity)security);
        return new AclLease(path, isDirectory, original);
      }

      public void Dispose() {
        try {
          FileSystemSecurity security = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
          security.SetSecurityDescriptorSddlForm(originalSddl, AccessControlSections.Access);
          if (directory) Directory.SetAccessControl(path, (DirectorySecurity)security);
          else if (File.Exists(path)) File.SetAccessControl(path, (FileSecurity)security);
        } catch (Exception error) {
          Console.Error.WriteLine("[zap-sandbox] ACL restore failed for " + path + ": " + error.Message);
        }
      }
    }

    public static int Run(
      string executable,
      string[] args,
      string cwd,
      string[] readablePaths,
      string[] writablePaths,
      string[] protectedPaths,
      string tempDir,
      bool networkAllowed,
      bool trace) {
      string profileName = "ZapCode.Sandbox." + Guid.NewGuid().ToString("N");
      IntPtr packageSid = IntPtr.Zero;
      IntPtr capabilitySid = IntPtr.Zero;
      IntPtr capabilityArray = IntPtr.Zero;
      IntPtr securityCapabilitiesPtr = IntPtr.Zero;
      IntPtr attributeList = IntPtr.Zero;
      IntPtr job = IntPtr.Zero;
      PROCESS_INFORMATION process = new PROCESS_INFORMATION();
      var leases = new List<AclLease>();
      var createdProtected = new List<string>();
      Action<string> traceLog = message => {
        if (trace) Console.Error.WriteLine("[zap-sandbox-trace] " + message);
      };
      try {
        traceLog("launcher entered");
        uint capabilityCount = 0;
        if (networkAllowed) {
          if (!ConvertStringSidToSid("S-1-15-3-1", out capabilitySid)) ThrowLastWin32("internetClient SID");
          SID_AND_ATTRIBUTES capability = new SID_AND_ATTRIBUTES { Sid = capabilitySid, Attributes = SE_GROUP_ENABLED };
          capabilityArray = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)));
          Marshal.StructureToPtr(capability, capabilityArray, false);
          capabilityCount = 1;
        }

        int hr = CreateAppContainerProfile(profileName, profileName, "ZapCode isolated tool execution", capabilityArray, capabilityCount, out packageSid);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        var sid = new SecurityIdentifier(packageSid);
        traceLog("profile created");

        // Protect control-plane directories before adding an inheritable
        // workspace write grant. Otherwise Windows may propagate that grant to
        // existing files (for example .git/config) before the child directory
        // DACL is frozen.
        foreach (string path in protectedPaths ?? new string[0]) {
          if (!Directory.Exists(path) && !File.Exists(path)) {
            Directory.CreateDirectory(path);
            createdProtected.Add(path);
          }
          if (Directory.Exists(path) || File.Exists(path)) leases.Add(AclLease.ProtectReadOnly(path, sid));
        }
        traceLog("protected paths isolated");

        var writable = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string path in writablePaths ?? new string[0]) writable.Add(Path.GetFullPath(path));
        writable.Add(Path.GetFullPath(tempDir));
        var allPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string path in readablePaths ?? new string[0]) allPaths.Add(Path.GetFullPath(path));
        foreach (string path in writable) allPaths.Add(path);
        foreach (string path in allPaths) leases.Add(AclLease.Grant(path, sid, writable.Contains(path)));
        traceLog("grants applied");

        SECURITY_CAPABILITIES securityCapabilities = new SECURITY_CAPABILITIES {
          AppContainerSid = packageSid,
          Capabilities = capabilityArray,
          CapabilityCount = capabilityCount,
          Reserved = 0
        };
        securityCapabilitiesPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
        Marshal.StructureToPtr(securityCapabilities, securityCapabilitiesPtr, false);

        IntPtr attributeBytes = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
        attributeList = Marshal.AllocHGlobal(attributeBytes);
        if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes)) ThrowLastWin32("InitializeProcThreadAttributeList");
        if (!UpdateProcThreadAttribute(
          attributeList,
          0,
          new IntPtr(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES),
          securityCapabilitiesPtr,
          new IntPtr(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES))),
          IntPtr.Zero,
          IntPtr.Zero)) ThrowLastWin32("UpdateProcThreadAttribute");
        traceLog("security attributes prepared");

        STARTUPINFOEX startup = new STARTUPINFOEX();
        startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = GetStdHandle(-10);
        startup.StartupInfo.hStdOutput = GetStdHandle(-11);
        startup.StartupInfo.hStdError = GetStdHandle(-12);
        startup.lpAttributeList = attributeList;

        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) ThrowLastWin32("CreateJobObject");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobInfo = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        jobInfo.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        jobInfo.BasicLimitInformation.ActiveProcessLimit = 64;
        IntPtr jobInfoPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        try {
          Marshal.StructureToPtr(jobInfo, jobInfoPtr, false);
          if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, jobInfoPtr, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) ThrowLastWin32("SetInformationJobObject");
        } finally { Marshal.FreeHGlobal(jobInfoPtr); }

        var commandLine = new StringBuilder(Quote(executable));
        foreach (string arg in args ?? new string[0]) commandLine.Append(' ').Append(Quote(arg));
        uint flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
        if (!CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags, IntPtr.Zero, cwd, ref startup, out process)) ThrowLastWin32("CreateProcess AppContainer");
        traceLog("process created");
        if (!AssignProcessToJobObject(job, process.hProcess)) {
          TerminateProcess(process.hProcess, 1);
          ThrowLastWin32("AssignProcessToJobObject");
        }
        if (ResumeThread(process.hThread) == UInt32.MaxValue) {
          TerminateProcess(process.hProcess, 1);
          ThrowLastWin32("ResumeThread");
        }
        traceLog("process resumed");
        WaitForSingleObject(process.hProcess, UInt32.MaxValue);
        traceLog("process exited");
        uint exitCode;
        if (!GetExitCodeProcess(process.hProcess, out exitCode)) ThrowLastWin32("GetExitCodeProcess");
        return unchecked((int)exitCode);
      } finally {
        if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
        if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
        if (job != IntPtr.Zero) CloseHandle(job);
        if (attributeList != IntPtr.Zero) { DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); }
        if (securityCapabilitiesPtr != IntPtr.Zero) Marshal.FreeHGlobal(securityCapabilitiesPtr);
        for (int i = leases.Count - 1; i >= 0; i--) leases[i].Dispose();
        for (int i = createdProtected.Count - 1; i >= 0; i--) {
          try { if (Directory.Exists(createdProtected[i])) Directory.Delete(createdProtected[i], false); } catch {}
        }
        if (packageSid != IntPtr.Zero) FreeSid(packageSid);
        if (capabilitySid != IntPtr.Zero) LocalFree(capabilitySid);
        if (capabilityArray != IntPtr.Zero) Marshal.FreeHGlobal(capabilityArray);
        DeleteAppContainerProfile(profileName);
      }
    }

    static string Quote(string value) {
      if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
      var output = new StringBuilder("\"");
      int slashes = 0;
      foreach (char ch in value) {
        if (ch == '\\') { slashes++; continue; }
        if (ch == '"') { output.Append('\\', slashes * 2 + 1).Append(ch); slashes = 0; continue; }
        output.Append('\\', slashes).Append(ch); slashes = 0;
      }
      output.Append('\\', slashes * 2).Append('"');
      return output.ToString();
    }

    static void ThrowLastWin32(string operation) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }
  }
}
'@
try {
  Move-Item -LiteralPath $temporaryAssembly -Destination $launcherAssembly -ErrorAction Stop
} catch {
  Remove-Item -LiteralPath $temporaryAssembly -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $launcherAssembly -PathType Leaf)) { throw }
}
if (-not ("ZapCode.AppContainerLauncher" -as [type])) { Add-Type -Path $launcherAssembly }
if ($traceEnabled) { [Console]::Error.WriteLine("[zap-sandbox-trace] launcher compiled") }
}
}

try {
  $code = [ZapCode.AppContainerLauncher]::Run(
    $Executable,
    [string[]]$TargetArgs,
    [string]$spec.cwd,
    [string[]]$spec.readablePaths,
    [string[]]$spec.writablePaths,
    [string[]]$spec.protectedPaths,
    [string]$spec.tempDir,
    [bool]$spec.networkAllowed,
    [bool]$spec.trace)
  exit $code
} catch {
  [Console]::Error.WriteLine("[zap-sandbox] " + $_.Exception.Message)
  exit 126
}
`;
