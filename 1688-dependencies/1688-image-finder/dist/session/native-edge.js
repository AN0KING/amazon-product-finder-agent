import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { acquireLock } from './lock.js';
import { defaultProfileName, edgeCacheDir, lockFile, profilePath, profilesDir, } from './paths.js';
import { CliError } from '../io/errors.js';
const DEVTOOLS_ACTIVE_PORT = 'DevToolsActivePort';
const EDGE_START_TIMEOUT_MS = 60_000;
const EDGE_CDP_SETTLE_MS = 5_000;
const EDGE_CLOSE_TIMEOUT_MS = 30_000;
// The helper deadline includes PowerShell startup and C# compilation, before
// its unchanged six-second native window search begins.
const EDGE_WINDOW_PROOF_TIMEOUT_MS = 30_000;
const EDGE_WINDOW_PROOF_STARTUP_ALLOWANCE_MS = 24_000;
const EDGE_WINDOW_PROOF_MAX_OUTPUT_BYTES = 64 * 1024;
const WINDOWS_POWERSHELL_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PROFILE_RELEASE_TIMEOUT_MS = 5_000;
const PROFILE_RELEASE_STABLE_MS = 400;
const EDGE_CRASH_SETTLE_TIMEOUT_MS = 15_000;
const EDGE_CRASH_STABLE_MS = 1_500;
const EDGE_PROFILE_RENAME_TIMEOUT_MS = 15_000;
const EDGE_PROFILE_RECOVERY_COOLDOWN_MS = 60 * 60 * 1000;
const EDGE_PROFILE_MODE_MARKER = 'BB1688_EDGE_PROFILE_MODE.json';
const EDGE_PROFILE_MODE_MARKER_MAX_BYTES = 4_096;
const PROFILE_SINGLETONS = [
    'SingletonLock',
    'SingletonCookie',
    'SingletonSocket',
    'lockfile',
];
const directVisibleEdgePids = new WeakMap();
const OWNED_EDGE_WINDOW_PROOF_SCRIPT = String.raw `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$pidText = [Environment]::GetEnvironmentVariable('BB1688_EDGE_WINDOW_PIDS', 'Process')
if ([string]::IsNullOrWhiteSpace($pidText) -or $pidText -notmatch '^\d+(,\d+)*$') {
  Write-Output '{"ok":false}'
  exit 2
}
$initialPids = @($pidText.Split(',') | ForEach-Object { [uint32]::Parse($_) })
$launchToken = [Environment]::GetEnvironmentVariable('BB1688_EDGE_LAUNCH_TOKEN', 'Process')
$profilePath = [Environment]::GetEnvironmentVariable('BB1688_EDGE_PROFILE_PATH', 'Process')
$edgeExecutable = [Environment]::GetEnvironmentVariable('BB1688_EDGE_EXECUTABLE', 'Process')
$launchStartedText = [Environment]::GetEnvironmentVariable('BB1688_EDGE_LAUNCH_STARTED_MS', 'Process')
$windowTimeoutText = [Environment]::GetEnvironmentVariable('BB1688_EDGE_WINDOW_TIMEOUT_MS', 'Process')
$discoverRelaunch = -not [string]::IsNullOrWhiteSpace($launchToken)
if ($discoverRelaunch -and (
  $launchToken -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
  [string]::IsNullOrWhiteSpace($profilePath) -or
  [string]::IsNullOrWhiteSpace($edgeExecutable) -or
  $launchStartedText -notmatch '^\d{10,16}$' -or
  $windowTimeoutText -notmatch '^\d{3,6}$'
)) {
  Write-Output '{"ok":false,"reason":"invalid_discovery_contract"}'
  exit 2
}
$launchStartedMs = if ($discoverRelaunch) { [int64]::Parse($launchStartedText) } else { [int64]0 }
$windowTimeoutMs = if ($discoverRelaunch) { [int]::Parse($windowTimeoutText) } else { 6000 }
if ($windowTimeoutMs -lt 500 -or $windowTimeoutMs -gt 120000) {
  Write-Output '{"ok":false,"reason":"invalid_window_timeout"}'
  exit 2
}
$normalizedProfile = if ($discoverRelaunch) { [IO.Path]::GetFullPath($profilePath).TrimEnd('\') } else { '' }
$normalizedExecutable = if ($discoverRelaunch) { [IO.Path]::GetFullPath($edgeExecutable).TrimEnd('\') } else { '' }

function Get-OwnedEdgePids {
  $owned = New-Object 'System.Collections.Generic.HashSet[uint32]'
  foreach ($candidatePid in $initialPids) { [void]$owned.Add($candidatePid) }
  if (-not $discoverRelaunch) { return @($owned) }
  $tokenPattern = '(?i)(?:^|\s)--bb1688-launch-token=' + [regex]::Escape($launchToken) + '(?:\s|$)'
  $profilePattern = '(?i)(?:^|\s)--user-data-dir=(?:"([^"]+)"|(\S+))'
  foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe'")) {
    $commandLine = [string]$candidate.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine) -or $commandLine -match '(?i)(?:^|\s)--type=') { continue }
    if ($commandLine -notmatch $tokenPattern) { continue }
    $profileMatch = [regex]::Match($commandLine, $profilePattern)
    if (-not $profileMatch.Success) { continue }
    $candidateProfile = if ($profileMatch.Groups[1].Success) { $profileMatch.Groups[1].Value } else { $profileMatch.Groups[2].Value }
    try {
      if (-not [IO.Path]::GetFullPath($candidateProfile).TrimEnd('\').Equals($normalizedProfile, [StringComparison]::OrdinalIgnoreCase)) { continue }
      if (-not [IO.Path]::GetFullPath([string]$candidate.ExecutablePath).TrimEnd('\').Equals($normalizedExecutable, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $nativeProcess = Get-Process -Id ([int]$candidate.ProcessId) -ErrorAction Stop
      $startedMs = [DateTimeOffset]::new($nativeProcess.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
      if ($startedMs + 2000 -lt $launchStartedMs) { continue }
      [void]$owned.Add([uint32]$candidate.ProcessId)
    } catch {
      continue
    }
  }
  return @($owned)
}
$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace BB1688 {
  public sealed class EdgeWindowProof {
    public uint ProcessId;
    public long Handle;
    public bool Visible;
    public int Left;
    public int Top;
    public int Width;
    public int Height;
  }

  public static class NativeEdgeWindow {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect {
      public int Left;
      public int Top;
      public int Right;
      public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
      IntPtr hWnd,
      IntPtr insertAfter,
      int x,
      int y,
      int width,
      int height,
      uint flags
    );

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(
      IntPtr hWnd,
      int attribute,
      out int value,
      int valueSize
    );

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern IntPtr GetThreadDesktop(uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(
      uint flags,
      [MarshalAs(UnmanagedType.Bool)] bool inherit,
      uint desiredAccess
    );

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformation(
      IntPtr handle,
      int index,
      StringBuilder information,
      uint length,
      out uint needed
    );

    public static bool IsCurrentInputDesktop() {
      var current = GetThreadDesktop(GetCurrentThreadId());
      var input = OpenInputDesktop(0, false, 0x0001);
      if (current == IntPtr.Zero || input == IntPtr.Zero) return false;
      try {
        var currentName = GetDesktopName(current);
        var inputName = GetDesktopName(input);
        return !String.IsNullOrWhiteSpace(currentName)
          && String.Equals(currentName, inputName, StringComparison.OrdinalIgnoreCase);
      } finally {
        CloseDesktop(input);
      }
    }

    private static string GetDesktopName(IntPtr desktop) {
      uint needed;
      GetUserObjectInformation(desktop, 2, null, 0, out needed);
      if (needed < 2) return null;
      var name = new StringBuilder((int)(needed / 2));
      return GetUserObjectInformation(desktop, 2, name, needed, out needed)
        ? name.ToString()
        : null;
    }

    public static EdgeWindowProof FindAndShow(uint[] ownedPids) {
      var owned = new HashSet<uint>(ownedPids ?? Array.Empty<uint>());
      var handles = new List<IntPtr>();
      EnumWindows((hWnd, lParam) => {
        uint processId;
        GetWindowThreadProcessId(hWnd, out processId);
        if (!owned.Contains(processId)) return true;
        var className = new StringBuilder(128);
        GetClassName(hWnd, className, className.Capacity);
        if (className.ToString() == "Chrome_WidgetWin_1") handles.Add(hWnd);
        return true;
      }, IntPtr.Zero);

      foreach (var hWnd in handles) {
        ShowWindowAsync(hWnd, IsIconic(hWnd) ? 9 : 5);
        SetWindowPos(hWnd, IntPtr.Zero, 48, 48, 1280, 840, 0x0040);
        SetForegroundWindow(hWnd);
        Thread.Sleep(100);

        Rect rect;
        if (!IsWindowVisible(hWnd) || !GetWindowRect(hWnd, out rect)) continue;
        var width = rect.Right - rect.Left;
        var height = rect.Bottom - rect.Top;
        var cloakedValue = 0;
        var cloaked = DwmGetWindowAttribute(
          hWnd,
          14,
          out cloakedValue,
          Marshal.SizeOf(typeof(int))
        ) == 0 && cloakedValue != 0;
        if (cloaked || width < 320 || height < 240) continue;
        return new EdgeWindowProof {
          ProcessId = GetProcessId(hWnd),
          Handle = hWnd.ToInt64(),
          Visible = true,
          Left = rect.Left,
          Top = rect.Top,
          Width = width,
          Height = height
        };
      }
      return null;
    }

    private static uint GetProcessId(IntPtr hWnd) {
      uint processId;
      GetWindowThreadProcessId(hWnd, out processId);
      return processId;
    }
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
if (-not [BB1688.NativeEdgeWindow]::IsCurrentInputDesktop()) {
  Write-Output '{"ok":false,"reason":"wrong_desktop"}'
  exit 3
}
$deadline = [DateTime]::UtcNow.AddMilliseconds($windowTimeoutMs)
do {
$ownedPids = @(Get-OwnedEdgePids)
  $proof = [BB1688.NativeEdgeWindow]::FindAndShow([uint32[]]$ownedPids)
  if ($null -ne $proof) {
    [ordered]@{
      ok = $true
      pid = [uint32]$proof.ProcessId
      handle = $proof.Handle.ToString([System.Globalization.CultureInfo]::InvariantCulture)
      visible = [bool]$proof.Visible
      left = [int]$proof.Left
      top = [int]$proof.Top
      width = [int]$proof.Width
      height = [int]$proof.Height
    } | ConvertTo-Json -Compress
    exit 0
  }
  Start-Sleep -Milliseconds 150
} while ([DateTime]::UtcNow -lt $deadline)
Write-Output '{"ok":false}'
exit 4
`;
const OWNED_EDGE_WINDOW_PROOF_COMMAND = Buffer.from(OWNED_EDGE_WINDOW_PROOF_SCRIPT, 'utf16le').toString('base64');
/**
 * Runs a manual-only Edge phase without Playwright or a debugging endpoint,
 * then verifies the closed profile while retaining the same external lock.
 */
export async function withManualVisibleEdge(options, visibleOperation, closedProfileOperation) {
    if (process.platform !== 'win32') {
        throw new CliError(6, 'EDGE_NATIVE_WINDOWS_REQUIRED', 'The dedicated native Edge verification window is only available on Windows.');
    }
    const launchUrl = requireOfficialLoginUrl(options.launchUrl);
    const profileDir = profilePath(options.profile);
    const startupTimeoutMs = options.startupTimeoutMs ?? EDGE_START_TIMEOUT_MS;
    if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) {
        throw nativeEdgeError('EDGE_START_TIMEOUT_INVALID', 'The Microsoft Edge startup timeout must be a positive duration.');
    }
    await fsp.mkdir(profileDir, { recursive: true });
    const release = await acquireLock(options.profile);
    let manualEdge = null;
    let primaryError;
    try {
        await waitForProfileReleaseStability(profileDir, PROFILE_RELEASE_TIMEOUT_MS, PROFILE_RELEASE_STABLE_MS);
        manualEdge = await openManualVisibleEdge({
            profileDir,
            launchUrl,
            startupTimeoutMs,
        });
        const ownedEdge = manualEdge;
        await visibleOperation({
            pid: ownedEdge.pid,
            waitForClose: (timeoutMs) => waitForManualEdgeClose(ownedEdge, timeoutMs),
        });
        if (manualEdgeIsAlive(ownedEdge)) {
            throw nativeEdgeError('EDGE_MANUAL_WINDOW_STILL_OPEN', 'The manual Microsoft Edge window must be closed before verification continues.', 5);
        }
        await waitForProfileReleaseStability(profileDir, EDGE_CLOSE_TIMEOUT_MS, PROFILE_RELEASE_STABLE_MS);
        manualEdge = null;
        return await closedProfileOperation();
    }
    catch (error) {
        primaryError = error;
        throw error;
    }
    finally {
        let cleanupError;
        if (manualEdge) {
            cleanupError = await closeOwnedManualEdge(manualEdge).catch((error) => error);
        }
        await release().catch((error) => {
            cleanupError ??= error;
        });
        if (!primaryError && cleanupError)
            throw cleanupError;
    }
}
/**
 * Runs one visible native Edge phase and one closed-profile verification phase
 * under the same profile lock. The second phase must not reacquire the lock.
 */
export async function withNativeVisibleEdge(options, visibleOperation, closedProfileOperation) {
    if (process.platform !== 'win32') {
        throw new CliError(6, 'EDGE_NATIVE_WINDOWS_REQUIRED', 'The dedicated native Edge login window is only available on Windows.');
    }
    const launchUrl = requireOfficialLoginUrl(options.launchUrl);
    const profileDir = profilePath(options.profile);
    const cacheDir = edgeCacheDir('visible');
    await Promise.all([
        fsp.mkdir(profileDir, { recursive: true }),
        fsp.mkdir(cacheDir, { recursive: true }),
    ]);
    const release = await acquireLock(options.profile);
    let context = null;
    let primaryError;
    try {
        await waitForProfileReleaseStability(profileDir, PROFILE_RELEASE_TIMEOUT_MS, PROFILE_RELEASE_STABLE_MS);
        // A completed headless session releases the same Chromium profile cleanly.
        // Keep it in place so a later visible login retains the authenticated cookies.
        await removeStaleDevToolsMarker(profileDir);
        context = await openDirectVisibleEdge({
            profileDir,
            cacheDir,
            launchUrl,
            startupTimeoutMs: options.startupTimeoutMs ?? EDGE_START_TIMEOUT_MS,
        });
        const visibleResult = await visibleOperation(context);
        await closeDirectVisibleEdge(context);
        context = null;
        return await closedProfileOperation(visibleResult);
    }
    catch (error) {
        primaryError = error;
        throw error;
    }
    finally {
        let cleanupError;
        if (context) {
            cleanupError = await closeDirectVisibleEdge(context).catch((error) => error);
        }
        await release().catch((error) => {
            cleanupError ??= error;
        });
        if (!primaryError && cleanupError)
            throw cleanupError;
    }
}
async function openManualVisibleEdge(input) {
    const executable = resolveMicrosoftEdgeExecutable();
    const launchToken = crypto.randomUUID();
    const launchStartedAt = Date.now();
    let child = null;
    try {
        child = spawn(executable, buildManualVisibleEdgeArgs(input.profileDir, input.launchUrl, launchToken), {
            cwd: path.dirname(executable),
            detached: false,
            windowsHide: false,
            stdio: 'ignore',
            shell: false,
        });
        await waitForSpawn(child, Math.min(5_000, input.startupTimeoutMs));
        if (!child.pid || !validPid(child.pid)) {
            throw nativeEdgeError('EDGE_OWNERSHIP_UNPROVEN', 'Microsoft Edge did not expose the owned manual browser process.');
        }
        const proof = await proveOwnedVisibleEdgeWindow([child.pid], {
            launchToken,
            profileDir: input.profileDir,
            executable,
            launchStartedAt,
            startupTimeoutMs: input.startupTimeoutMs,
        });
        const ownedEdge = {
            child,
            pid: proof.pid,
            profileDir: input.profileDir,
        };
        return ownedEdge;
    }
    catch (error) {
        if (child?.pid && validPid(child.pid)) {
            const cleanupError = await closeOwnedManualEdge({
                child,
                pid: child.pid,
                profileDir: input.profileDir,
            }).catch((cause) => cause);
            if (cleanupError) {
                throw nativeEdgeError('EDGE_STARTUP_CLEANUP_FAILED', 'The failed manual Microsoft Edge process did not close cleanly.', 6, new AggregateError([error, cleanupError]));
            }
        }
        else if (child && !manualEdgeHasExited(child)) {
            child.kill();
        }
        throw error;
    }
}
async function openDirectVisibleEdge(input) {
    resolveMicrosoftEdgeExecutable();
    const launchToken = crypto.randomUUID();
    let context;
    try {
        context = await chromium.launchPersistentContext(input.profileDir, {
            headless: false,
            channel: 'msedge',
            viewport: { width: 1440, height: 900 },
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
            timeout: input.startupTimeoutMs,
            args: buildDirectVisibleEdgeArgs(input.cacheDir, launchToken, input.launchUrl),
        });
    }
    catch (cause) {
        throw classifyNativeEdgeLaunchFailure(cause);
    }
    try {
        const browserPids = await proveDirectVisibleEdge(context, input.profileDir, launchToken);
        directVisibleEdgePids.set(context, browserPids);
        await focusVisibleLoginPage(context, input.launchUrl);
        await proveOwnedVisibleEdgeWindow(browserPids);
        return context;
    }
    catch (error) {
        await closeDirectVisibleEdge(context).catch(() => undefined);
        throw error;
    }
}
async function proveDirectVisibleEdge(context, profileDir, launchToken) {
    const browser = context.browser();
    if (!browser?.isConnected()) {
        throw nativeEdgeError('EDGE_OWNERSHIP_UNPROVEN', 'The visible Microsoft Edge process is not connected.');
    }
    const session = await browser.newBrowserCDPSession();
    try {
        const command = await session.send('Browser.getBrowserCommandLine');
        const commandLine = Array.isArray(command.arguments)
            ? command.arguments.map(String)
            : [];
        const profileArg = findSwitch(commandLine, '--user-data-dir=');
        const tokenArg = findSwitch(commandLine, '--bb1688-launch-token=');
        const headless = commandLine.some((argument) => /^--headless(?:=|$)/i.test(argument));
        if (profileArg === null
            || normalizeWindowsPath(profileArg) !== normalizeWindowsPath(profileDir)
            || tokenArg !== launchToken
            || headless) {
            throw nativeEdgeError('EDGE_OWNERSHIP_UNPROVEN', 'The visible Microsoft Edge process did not match the dedicated login launch.');
        }
        const processes = await session.send('SystemInfo.getProcessInfo');
        return extractOwnedBrowserPids(processes.processInfo);
    }
    finally {
        await session.detach().catch(() => undefined);
    }
}
async function closeDirectVisibleEdge(context) {
    let timer;
    try {
        await Promise.race([
            context.close(),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(nativeEdgeError('EDGE_CLOSE_TIMEOUT', 'The dedicated Microsoft Edge window did not close in time.')), EDGE_CLOSE_TIMEOUT_MS);
                timer.unref();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function manualEdgeHasExited(child) {
    return child.exitCode !== null || child.signalCode !== null;
}
function manualEdgeIsAlive(session) {
    return session.child.pid === session.pid
        ? !manualEdgeHasExited(session.child)
        : processIsAlive(session.pid);
}
function waitForManualEdgeClose(session, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return Promise.reject(nativeEdgeError('EDGE_MANUAL_WAIT_INVALID', 'The manual Microsoft Edge close timeout must be a positive duration.'));
    }
    if (!manualEdgeIsAlive(session))
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        let poll;
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            clearInterval(poll);
            callback();
        };
        timer = setTimeout(() => finish(() => reject(nativeEdgeError('EDGE_MANUAL_WAIT_TIMEOUT', 'Timed out waiting for the manual Microsoft Edge window to close.', 4))), timeoutMs);
        poll = setInterval(() => {
            if (!manualEdgeIsAlive(session))
                finish(resolve);
        }, 100);
        poll.unref();
        if (!manualEdgeIsAlive(session))
            finish(resolve);
    });
}
async function closeOwnedManualEdge(session) {
    if (manualEdgeIsAlive(session)) {
        const exitWait = waitForManualEdgeClose(session, EDGE_CLOSE_TIMEOUT_MS);
        let killError;
        try {
            if (session.child.pid === session.pid)
                session.child.kill();
            else
                process.kill(session.pid);
        }
        catch (error) {
            if (error.code !== 'ESRCH')
                killError = error;
        }
        if (killError) {
            await exitWait.catch(() => undefined);
            throw nativeEdgeError('EDGE_MANUAL_CLEANUP_FAILED', 'The owned manual Microsoft Edge process could not be stopped.', 6, killError);
        }
        await exitWait.catch((cause) => {
            throw nativeEdgeError('EDGE_MANUAL_CLEANUP_FAILED', 'The owned manual Microsoft Edge process did not stop in time.', 6, cause);
        });
    }
    if (session.child.pid !== session.pid
        && !manualEdgeHasExited(session.child)) {
        session.child.kill();
    }
    await waitForProfileReleaseStability(session.profileDir, EDGE_CLOSE_TIMEOUT_MS, PROFILE_RELEASE_STABLE_MS);
}
export async function ensureNativeVisibleEdgeWindow(context) {
    const browserPids = directVisibleEdgePids.get(context);
    if (!browserPids) {
        throw nativeEdgeError('EDGE_OWNERSHIP_UNPROVEN', 'The visible Microsoft Edge process is not owned by this login session.');
    }
    await proveOwnedVisibleEdgeWindow(browserPids);
}
async function openOwnedNativeEdgeWithRecovery(input) {
    try {
        return await openOwnedNativeEdge(input);
    }
    catch (firstError) {
        if (!errorHasCode(firstError, 'EDGE_PROFILE_STARTUP_CRASH'))
            throw firstError;
        if (normalizeWindowsPath(input.profileDir) !== normalizeWindowsPath(profilePath('default'))
            || normalizeWindowsPath(input.profileLockPath) !== normalizeWindowsPath(lockFile('default'))) {
            throw firstError;
        }
        const backupPath = await quarantineDefaultEdgeProfile();
        try {
            return await openOwnedNativeEdge(input);
        }
        catch (retryError) {
            throw nativeEdgeError('EDGE_PROFILE_RECOVERY_FAILED', 'Microsoft Edge still failed after the damaged login profile was backed up.', 6, new AggregateError([firstError, retryError])).withDetails({
                artifactDir: backupPath,
                category: 'edge_profile_recovery_failed',
                recoverHint: 'Keep the backup and retry after updating or repairing Microsoft Edge.',
                retryable: false,
            });
        }
    }
}
async function openOwnedNativeEdge(input) {
    const executable = resolveMicrosoftEdgeExecutable();
    const launchToken = crypto.randomUUID();
    const [existingCrashReports, hadExistingBrowserState] = await Promise.all([
        listEdgeCrashReports(input.profileDir),
        profileHasBrowserState(input.profileDir),
    ]);
    const args = buildNativeEdgeArgs(input.profileDir, {
        cacheDir: input.cacheDir,
        launchToken,
        launchUrl: input.launchUrl,
    });
    let child;
    try {
        child = spawn(executable, args, {
            cwd: path.dirname(executable),
            detached: false,
            windowsHide: false,
            stdio: 'ignore',
            shell: false,
        });
    }
    catch (cause) {
        throw nativeEdgeError('EDGE_LAUNCH_FAILED', 'The dedicated Microsoft Edge window could not be started.', 6, cause);
    }
    await waitForSpawn(child, 5_000);
    let browser = null;
    try {
        const endpoint = await waitForDevToolsEndpoint(input.profileDir, child, input.startupTimeoutMs);
        browser = await chromium.connectOverCDP(endpoint, {
            timeout: Math.max(1, Math.min(10_000, input.startupTimeoutMs)),
        });
        await waitForConnectedBrowserStability(browser, child, Math.min(EDGE_CDP_SETTLE_MS, input.startupTimeoutMs));
        const ownership = await proveBrowserOwnership(browser, executable, input.profileDir, launchToken);
        const context = browser.contexts()[0];
        if (!context) {
            throw nativeEdgeError('EDGE_CDP_UNAVAILABLE', 'Microsoft Edge did not expose its dedicated browser context.');
        }
        await focusVisibleLoginPage(context, input.launchUrl);
        return {
            browser,
            context,
            child,
            browserPids: ownership.browserPids,
            profileDir: input.profileDir,
            owned: true,
        };
    }
    catch (error) {
        const browserTerminatedBeforeCleanup = child.exitCode !== null
            || child.signalCode !== null
            || (browser !== null && !browser.isConnected());
        let crashReport = null;
        let crashEvidenceError;
        if (browserTerminatedBeforeCleanup) {
            try {
                crashReport = await waitForStableNewEdgeCrashReports(input.profileDir, existingCrashReports, EDGE_CRASH_SETTLE_TIMEOUT_MS, EDGE_CRASH_STABLE_MS);
            }
            catch (evidenceError) {
                crashEvidenceError = evidenceError;
            }
        }
        // Browser.close is intentionally forbidden until command-line ownership
        // has been proven. Only the exact process we spawned may be touched here.
        if (child.exitCode === null && child.signalCode === null)
            child.kill();
        if (child.pid && validPid(child.pid)) {
            try {
                await waitForProcessExit(child.pid, PROFILE_RELEASE_TIMEOUT_MS);
            }
            catch (cleanupError) {
                throw nativeEdgeError('EDGE_STARTUP_CLEANUP_FAILED', 'The failed Microsoft Edge process did not exit, so its profile was not moved.', 6, new AggregateError([error, cleanupError]));
            }
        }
        if (browser?.isConnected() === false)
            browser = null;
        if (crashEvidenceError) {
            throw nativeEdgeError('EDGE_CRASH_EVIDENCE_FAILED', 'The failed Edge process was closed, but its crash evidence was unsafe or unreadable.', 6, new AggregateError([error, crashEvidenceError]));
        }
        if (crashReport && hadExistingBrowserState) {
            throw nativeEdgeError('EDGE_PROFILE_STARTUP_CRASH', 'Microsoft Edge crashed while opening the dedicated 1688 login profile.', 6, error).withDetails({
                artifactDir: path.dirname(crashReport),
                category: 'edge_profile_startup_crash',
                retryable: true,
            });
        }
        if (crashReport) {
            throw nativeEdgeError('EDGE_FRESH_PROFILE_STARTUP_CRASH', 'Microsoft Edge crashed while creating a new dedicated login profile.', 6, error).withDetails({
                artifactDir: path.dirname(crashReport),
                category: 'edge_fresh_profile_startup_crash',
                retryable: false,
            });
        }
        throw error;
    }
}
async function waitForConnectedBrowserStability(browser, child, stableMs) {
    if (!Number.isFinite(stableMs) || stableMs < 0) {
        throw nativeEdgeError('EDGE_CDP_STABILITY_INVALID', 'The Microsoft Edge startup stability duration is invalid.');
    }
    const deadline = Date.now() + stableMs;
    do {
        if (!browser.isConnected()
            || child.exitCode !== null
            || child.signalCode !== null) {
            throw nativeEdgeError('EDGE_CDP_UNAVAILABLE', 'Microsoft Edge closed before its local debugging endpoint became stable.');
        }
        if (Date.now() >= deadline)
            return;
        await delay(100);
    } while (true);
}
async function profileHasBrowserState(profileDir) {
    const [localState, defaultDir] = await Promise.all([
        fsp.lstat(path.join(profileDir, 'Local State')).catch(() => null),
        fsp.lstat(path.join(profileDir, 'Default')).catch(() => null),
    ]);
    if (localState?.isFile() && !localState.isSymbolicLink() && localState.size > 0) {
        return true;
    }
    if (!defaultDir?.isDirectory() || defaultDir.isSymbolicLink())
        return false;
    return (await fsp.readdir(path.join(profileDir, 'Default'))).length > 0;
}
async function listEdgeCrashReports(profileDir) {
    const reportsDir = path.join(profileDir, 'Crashpad', 'reports');
    const crashpadDir = path.dirname(reportsDir);
    const crashpadStat = await fsp.lstat(crashpadDir).catch((error) => {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    });
    if (!crashpadStat)
        return new Set();
    const reportsStat = await fsp.lstat(reportsDir).catch((error) => {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    });
    if (!reportsStat)
        return new Set();
    if (!crashpadStat.isDirectory()
        || crashpadStat.isSymbolicLink()
        || !reportsStat.isDirectory()
        || reportsStat.isSymbolicLink()) {
        throw nativeEdgeError('EDGE_CRASH_EVIDENCE_UNSAFE', 'The Edge crash-report directory is not a direct local directory.', 6);
    }
    const entries = await fsp.readdir(reportsDir, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    });
    return new Set(entries
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .filter((name) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.dmp$/i.test(name)));
}
export async function waitForNewEdgeCrashReport(profileDir, existing, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw nativeEdgeError('EDGE_CRASH_WAIT_INVALID', 'The Edge crash-report wait duration is invalid.', 6);
    }
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
        const current = await listEdgeCrashReports(profileDir);
        const created = [...current].find((name) => !existing.has(name));
        if (created)
            return path.join(profileDir, 'Crashpad', 'reports', created);
        if (Date.now() >= deadline)
            return null;
        await delay(100);
    } while (true);
}
async function waitForStableNewEdgeCrashReports(profileDir, existing, timeoutMs, stableMs) {
    if (!Number.isFinite(timeoutMs)
        || !Number.isFinite(stableMs)
        || timeoutMs <= 0
        || stableMs <= 0
        || stableMs >= timeoutMs) {
        throw nativeEdgeError('EDGE_CRASH_WAIT_INVALID', 'The Edge crash-report stability window is invalid.', 6);
    }
    const reportsDir = path.join(profileDir, 'Crashpad', 'reports');
    const deadline = Date.now() + timeoutMs;
    let previousSignature = '';
    let stableSince = 0;
    let sawNewReport = false;
    while (Date.now() < deadline) {
        const names = [...await listEdgeCrashReports(profileDir)]
            .filter((name) => !existing.has(name))
            .sort();
        if (names.length > 0) {
            sawNewReport = true;
            const stats = await Promise.all(names.map(async (name) => {
                const target = path.join(reportsDir, name);
                const stat = await fsp.lstat(target);
                if (!stat.isFile() || stat.isSymbolicLink()) {
                    throw nativeEdgeError('EDGE_CRASH_EVIDENCE_UNSAFE', 'An Edge crash report is not a direct local file.', 6);
                }
                return `${name}:${stat.size}:${stat.mtimeMs}`;
            }));
            const signature = stats.join('|');
            if (signature === previousSignature) {
                if (Date.now() - stableSince >= stableMs) {
                    return path.join(reportsDir, names[0]);
                }
            }
            else {
                previousSignature = signature;
                stableSince = Date.now();
            }
        }
        await delay(100);
    }
    if (sawNewReport) {
        throw nativeEdgeError('EDGE_CRASH_REPORT_UNSTABLE', 'The Edge crash reports did not finish writing before recovery timed out.', 6);
    }
    return null;
}
export async function quarantineDefaultEdgeProfile(now = Date.now()) {
    if (!Number.isFinite(now) || now <= 0) {
        throw nativeEdgeError('EDGE_PROFILE_RECOVERY_INVALID', 'The Edge profile recovery timestamp is invalid.', 6);
    }
    const resolved = assertExactDefaultProfile(profilePath('default'), lockFile('default'));
    const parent = path.dirname(resolved);
    await waitForProfileReleaseStability(resolved, EDGE_PROFILE_RENAME_TIMEOUT_MS, PROFILE_RELEASE_STABLE_MS);
    const backupPrefix = `${path.basename(resolved)}.edge-crash-`;
    const siblings = await fsp.readdir(parent, { withFileTypes: true });
    for (const sibling of siblings) {
        if (!sibling.name.startsWith(backupPrefix))
            continue;
        const siblingStat = await fsp.lstat(path.join(parent, sibling.name));
        if (now - siblingStat.mtimeMs < EDGE_PROFILE_RECOVERY_COOLDOWN_MS) {
            throw nativeEdgeError('EDGE_PROFILE_RECOVERY_COOLDOWN', 'The Edge login profile was already recovered recently and will not be moved again.', 6);
        }
    }
    const stamp = new Date(now).toISOString().replace(/\D/g, '').slice(0, 14);
    const backupPath = path.join(parent, `${backupPrefix}${stamp}-${crypto.randomBytes(4).toString('hex')}`);
    await renameWithRetry(resolved, backupPath, EDGE_PROFILE_RENAME_TIMEOUT_MS);
    try {
        await fsp.mkdir(resolved);
        await fsp.writeFile(path.join(backupPath, 'EDGE_PROFILE_RECOVERY.json'), `${JSON.stringify({
            recoveredAt: new Date(now).toISOString(),
            backupPath,
            reason: 'edge_profile_startup_crash',
        }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    catch (cause) {
        let rollbackError;
        try {
            await fsp.rmdir(resolved);
            await fsp.rename(backupPath, resolved);
        }
        catch (error) {
            rollbackError = error;
        }
        const recoveryError = nativeEdgeError('EDGE_PROFILE_RECOVERY_FAILED', 'A new Edge login profile could not be created after backup.', 6, rollbackError ? new AggregateError([cause, rollbackError]) : cause);
        recoveryError.withDetails({
            artifactDir: rollbackError ? backupPath : resolved,
            category: 'edge_profile_recovery_failed',
            recoverHint: rollbackError
                ? 'Keep the backup directory; automatic rollback could not complete.'
                : 'The original profile was restored; retry after checking disk permissions.',
            retryable: false,
        });
        throw recoveryError;
    }
    return backupPath;
}
/**
 * Records that the default persistent profile was successfully opened by
 * Playwright in headless mode. The marker is intentionally write-once: a
 * visible native launch consumes it by moving the entire profile to backup.
 */
export async function markDefaultEdgeProfileHeadless(profile, now = Date.now()) {
    if (defaultProfileName(profile) !== 'default')
        return;
    if (!Number.isFinite(now) || now <= 0) {
        throw nativeEdgeError('EDGE_PROFILE_MODE_MARKER_INVALID', 'The Edge profile mode timestamp is invalid.', 6);
    }
    const resolved = assertExactDefaultProfile(profilePath('default'), lockFile('default'));
    const markerPath = path.join(resolved, EDGE_PROFILE_MODE_MARKER);
    const existing = await readHeadlessModeMarker(markerPath);
    if (existing === true)
        return;
    if (existing === false) {
        throw nativeEdgeError('EDGE_PROFILE_MODE_MARKER_INVALID', 'The existing Edge profile mode marker is invalid.', 6);
    }
    const marker = {
        version: 1,
        profile: 'default',
        mode: 'headless',
        recordedAt: new Date(now).toISOString(),
    };
    try {
        await fsp.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    catch (cause) {
        if (cause.code === 'EEXIST') {
            if (await readHeadlessModeMarker(markerPath) === true)
                return;
        }
        throw nativeEdgeError('EDGE_PROFILE_MODE_MARKER_FAILED', 'The Edge profile mode marker could not be created safely.', 6, cause);
    }
}
/**
 * A native Edge login must not reuse a default profile last initialized by
 * headless Playwright. Move that exact profile to a recoverable backup once,
 * then create a fresh default profile without deleting any prior data.
 */
export async function rotateDefaultEdgeProfileAfterHeadless(candidateProfileDir, candidateLockPath, now = Date.now()) {
    const expectedProfile = path.resolve(profilePath('default'));
    const expectedLock = path.resolve(lockFile('default'));
    if (normalizeWindowsPath(candidateProfileDir) !== normalizeWindowsPath(expectedProfile)) {
        return null;
    }
    if (normalizeWindowsPath(candidateLockPath) !== normalizeWindowsPath(expectedLock)) {
        throw nativeEdgeError('EDGE_PROFILE_RECOVERY_UNSAFE', 'The default Edge profile requires its external runtime lock.', 6);
    }
    if (!Number.isFinite(now) || now <= 0) {
        throw nativeEdgeError('EDGE_PROFILE_MODE_ROTATION_INVALID', 'The Edge profile rotation timestamp is invalid.', 6);
    }
    const resolved = assertExactDefaultProfile(candidateProfileDir, candidateLockPath);
    const markerPath = path.join(resolved, EDGE_PROFILE_MODE_MARKER);
    const markedHeadless = await readHeadlessModeMarker(markerPath);
    if (markedHeadless === null)
        return null;
    if (!markedHeadless) {
        throw nativeEdgeError('EDGE_PROFILE_MODE_MARKER_INVALID', 'The Edge profile mode marker is invalid, so the profile was not moved.', 6);
    }
    await waitForProfileReleaseStability(resolved, EDGE_PROFILE_RENAME_TIMEOUT_MS, PROFILE_RELEASE_STABLE_MS);
    const parent = path.dirname(resolved);
    const stamp = new Date(now).toISOString().replace(/\D/g, '').slice(0, 14);
    const recoveryId = crypto.randomBytes(4).toString('hex');
    const backupPath = path.join(parent, `${path.basename(resolved)}.edge-headless-${stamp}-${recoveryId}`);
    await renameWithRetry(resolved, backupPath, EDGE_PROFILE_RENAME_TIMEOUT_MS);
    try {
        const preferredRecoveryRecord = path.join(backupPath, 'EDGE_PROFILE_RECOVERY.json');
        const recoveryRecord = await fsp.lstat(preferredRecoveryRecord).then(() => path.join(backupPath, `EDGE_PROFILE_RECOVERY.${stamp}-${recoveryId}.json`), (error) => {
            if (error.code === 'ENOENT')
                return preferredRecoveryRecord;
            throw error;
        });
        await fsp.writeFile(recoveryRecord, `${JSON.stringify({
            recoveredAt: new Date(now).toISOString(),
            backupPath,
            reason: 'headless_to_native_mode_transition',
        }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
        await fsp.mkdir(resolved);
    }
    catch (cause) {
        const rollback = await restoreDefaultProfileAfterFailedRotation(resolved, backupPath, stamp, recoveryId);
        const rotationError = nativeEdgeError('EDGE_PROFILE_MODE_ROTATION_FAILED', 'A fresh Edge login profile could not be created after backup.', 6, rollback.error ? new AggregateError([cause, rollback.error]) : cause);
        rotationError.withDetails({
            artifactDir: rollback.error ? backupPath : resolved,
            category: 'edge_profile_mode_rotation_failed',
            conflictBackup: rollback.conflictPath,
            recoverHint: rollback.error
                ? 'Keep the backup directory; automatic rollback could not complete.'
                : rollback.conflictPath
                    ? 'The original profile was restored and the unexpected new directory was preserved separately.'
                    : 'The original profile was restored; retry after checking disk permissions.',
            retryable: false,
        });
        throw rotationError;
    }
    return backupPath;
}
async function restoreDefaultProfileAfterFailedRotation(resolvedProfile, backupPath, stamp, recoveryId) {
    let conflictPath;
    try {
        const backupStat = await fsp.lstat(backupPath);
        const backupReal = await fsp.realpath(backupPath);
        if (!backupStat.isDirectory()
            || backupStat.isSymbolicLink()
            || normalizeWindowsPath(backupReal) !== normalizeWindowsPath(backupPath)) {
            throw nativeEdgeError('EDGE_PROFILE_RECOVERY_UNSAFE', 'The preserved Edge profile backup is no longer a direct local directory.', 6);
        }
        const currentStat = await fsp.lstat(resolvedProfile).catch((error) => {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        });
        if (currentStat) {
            const currentReal = await fsp.realpath(resolvedProfile);
            if (!currentStat.isDirectory()
                || currentStat.isSymbolicLink()
                || normalizeWindowsPath(currentReal) !== normalizeWindowsPath(resolvedProfile)) {
                throw nativeEdgeError('EDGE_PROFILE_RECOVERY_UNSAFE', 'An unexpected default profile path prevented a safe rollback.', 6);
            }
            conflictPath = path.join(path.dirname(resolvedProfile), `${path.basename(resolvedProfile)}.edge-rotation-conflict-${stamp}-${recoveryId}`);
            await renameWithRetry(resolvedProfile, conflictPath, EDGE_PROFILE_RENAME_TIMEOUT_MS);
        }
        await renameWithRetry(backupPath, resolvedProfile, EDGE_PROFILE_RENAME_TIMEOUT_MS);
        return { conflictPath };
    }
    catch (error) {
        return { conflictPath, error };
    }
}
function assertExactDefaultProfile(candidateProfileDir, candidateLockPath) {
    const resolved = path.resolve(candidateProfileDir);
    const resolvedLock = path.resolve(candidateLockPath);
    const expectedProfile = path.resolve(profilePath('default'));
    const expectedLock = path.resolve(lockFile('default'));
    const expectedParent = path.resolve(profilesDir());
    const parent = path.dirname(resolved);
    if (normalizeWindowsPath(resolved) !== normalizeWindowsPath(expectedProfile)
        || normalizeWindowsPath(resolvedLock) !== normalizeWindowsPath(expectedLock)
        || normalizeWindowsPath(parent) !== normalizeWindowsPath(expectedParent)
        || pathIsWithin(resolved, resolvedLock)) {
        throw nativeEdgeError('EDGE_PROFILE_RECOVERY_UNSAFE', 'Only the dedicated default Edge profile with an external lock can be changed.', 6);
    }
    let profileStat;
    let parentStat;
    try {
        profileStat = fs.lstatSync(resolved);
        parentStat = fs.lstatSync(parent);
    }
    catch (cause) {
        throw nativeEdgeError('EDGE_PROFILE_RECOVERY_INVALID', 'The Edge profile is not a safe direct local directory.', 6, cause);
    }
    if (!profileStat.isDirectory()
        || profileStat.isSymbolicLink()
        || !parentStat.isDirectory()
        || parentStat.isSymbolicLink()) {
        throw nativeEdgeError('EDGE_PROFILE_RECOVERY_INVALID', 'The Edge profile is not a safe direct local directory.', 6);
    }
    return resolved;
}
async function readHeadlessModeMarker(markerPath) {
    const stat = await fsp.lstat(markerPath).catch((error) => {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    });
    if (!stat)
        return null;
    if (!stat.isFile()
        || stat.isSymbolicLink()
        || stat.size < 1
        || stat.size > EDGE_PROFILE_MODE_MARKER_MAX_BYTES) {
        return false;
    }
    const real = await fsp.realpath(markerPath);
    if (normalizeWindowsPath(real) !== normalizeWindowsPath(markerPath))
        return false;
    try {
        const parsed = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
        return parsed.version === 1
            && parsed.profile === 'default'
            && parsed.mode === 'headless'
            && typeof parsed.recordedAt === 'string'
            && Number.isFinite(Date.parse(parsed.recordedAt));
    }
    catch {
        return false;
    }
}
async function renameWithRetry(source, destination, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        try {
            await fsp.rename(source, destination);
            return;
        }
        catch (error) {
            const code = error.code;
            if (!['EBUSY', 'EACCES', 'EPERM'].includes(code ?? '') || Date.now() >= deadline) {
                throw error;
            }
            await delay(100);
        }
    }
}
function pathIsWithin(parent, candidate) {
    const relative = path.win32.relative(normalizeWindowsPath(parent), normalizeWindowsPath(candidate));
    return relative === ''
        || (!relative.startsWith(`..${path.win32.sep}`)
            && relative !== '..'
            && !path.win32.isAbsolute(relative));
}
export function buildManualVisibleEdgeArgs(profileDir, launchUrl, launchToken) {
    if (!profileDir.trim() || /[\r\n\0]/.test(profileDir)) {
        throw nativeEdgeError('EDGE_PROFILE_INVALID', 'The Edge profile path is invalid.');
    }
    const resolvedProfile = path.resolve(profileDir);
    const officialUrl = requireOfficialLoginUrl(launchUrl);
    if (launchToken !== undefined && !/^[0-9a-f-]{36}$/i.test(launchToken)) {
        throw nativeEdgeError('EDGE_LAUNCH_TOKEN_INVALID', 'The Edge launch token is invalid.');
    }
    return [
        `--user-data-dir=${resolvedProfile}`,
        '--profile-directory=Default',
        ...(launchToken ? [`--bb1688-launch-token=${launchToken}`] : []),
        '--new-window',
        '--window-position=48,48',
        '--window-size=1280,840',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-mode',
        '--disable-features=AutoDeElevate,msEdgeStartupBoost',
        '--edge-skip-compat-layer-relaunch',
        officialUrl,
    ];
}
export function buildDirectVisibleEdgeArgs(cacheDir, launchToken, launchUrl) {
    if (!cacheDir.trim() || /[\r\n\0]/.test(cacheDir)) {
        throw nativeEdgeError('EDGE_PROFILE_INVALID', 'The Edge cache path is invalid.');
    }
    if (!/^[0-9a-f-]{36}$/i.test(launchToken)) {
        throw nativeEdgeError('EDGE_LAUNCH_TOKEN_INVALID', 'The Edge launch token is invalid.');
    }
    requireOfficialLoginUrl(launchUrl);
    return [
        `--disk-cache-dir=${path.resolve(cacheDir)}`,
        `--bb1688-launch-token=${launchToken}`,
        // Browser.getBrowserCommandLine (ownership proof) requires --enable-automation
        // to be present in the browser's own command line.
        '--enable-automation',
        // 1688/阿里 NoCaptcha 滑块会检测 navigator.webdriver（--enable-automation
        // 会将其置 true），导致拖动轨迹被判为机器人而永远“验证失败”。
        // AutomationControlled 特征禁用后 webdriver 恢复 false，所有权断言不受影响。
        '--disable-blink-features=AutomationControlled',
        '--new-window',
        '--window-position=48,48',
        '--window-size=1280,840',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-mode',
        '--disable-breakpad',
        '--disable-crash-reporter',
        '--disable-features=msEdgeStartupBoost',
        // Persistent-context launch waits for the first page's full load.
        // Let Playwright create its local about:blank page; only after launch
        // does focusVisibleLoginPage navigate to 1688 with waitUntil: 'commit'.
        // An already visible login page must not turn a slow remote load into
        // a misleading browser-start failure.
    ];
}

export function classifyNativeEdgeLaunchFailure(cause) {
    const message = String(cause?.message || '');
    let code = 'EDGE_LAUNCH_FAILED';
    let summary = 'Microsoft Edge could not initialize the dedicated login session.';
    let category = 'edge_launch_failed';
    let exitCode = 6;
    if (/ProcessSingleton|SingletonLock|user data directory is already in use|profile.{0,60}(?:in use|used by another)/i.test(message)) {
        code = 'EDGE_PROFILE_BUSY';
        summary = 'The dedicated 1688 Edge profile is already in use. Close only its earlier window before opening another login session.';
        category = 'edge_profile_busy';
        exitCode = 5;
    }
    else if (cause?.name === 'TimeoutError' || /\bTimeout\s+\d+\s*ms\s+exceeded\b/i.test(message)) {
        code = 'EDGE_STARTUP_TIMEOUT';
        summary = 'Microsoft Edge did not finish initializing its login control connection in time; a visible window does not confirm that connection is ready.';
        category = 'edge_startup_timeout';
    }
    else if (/Executable doesn't exist|distribution ['"]?msedge['"]? is not found|msedge.{0,40}not found/i.test(message)) {
        code = 'EDGE_MISSING';
        summary = 'Microsoft Edge could not be found for the dedicated 1688 login.';
        category = 'edge_executable_missing';
    }
    // Playwright errors may include full command lines and page URLs. Keep the
    // original cause in memory, but expose only a fixed diagnosis in CLI JSON.
    return nativeEdgeError(code, summary, exitCode, cause).withDetails({
        category,
        stage: 'browser_launch',
        retryable: code !== 'EDGE_MISSING',
    });
}
export function buildNativeEdgeArgs(profileDir, input) {
    const resolvedProfile = path.resolve(profileDir);
    const resolvedCache = path.resolve(input.cacheDir);
    if (!path.isAbsolute(resolvedProfile) || !path.isAbsolute(resolvedCache)) {
        throw nativeEdgeError('EDGE_PROFILE_INVALID', 'The Edge profile path is invalid.');
    }
    if (!/^[0-9a-f-]{36}$/i.test(input.launchToken)) {
        throw nativeEdgeError('EDGE_LAUNCH_TOKEN_INVALID', 'The Edge launch token is invalid.');
    }
    const launchUrl = requireOfficialLoginUrl(input.launchUrl);
    return [
        `--user-data-dir=${resolvedProfile}`,
        '--profile-directory=Default',
        `--disk-cache-dir=${resolvedCache}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--enable-automation',
        // 隐藏 navigator.webdriver，避免阿里滑块把窗口判为自动化环境（见上）。
        '--disable-blink-features=AutomationControlled',
        `--bb1688-launch-token=${input.launchToken}`,
        '--new-window',
        '--window-position=48,48',
        '--window-size=1280,840',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-mode',
        '--disable-breakpad',
        '--disable-crash-reporter',
        '--disable-features=msEdgeStartupBoost',
        launchUrl,
    ];
}
export function extractOwnedBrowserPids(processInfo) {
    const browserPids = [...new Set((Array.isArray(processInfo) ? processInfo : [])
            .filter((item) => (typeof item === 'object' && item !== null))
            .filter((item) => item.type === 'browser')
            .map((item) => Number(item.id))
            .filter(validPid))];
    if (browserPids.length === 0) {
        throw nativeEdgeError('EDGE_OWNERSHIP_UNPROVEN', 'Microsoft Edge did not expose its owned browser process.');
    }
    return browserPids;
}
export function parseOwnedEdgeWindowProof(text, ownedBrowserPids, allowDiscoveredPid = false) {
    const owned = new Set(ownedBrowserPids.filter(validPid));
    const lines = text
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        let value;
        try {
            value = JSON.parse(lines[index] ?? '');
        }
        catch {
            continue;
        }
        if (typeof value !== 'object' || value === null)
            continue;
        const record = value;
        if (record.ok !== true || record.visible !== true)
            return null;
        const pid = Number(record.pid);
        const handle = typeof record.handle === 'string' ? record.handle : '';
        const left = Number(record.left);
        const top = Number(record.top);
        const width = Number(record.width);
        const height = Number(record.height);
        if ((!allowDiscoveredPid && !owned.has(pid))
            || !validPid(pid)
            || !/^\d+$/.test(handle)
            || handle === '0'
            || ![left, top, width, height].every(Number.isInteger)
            || width < 320
            || height < 240) {
            return null;
        }
        return { pid, handle, left, top, width, height };
    }
    return null;
}
export function parseDevToolsActivePort(text) {
    const lines = text.replace(/\r/g, '').split('\n').filter(Boolean);
    if (lines.length !== 2 || !/^\d{1,5}$/.test(lines[0] ?? '')) {
        throw nativeEdgeError('EDGE_CDP_UNAVAILABLE', 'Microsoft Edge returned an invalid local debugging endpoint.');
    }
    const port = Number(lines[0]);
    const target = lines[1] ?? '';
    if (!Number.isInteger(port)
        || port < 1
        || port > 65_535
        || !/^\/devtools\/browser\/[0-9a-f-]{16,128}$/i.test(target)) {
        throw nativeEdgeError('EDGE_CDP_UNAVAILABLE', 'Microsoft Edge returned an invalid local debugging endpoint.');
    }
    return `ws://127.0.0.1:${port}${target}`;
}
export function assertOwnedBrowserCommandLine(commandLine, executable, profileDir, launchToken) {
    const normalized = commandLine.map(String);
    const executableArg = normalized[0] ?? '';
    const profileArg = findSwitch(normalized, '--user-data-dir=');
    const tokenArg = findSwitch(normalized, '--bb1688-launch-token=');
    const executableMatches = normalizeWindowsPath(executableArg)
        === normalizeWindowsPath(executable);
    const profileMatches = profileArg !== null
        && normalizeWindowsPath(profileArg) === normalizeWindowsPath(profileDir);
    if (!executableMatches
        || !profileMatches
        || tokenArg !== launchToken
        || !normalized.includes('--remote-debugging-port=0')
        || !normalized.includes('--enable-automation')) {
        throw nativeEdgeError('EDGE_OWNERSHIP_UNPROVEN', 'The Microsoft Edge debugging endpoint did not belong to this login window.');
    }
}
async function proveBrowserOwnership(browser, executable, profileDir, launchToken) {
    const session = await browser.newBrowserCDPSession();
    try {
        const command = await session.send('Browser.getBrowserCommandLine');
        assertOwnedBrowserCommandLine(Array.isArray(command.arguments) ? command.arguments : [], executable, profileDir, launchToken);
        const processes = await session.send('SystemInfo.getProcessInfo');
        const browserPids = extractOwnedBrowserPids(processes.processInfo);
        return { browserPids };
    }
    finally {
        await session.detach().catch(() => undefined);
    }
}
async function focusVisibleLoginPage(context, launchUrl) {
    let page = context.pages().find((candidate) => isOfficialLoginUrl(candidate.url()));
    page ??= context.pages()[0] ?? await context.newPage();
    if (!isOfficialLoginUrl(page.url())) {
        await page.goto(launchUrl, { waitUntil: 'commit', timeout: 60_000 });
    }
    await page.bringToFront();
    const session = await context.newCDPSession(page);
    try {
        const { windowId } = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'normal' },
        });
        await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: { left: 48, top: 48, width: 1280, height: 840 },
        });
        const result = await session.send('Browser.getWindowBounds', { windowId });
        if (result.bounds?.windowState === 'minimized'
            || Number(result.bounds?.width) <= 0
            || Number(result.bounds?.height) <= 0) {
            throw nativeEdgeError('EDGE_WINDOW_NOT_VISIBLE', 'Microsoft Edge did not create a usable login window.');
        }
    }
    finally {
        await session.detach().catch(() => undefined);
    }
    return page;
}
async function proveOwnedVisibleEdgeWindow(browserPids, discovery) {
    const ownedBrowserPids = [...new Set(browserPids.filter(validPid))];
    if (ownedBrowserPids.length === 0) {
        throw nativeEdgeError('EDGE_OWNERSHIP_UNPROVEN', 'Microsoft Edge did not expose its owned browser process.');
    }
    const proofStartedAt = Date.now();
    const helperTimeoutMs = discovery
        ? discovery.startupTimeoutMs + EDGE_WINDOW_PROOF_STARTUP_ALLOWANCE_MS
        : EDGE_WINDOW_PROOF_TIMEOUT_MS;
    const failure = (reason, cause, exitCode) => edgeWindowProofError(reason, cause, {
        exitCode,
        elapsedMs: Date.now() - proofStartedAt,
        timeoutMs: helperTimeoutMs,
    });
    let stdout = '';
    let stderr = '';
    let outputOverflow = false;
    let child;
    try {
        child = spawn(WINDOWS_POWERSHELL_PATH, [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            OWNED_EDGE_WINDOW_PROOF_COMMAND,
        ], {
            windowsHide: true,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                BB1688_EDGE_WINDOW_PIDS: ownedBrowserPids.join(','),
                ...(discovery ? {
                    BB1688_EDGE_LAUNCH_TOKEN: discovery.launchToken,
                    BB1688_EDGE_PROFILE_PATH: discovery.profileDir,
                    BB1688_EDGE_EXECUTABLE: discovery.executable,
                    BB1688_EDGE_LAUNCH_STARTED_MS: String(discovery.launchStartedAt),
                    BB1688_EDGE_WINDOW_TIMEOUT_MS: String(discovery.startupTimeoutMs),
                } : {}),
            },
        });
    }
    catch (cause) {
        throw failure('spawn_failed', cause);
    }
    const collect = (current, chunk) => {
        if (outputOverflow)
            return current;
        const next = current + chunk.toString();
        if (Buffer.byteLength(next, 'utf8') > EDGE_WINDOW_PROOF_MAX_OUTPUT_BYTES) {
            outputOverflow = true;
            child.kill();
            return current;
        }
        return next;
    };
    child.stdout?.on('data', (chunk) => {
        stdout = collect(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
        stderr = collect(stderr, chunk);
    });
    const exitCode = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            finish(() => reject(failure('timeout', new Error('The Windows window proof helper timed out.'))));
            child.kill();
        }, helperTimeoutMs);
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            callback();
        };
        child.once('error', (cause) => {
            finish(() => reject(failure('process_error', cause)));
        });
        child.once('close', (code) => {
            finish(() => resolve(code));
        });
    });
    const proof = parseOwnedEdgeWindowProof(stdout, ownedBrowserPids, discovery !== undefined);
    if (exitCode !== 0 || outputOverflow || !proof) {
        const detail = [stderr.trim(), stdout.trim()]
            .filter(Boolean)
            .join(' | ')
            .slice(0, 2_000);
        const reason = classifyOwnedEdgeWindowProofFailure({ exitCode, outputOverflow, stdout, stderr });
        throw failure(reason, new Error(detail || `The Windows window proof helper exited with code ${String(exitCode)}.`), exitCode);
    }
    return proof;
}
function classifyOwnedEdgeWindowProofFailure({ exitCode, outputOverflow, stdout, stderr }) {
    if (outputOverflow)
        return 'output_overflow';
    let record;
    for (const line of stdout.replace(/^\uFEFF/, '').split(/\r?\n/).reverse()) {
        try {
            const candidate = JSON.parse(line.trim());
            if (candidate && typeof candidate === 'object') {
                record = candidate;
                break;
            }
        }
        catch { /* Only the helper's terminal JSON is used for safe classification. */ }
    }
    if (exitCode === 3 && record?.ok === false && record.reason === 'wrong_desktop')
        return 'wrong_desktop';
    if (exitCode === 4 && record?.ok === false && record.reason === undefined)
        return 'no_window';
    if (exitCode !== 0)
        return /(?:Add-Type|Compilation errors?|CompilerError|CS\d{4})/i.test(stderr)
            ? 'compilation_failed' : 'execution_failed';
    return 'invalid_proof';
}
function edgeWindowProofError(reason, cause, timing = {}) {
    const allowed = ['spawn_failed', 'process_error', 'compilation_failed', 'execution_failed',
        'output_overflow', 'invalid_proof', 'wrong_desktop', 'no_window', 'timeout'];
    const safeReason = allowed.includes(reason) ? reason : 'execution_failed';
    const [code, message] = safeReason === 'timeout'
        ? ['EDGE_WINDOW_PROOF_TIMEOUT', 'The Windows visibility check timed out before the Edge login window could be verified.']
        : safeReason === 'wrong_desktop'
            ? ['EDGE_WINDOW_WRONG_DESKTOP', 'Windows could not verify that the Edge login window is on the current interactive desktop.']
            : safeReason === 'no_window'
                ? ['EDGE_WINDOW_NOT_VISIBLE', 'Microsoft Edge did not create a visible, usable login window.']
                : ['EDGE_WINDOW_CHECK_FAILED', 'The Windows visibility check failed before the Edge login window could be verified.'];
    // Raw helper output remains diagnostic cause only; CLI messages and details
    // must never expose command lines, profile paths, account data or tokens.
    return nativeEdgeError(code, message, 1, cause).withDetails({
        stage: 'window_proof',
        reason: safeReason,
        exitCode: Number.isInteger(timing.exitCode) ? timing.exitCode : null,
        elapsedMs: Number.isFinite(timing.elapsedMs) ? Math.max(0, Math.round(timing.elapsedMs)) : null,
        timeoutMs: Number.isFinite(timing.timeoutMs) && timing.timeoutMs > 0 ? Math.round(timing.timeoutMs) : null,
    });
}
async function closeOwnedNativeEdge(session) {
    if (!session.owned)
        return;
    if (session.browser.isConnected()) {
        const cdp = await session.browser.newBrowserCDPSession();
        try {
            await cdp.send('Browser.close').catch(() => undefined);
        }
        finally {
            if (session.browser.isConnected()) {
                await cdp.detach().catch(() => undefined);
            }
        }
    }
    await Promise.all([
        waitForBrowserDisconnect(session.browser, EDGE_CLOSE_TIMEOUT_MS),
        ...session.browserPids.map((pid) => waitForProcessExit(pid, EDGE_CLOSE_TIMEOUT_MS)),
        waitForProfileRelease(session.profileDir, EDGE_CLOSE_TIMEOUT_MS),
    ]);
}
async function waitForDevToolsEndpoint(profileDir, child, timeoutMs) {
    const endpointFile = path.join(profileDir, DEVTOOLS_ACTIVE_PORT);
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
            throw nativeEdgeError('EDGE_LAUNCH_FAILED', 'Microsoft Edge exited before the login window was ready.');
        }
        const stat = await fsp.lstat(endpointFile).catch((error) => {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        });
        if (stat) {
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 512) {
                throw nativeEdgeError('EDGE_CDP_UNAVAILABLE', 'The Edge debugging marker is not a safe regular file.');
            }
            return parseDevToolsActivePort(await fsp.readFile(endpointFile, 'ascii'));
        }
        await delay(100);
    }
    throw nativeEdgeError('EDGE_CDP_UNAVAILABLE', 'Microsoft Edge did not expose its local verification channel in time.');
}
async function removeStaleDevToolsMarker(profileDir) {
    const target = path.join(profileDir, DEVTOOLS_ACTIVE_PORT);
    const stat = await fsp.lstat(target).catch((error) => {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    });
    if (!stat)
        return;
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw nativeEdgeError('EDGE_CDP_UNAVAILABLE', 'The stale Edge debugging marker is not a safe regular file.');
    }
    await fsp.rm(target);
}
async function profileIsBusy(profileDir) {
    for (const name of PROFILE_SINGLETONS) {
        try {
            await fsp.lstat(path.join(profileDir, name));
            return true;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                return true;
        }
    }
    return false;
}
export async function waitForProfileReleaseStability(profileDir, timeoutMs, stableMs) {
    if (!Number.isFinite(timeoutMs)
        || !Number.isFinite(stableMs)
        || timeoutMs <= 0
        || stableMs <= 0
        || stableMs >= timeoutMs) {
        throw nativeEdgeError('EDGE_PROFILE_RELEASE_CONFIG_INVALID', 'The Edge profile release window is invalid.');
    }
    const deadline = Date.now() + timeoutMs;
    let releasedAt;
    while (Date.now() < deadline) {
        if (await profileIsBusy(profileDir)) {
            releasedAt = undefined;
        }
        else {
            releasedAt ??= Date.now();
            if (Date.now() - releasedAt >= stableMs)
                return;
        }
        await delay(Math.max(10, Math.min(100, stableMs)));
    }
    throw nativeEdgeError('EDGE_PROFILE_BUSY', 'The dedicated 1688 Edge profile did not finish releasing in time.', 5);
}
async function waitForProfileRelease(profileDir, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await profileIsBusy(profileDir)))
            return;
        await delay(100);
    }
    throw nativeEdgeError('EDGE_PROFILE_BUSY', 'Microsoft Edge did not release the dedicated login profile in time.', 5);
}
function waitForBrowserDisconnect(browser, timeoutMs) {
    if (!browser.isConnected())
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            browser.off('disconnected', onDisconnected);
            reject(nativeEdgeError('EDGE_CLOSE_FAILED', 'Microsoft Edge did not close through its verified browser channel.'));
        }, timeoutMs);
        const onDisconnected = () => {
            clearTimeout(timer);
            resolve();
        };
        browser.once('disconnected', onDisconnected);
        if (!browser.isConnected())
            onDisconnected();
    });
}
async function waitForProcessExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!processIsAlive(pid))
            return;
        await delay(100);
    }
    if (processIsAlive(pid)) {
        throw nativeEdgeError('EDGE_PROCESS_STILL_RUNNING', 'The verified Microsoft Edge browser process did not exit.');
    }
}
function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
export function resolveMicrosoftEdgeExecutable() {
    const candidates = [
        process.env['ProgramFiles(x86)'],
        process.env.ProgramFiles,
        process.env.LOCALAPPDATA,
    ].filter((value) => Boolean(value)).map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    const executable = [...new Set(candidates)].find((candidate) => fs.existsSync(candidate));
    if (!executable) {
        throw nativeEdgeError('EDGE_MISSING', 'Microsoft Edge is required for the dedicated 1688 login.', 6);
    }
    return executable;
}
function requireOfficialLoginUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !isOfficialLoginHost(url.hostname))
            throw new Error();
        return url.toString();
    }
    catch {
        throw nativeEdgeError('EDGE_LAUNCH_URL_INVALID', 'Only official 1688 or Taobao pages may be opened for login.');
    }
}
function isOfficialLoginUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && isOfficialLoginHost(url.hostname);
    }
    catch {
        return false;
    }
}
function isOfficialLoginHost(value) {
    const host = value.toLowerCase();
    return host === '1688.com'
        || host.endsWith('.1688.com')
        || host === 'taobao.com'
        || host.endsWith('.taobao.com');
}
function findSwitch(args, prefix) {
    const value = args.find((arg) => arg.toLowerCase().startsWith(prefix.toLowerCase()));
    return value ? value.slice(prefix.length) : null;
}
function normalizeWindowsPath(value) {
    return path.win32.resolve(value.replace(/^"|"$/g, '')).replace(/[\\/]+$/, '').toLowerCase();
}
function validPid(value) {
    return Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}
function errorHasCode(error, code) {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === code;
}
function waitForSpawn(child, timeoutMs) {
    if (child.pid)
        return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(() => reject(nativeEdgeError('EDGE_LAUNCH_FAILED', 'Microsoft Edge did not acknowledge startup.'))), timeoutMs);
        const onSpawn = () => finish(resolve);
        const onError = (cause) => finish(() => reject(nativeEdgeError('EDGE_LAUNCH_FAILED', 'Microsoft Edge could not be started.', 6, cause)));
        const finish = (callback) => {
            clearTimeout(timer);
            child.off('spawn', onSpawn);
            child.off('error', onError);
            callback();
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
    });
}
function nativeEdgeError(code, message, exitCode = 1, cause) {
    const error = new CliError(exitCode, code, message);
    if (cause !== undefined)
        error.cause = cause;
    return error;
}
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
//# sourceMappingURL=native-edge.js.map
