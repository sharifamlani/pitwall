import * as childProcess from 'child_process';
import { toastXml, ToastPayload } from './toastXml';

/**
 * The Windows pop-up host (row 5.2, ADR 0022). vscode-free: the uninstall
 * script loads it too.
 *
 * Pop-ups go through one warm `powershell.exe -NoProfile -NonInteractive
 * -Command -` per window, hidden with `windowsHide` (no `-WindowStyle Hidden`
 * and no `-ExecutionPolicy Bypass`, two common EDR heuristics; QA N7). Its
 * stdin is first a constant script (`HOST_LOOP_SCRIPT`) that loads WinRT
 * once and then reads one line per pop-up: a base64 literal of UTF-8 JSON
 * `{aumid, xml, tag}`, which it decodes and hands to WinRT as data, answering
 * one line. So pop-up text (repo name, chat title, wait reason) never reaches
 * argv, which every process can read, and never becomes PowerShell code (QA
 * B2). A cold host took 0.6–1.3 s per pop-up to start PowerShell and load
 * WinRT, most of the gap between a status change and its pop-up (PR #76 live
 * gate); a warm one answers in tens of milliseconds. The host starts when the
 * attention tick sees a chat at work (`warm`), and exits once unused for
 * `HOST_IDLE_MS`. Registration and the read-only checks stay one-shot hosts.
 *
 * The sender is Pitwall's own AppUserModelID, registered per user under
 * `HKCU\Software\Classes\AppUserModelId\sharifamlani.pitwall` (Q46 = A): no
 * admin, removed by "Pitwall: Remove Pop-up Registration" and on uninstall.
 */

/** Pitwall's AppUserModelID: the pop-up sender (Q46). */
export const AUMID = 'sharifamlani.pitwall';
/** The one per-user key Pitwall writes (PowerShell's registry drive). */
export const AUMID_KEY = `HKCU:\\Software\\Classes\\AppUserModelId\\${AUMID}`;
/** Windows' own per-app entry for Pitwall's pop-up switch; removed with the registration. No other app's key is ever touched. */
export const NOTIFICATION_SETTINGS_KEY = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\${AUMID}`;
export const POWERSHELL = 'powershell.exe';
export const POWERSHELL_ARGS: readonly string[] = Object.freeze(['-NoProfile', '-NonInteractive', '-Command', '-']);
/** A host still running after this long is killed and the pop-up counts as failed. */
export const TOAST_TIMEOUT_MS = 10_000;
/** A warm pop-up host unused this long exits (its stdin is closed); the next pop-up or `warm` starts another. */
export const HOST_IDLE_MS = 3 * 60_000;

/**
 * PowerShell reads `-Command -` like an interactive prompt: a multi-line block
 * runs only once a blank line ends it. Every script below ends with one.
 */
const LOAD_WINRT =
  '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null\n' +
  '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] > $null\n';
const DECODE = '  $j = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($p)) | ConvertFrom-Json\n';
const CATCH =
  '} catch {\n' +
  '  $e = $_.Exception\n' +
  '  if ($e.InnerException) { $e = $e.InnerException }\n' +
  "  'failed 0x{0:X8}' -f $e.HResult\n" +
  '  exit 3\n' +
  '}\n\n';

/**
 * The warm pop-up host's whole script. Byte-constant: nothing is ever added to
 * it. It is one block, so PowerShell has read all of it before it prints
 * `ready`; only then are pop-up lines written. Each line is one base64
 * literal, read as data with `[Console]::In.ReadLine()` and never evaluated;
 * each gets exactly one answer line, `shown` or `failed <reason>`. A sender
 * that Windows has switched off (`ToastNotifier.Setting`) fails with that
 * setting's name, so the in-window message takes over (Q35). `dry` (tests
 * only) builds the toast and stops before Show. End of input (Pitwall closed
 * stdin, or its window went away) ends the loop and the process.
 */
export const HOST_LOOP_SCRIPT =
  "$ErrorActionPreference = 'Stop'\n" +
  'try {\n' +
  LOAD_WINRT +
  // Warm-up on constants only, nothing shown: the first use of each call costs ~250 ms, so the first pop-up doesn't pay it.
  '  try {\n' +
  `    $null = Test-Path -LiteralPath '${AUMID_KEY}'\n` +
  "    $null = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('e30=')) | ConvertFrom-Json\n" +
  `    $null = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').get_Setting()\n` +
  '    $d = New-Object Windows.Data.Xml.Dom.XmlDocument\n' +
  "    $d.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>-</text></binding></visual></toast>')\n" +
  '    $null = New-Object Windows.UI.Notifications.ToastNotification $d\n' +
  '  } catch { }\n' +
  "  'ready'\n" +
  '  while ($true) {\n' +
  '    $p = [Console]::In.ReadLine()\n' +
  '    if ($null -eq $p) { break }\n' +
  '    try {\n' +
  '    ' +
  DECODE +
  // Another window ran "Remove Pop-up Registration", or Pitwall was uninstalled elsewhere: Windows would drop this toast silently.
  // A dry run (tests only) never shows, so it needs no registration.
  `      if (-not $j.dry) { if (-not (Test-Path -LiteralPath '${AUMID_KEY}')) { 'failed unregistered'; continue } }\n` +
  '      $n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$j.aumid)\n' +
  "      $s = 'Unknown'\n" +
  "      try { $s = [string]$n.get_Setting() } catch { $s = 'Unknown' }\n" +
  "      if ($s -ne 'Enabled' -and $s -ne 'Unknown') { 'failed ' + $s; continue }\n" +
  '      $d = New-Object Windows.Data.Xml.Dom.XmlDocument\n' +
  '      $d.LoadXml([string]$j.xml)\n' +
  '      $t = New-Object Windows.UI.Notifications.ToastNotification $d\n' +
  '      $t.Tag = [string]$j.tag\n' +
  "      $t.Group = 'pitwall'\n" +
  '      if (-not $j.dry) { $n.Show($t) }\n' +
  "      'shown'\n" +
  '    } catch {\n' +
  '      $e = $_.Exception\n' +
  '      if ($e.InnerException) { $e = $e.InnerException }\n' +
  "      'failed 0x{0:X8}' -f $e.HResult\n" +
  '    }\n' +
  '  }\n' +
  CATCH;

/** Registration up to its payload literal (`{icon}`). Byte-constant. */
const REGISTER_PREFIX = "$ErrorActionPreference = 'Stop'\n" + 'try {\n' + '  $p = ';
/** Writes DisplayName and IconUri only when they differ: idempotent, and a moved extension refreshes IconUri. */
const REGISTER_SUFFIX =
  '\n' +
  DECODE +
  `  $k = '${AUMID_KEY}'\n` +
  '  if (-not (Test-Path -LiteralPath $k)) { New-Item -Path $k -Force > $null }\n' +
  '  $c = Get-ItemProperty -LiteralPath $k\n' +
  "  $w = 'unchanged'\n" +
  "  if ($c.DisplayName -ne 'Pitwall') { New-ItemProperty -LiteralPath $k -Name DisplayName -Value 'Pitwall' -PropertyType String -Force > $null; $w = 'written' }\n" +
  "  if ($c.IconUri -ne [string]$j.icon) { New-ItemProperty -LiteralPath $k -Name IconUri -Value ([string]$j.icon) -PropertyType String -Force > $null; $w = 'written' }\n" +
  '  $w\n' +
  '  exit 0\n' +
  CATCH;

/** Removes the registration key and Windows' own entry for Pitwall (two constant paths), so Pitwall leaves Settings → Notifications. */
const UNREGISTER_SCRIPT =
  `Remove-Item -LiteralPath '${AUMID_KEY}' -Recurse -ErrorAction SilentlyContinue\n` +
  `Remove-Item -LiteralPath '${NOTIFICATION_SETTINGS_KEY}' -Recurse -ErrorAction SilentlyContinue\n` +
  "'removed'\n\n";

/** `ToastNotifier.Setting` for the AUMID; the getter, since PowerShell turns a throwing property into $null. */
const SETTING_SCRIPT =
  "$ErrorActionPreference = 'Stop'\n" +
  'try {\n' +
  LOAD_WINRT +
  `  [string][Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${AUMID}').get_Setting()\n` +
  '} catch {\n' +
  "  'unknown'\n" +
  '}\n\n';

/**
 * Read-only: "Toasts for all apps" (`PushNotifications\ToastEnabled`, missing =
 * on) and Focus assist (the shell's quiet-hours WNF state, 0 off, 1 priority
 * only, 2 alarms only). Same reads as `scripts/toast-probe.ps1 -State`. Writes
 * nothing; anything it can't read answers `unknown`.
 */
const STATE_SCRIPT =
  "$ErrorActionPreference = 'Stop'\n" +
  "$t = 'unknown'\n" +
  'try {\n' +
  "  $v = (Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications' -ErrorAction Stop).ToastEnabled\n" +
  "  if ($null -eq $v -or $v -ne 0) { $t = 'on' } else { $t = 'off' }\n" +
  "} catch { $t = 'on' }\n" +
  "$f = 'unknown'\n" +
  'try {\n' +
  "  Add-Type -Namespace PitwallProbe -Name Wnf -MemberDefinition @'\n" +
  '[DllImport("ntdll.dll")]\n' +
  'public static extern int NtQueryWnfStateData(ref ulong stateName, IntPtr typeId, IntPtr explicitScope, out uint changeStamp, out int buffer, ref uint bufferSize);\n' +
  "'@\n" +
  "  $n = [UInt64]'0x0D83063EA3BF1C75'\n" +
  '  $c = [UInt32]0\n' +
  '  $b = 0\n' +
  '  $z = [UInt32]4\n' +
  '  $r = [PitwallProbe.Wnf]::NtQueryWnfStateData([ref]$n, [IntPtr]::Zero, [IntPtr]::Zero, [ref]$c, [ref]$b, [ref]$z)\n' +
  "  if ($r -eq 0) { $f = switch ($b) { 0 { 'off' } 1 { 'priority' } 2 { 'alarms' } default { 'unknown' } } }\n" +
  "} catch { $f = 'unknown' }\n" +
  '"toasts=$t focus=$f"\n\n';

export type NotifierSetting = 'enabled' | 'disabledForUser' | 'disabledForApplication' | 'disabledByGroupPolicy' | 'unknown';

const SETTINGS: Record<string, NotifierSetting> = {
  Enabled: 'enabled',
  DisabledForUser: 'disabledForUser',
  DisabledForApplication: 'disabledForApplication',
  DisabledByGroupPolicy: 'disabledByGroupPolicy',
};

/** The part of a child process the host uses. */
export interface HostProcess {
  stdin: {
    /** The warm pop-up host writes its script, then one line per pop-up. */
    write?(data: string): unknown;
    end(data?: string): void;
    on?(event: 'error', listener: (error: Error) => void): unknown;
  } | null;
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
  kill(): boolean;
}

export type SpawnFn = (command: string, args: readonly string[], options: childProcess.SpawnOptions) => HostProcess;

export interface WindowsToastOptions {
  /** The Operations log: `[Pitwall] toast failed <code>`, never a title or a path. */
  log?: (line: string) => void;
}

interface HostResult {
  /** The last stdout line, trimmed. */
  answer: string;
  /** Why it failed (`timeout`, a spawn error code, `exit<N>`, the script's own reason), or undefined. */
  failure?: string;
}

/** UTF-8 JSON as base64: the only part of any host's input that varies. */
function base64(data: unknown): string {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
}

/** One base64 literal of UTF-8 JSON, single-quoted, for a one-shot script. */
function literal(data: unknown): string {
  return `'${base64(data)}'`;
}

/** The warm pop-up host's two answers; any other stdout line is ignored. */
const ANSWER = /^(shown|failed \S+)$/;

/** The warm pop-up host: one PowerShell for every pop-up of this window. */
interface WarmHost {
  child: HostProcess;
  /** It printed `ready`: its script is read and WinRT is loaded. */
  ready: boolean;
  /** Runs once it is ready (the pop-up waiting to be written). */
  onReady?: () => void;
  /** The pop-up waiting for its answer line; `failure` when the host ended first. */
  waiter?: (answer: string, failure?: string) => void;
  ended: boolean;
}

export class WindowsToast {
  /** Hosts run one at a time per window; later ones queue. */
  private tail: Promise<unknown> = Promise.resolve();
  /** The icon path registered in this activation, and its outcome. */
  private registration?: { icon: string; result: Promise<'ok' | 'failed'> };
  /** "Remove Pop-up Registration" ran: no pop-up spawns until the next activation registers again. */
  private removed = false;
  /** The warm pop-up host, while one runs. */
  private host?: WarmHost;
  /** Closes the warm host once it has gone unused for HOST_IDLE_MS. */
  private idleTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly spawn: SpawnFn = childProcess.spawn as unknown as SpawnFn,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly options: WindowsToastOptions = {}
  ) {}

  /**
   * Show one pop-up. Resolves 'failed' on any other platform, after "Remove
   * Pop-up Registration", when the host fails or runs past 10 s, or when
   * Windows has switched Pitwall's pop-ups off; the caller then shows the
   * in-window message (Q35). Waits behind registration and any earlier pop-up.
   */
  async show(p: ToastPayload, options: { dryRun?: boolean } = {}): Promise<'shown' | 'failed'> {
    if (this.platform !== 'win32') {
      return 'failed';
    }
    if (this.removed || this.disposed) {
      this.options.log?.('[Pitwall] toast failed unregistered');
      return 'failed';
    }
    const data = { aumid: p.aumid, xml: toastXml(p), tag: p.tag, ...(options.dryRun ? { dry: true } : {}) };
    const line = base64(data);
    const job = this.tail.then(() => this.showOnHost(line));
    this.tail = job.catch(() => undefined);
    const result = await job;
    if (!result.failure && result.answer === 'shown') {
      return 'shown';
    }
    this.options.log?.(`[Pitwall] toast failed ${result.failure ?? 'no-answer'}`);
    return 'failed';
  }

  /**
   * Start the warm pop-up host now, so the next pop-up skips PowerShell's
   * start (0.6–1.3 s). The attention tick calls it while any chat is at work;
   * each call also restarts the idle clock. Does nothing off Windows, after
   * "Remove Pop-up Registration", or once disposed.
   */
  warm(): void {
    if (this.platform !== 'win32' || this.removed || this.disposed) {
      return;
    }
    this.ensureHost();
    this.touch();
  }

  /** Close the warm host (its stdin ends, so PowerShell exits); no pop-up starts another. */
  dispose(): void {
    this.disposed = true;
    this.stopHost(false);
  }

  /** Restart the idle clock: the warm host closes once unused for HOST_IDLE_MS. */
  private touch(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // A pop-up still waiting for its answer keeps the host until its own timeout.
      if (this.host && !this.host.waiter) {
        this.stopHost(false);
      }
    }, HOST_IDLE_MS);
    this.idleTimer.unref?.();
  }

  /** The running warm host, or a new one; the spawn error's code when PowerShell can't start. */
  private ensureHost(): WarmHost | string {
    if (this.host && !this.host.ended) {
      return this.host;
    }
    let child: HostProcess;
    try {
      child = this.spawn(POWERSHELL, POWERSHELL_ARGS, { windowsHide: true, stdio: 'pipe' });
    } catch (error) {
      return (error as NodeJS.ErrnoException).code ?? 'spawn';
    }
    const host: WarmHost = { child, ready: false, ended: false };
    let out = '';
    const end = (failure: string) => {
      if (host.ended) {
        return;
      }
      host.ended = true;
      if (this.host === host) {
        this.host = undefined;
      }
      const waiter = host.waiter;
      host.waiter = undefined;
      host.onReady = undefined;
      waiter?.('', failure);
    };
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
      for (let newline = out.indexOf('\n'); newline >= 0; newline = out.indexOf('\n')) {
        const line = out.slice(0, newline).trim();
        out = out.slice(newline + 1);
        if (line === 'ready' && !host.ready) {
          host.ready = true;
          const send = host.onReady;
          host.onReady = undefined;
          send?.();
        } else if (ANSWER.test(line) && host.waiter) {
          const waiter = host.waiter;
          host.waiter = undefined;
          waiter(line);
        }
      }
    });
    child.on('error', (error) => end(error.code ?? 'spawn'));
    child.on('close', (code) => end(`exit${code ?? ''}`));
    child.stdin?.on?.('error', () => undefined);
    this.host = host;
    try {
      if (!child.stdin?.write) {
        throw new Error('no stdin');
      }
      child.stdin.write(HOST_LOOP_SCRIPT);
    } catch {
      this.stopHost(true);
      return 'stdin';
    }
    return host;
  }

  /** End the warm host: close its stdin (it exits at end of input), or kill it when it is stuck. */
  private stopHost(kill: boolean): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const host = this.host;
    if (!host) {
      return;
    }
    this.host = undefined;
    try {
      if (kill) {
        host.child.kill();
      } else {
        host.child.stdin?.end();
      }
    } catch {
      // Already gone.
    }
  }

  /** Hand one pop-up line to the warm host and wait for its answer, at most TOAST_TIMEOUT_MS from now. */
  private showOnHost(line: string): Promise<HostResult> {
    if (this.removed || this.disposed) {
      return Promise.resolve({ answer: '', failure: 'unregistered' });
    }
    const host = this.ensureHost();
    this.touch();
    if (typeof host === 'string') {
      return Promise.resolve({ answer: '', failure: host });
    }
    return new Promise<HostResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        host.waiter = undefined;
        host.onReady = undefined;
        // A host that did not answer in 10 s is stuck: the next pop-up starts a fresh one.
        if (this.host === host) {
          this.stopHost(true);
        } else {
          host.child.kill();
        }
        resolve({ answer: '', failure: 'timeout' });
      }, TOAST_TIMEOUT_MS);
      timer.unref?.();
      host.waiter = (answer, failure) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        // The script's own reason ("failed DisabledForUser", "failed 0x80070490") is the failure.
        const reason = /^failed (\S+)$/.exec(answer)?.[1];
        resolve({ answer, failure: reason ?? failure });
      };
      const send = () => {
        try {
          host.child.stdin?.write?.(`${line}\n`);
        } catch {
          host.waiter?.('', 'stdin');
        }
      };
      if (host.ready) {
        send();
      } else {
        host.onReady = send;
      }
    });
  }

  /**
   * Write the per-user AUMID key once per activation (Q46 = A). Idempotent:
   * the script writes only values that differ, and the same icon path asks
   * nothing a second time. A new extension path (an update) refreshes IconUri.
   */
  registerAumid(iconPath: string): Promise<'ok' | 'failed'> {
    if (this.platform !== 'win32') {
      return Promise.resolve('failed');
    }
    if (this.registration?.icon === iconPath && !this.removed) {
      return this.registration.result;
    }
    this.removed = false;
    const result = this.run(REGISTER_PREFIX + literal({ icon: iconPath }) + REGISTER_SUFFIX).then((outcome) => {
      if (!outcome.failure && (outcome.answer === 'written' || outcome.answer === 'unchanged')) {
        return 'ok' as const;
      }
      this.options.log?.(`[Pitwall] toast failed register-${outcome.failure ?? 'no-answer'}`);
      return 'failed' as const;
    });
    this.registration = { icon: iconPath, result };
    return result;
  }

  /** Remove the per-user key. Pop-ups in this window then use the in-window message. */
  async unregisterAumid(): Promise<void> {
    if (this.platform !== 'win32') {
      return;
    }
    this.removed = true;
    this.registration = undefined;
    // No pop-up may show from here on, so the warm host goes too.
    this.stopHost(false);
    await this.run(UNREGISTER_SCRIPT);
  }

  /** Windows' switch for Pitwall's pop-ups (`ToastNotifier.Setting`); 'unknown' when it can't be read. */
  async notifierSetting(): Promise<NotifierSetting> {
    if (this.platform !== 'win32') {
      return 'unknown';
    }
    const result = await this.run(SETTING_SCRIPT);
    return (!result.failure && SETTINGS[result.answer]) || 'unknown';
  }

  /**
   * Windows' "toasts for all apps" switch and Focus assist, read-only (row 5.5).
   * Each answer is 'unknown' when it can't be read.
   */
  async readState(): Promise<{ toasts: string; focus: string }> {
    if (this.platform !== 'win32') {
      return { toasts: 'unknown', focus: 'unknown' };
    }
    const result = await this.run(STATE_SCRIPT);
    const match = !result.failure ? /^toasts=(\S+) focus=(\S+)$/.exec(result.answer) : null;
    return { toasts: match?.[1] ?? 'unknown', focus: match?.[2] ?? 'unknown' };
  }

  /** Queue one host behind the one in flight. */
  private run(script: string): Promise<HostResult> {
    const job = this.tail.then(() => this.runNow(script));
    this.tail = job.catch(() => undefined);
    return job;
  }

  private runNow(script: string): Promise<HostResult> {
    return new Promise<HostResult>((resolve) => {
      let out = '';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const done = (failure?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const answer = lines.at(-1) ?? '';
        // The script's own reason ("failed DisabledForUser", "failed 0x80070490") beats the exit code.
        const reason = /^failed (\S+)$/.exec(answer)?.[1];
        resolve({ answer, failure: reason ?? failure });
      };
      let child: HostProcess;
      try {
        child = this.spawn(POWERSHELL, POWERSHELL_ARGS, { windowsHide: true, stdio: 'pipe' });
      } catch (error) {
        done((error as NodeJS.ErrnoException).code ?? 'spawn');
        return;
      }
      timer = setTimeout(() => {
        child.kill();
        out = '';
        done('timeout');
      }, TOAST_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.on('data', (chunk) => {
        out += String(chunk);
      });
      child.on('error', (error) => done(error.code ?? 'spawn'));
      child.on('close', (code) => done(code === 0 ? undefined : `exit${code ?? ''}`));
      child.stdin?.on?.('error', () => undefined);
      child.stdin?.end(script);
    });
  }
}
