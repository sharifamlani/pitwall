import * as childProcess from 'child_process';
import { toastXml, ToastPayload } from './toastXml';

/**
 * The Windows pop-up host (row 5.2, ADR 0022). vscode-free: the uninstall
 * script loads it too.
 *
 * Each pop-up is one short-lived `powershell.exe -NoProfile -NonInteractive
 * -Command -`, hidden with `windowsHide` (no `-WindowStyle Hidden` and no
 * `-ExecutionPolicy Bypass`, two common EDR heuristics; QA N7). Its stdin is a
 * constant script whose only variable part is one single-quoted base64 literal
 * of UTF-8 JSON `{aumid, xml, tag}`, which the script decodes and hands to
 * WinRT as data. So pop-up text (repo name, chat title, wait reason) never
 * reaches argv, which every process can read, and never becomes PowerShell
 * code (QA B2).
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

/** The pop-up script up to its payload literal. Byte-constant. */
export const HOST_SCRIPT_PREFIX = "$ErrorActionPreference = 'Stop'\n" + 'try {\n' + '  $p = ';
/**
 * The pop-up script after its payload literal. Byte-constant. A sender that
 * Windows has switched off (`ToastNotifier.Setting`) fails with that setting's
 * name, so the in-window message takes over (Q35). `dry` (tests only) builds
 * the toast and stops before Show.
 */
export const HOST_SCRIPT_SUFFIX =
  '\n' +
  DECODE +
  LOAD_WINRT +
  // Another window ran "Remove Pop-up Registration", or Pitwall was uninstalled elsewhere: Windows would drop this toast silently.
  // A dry run (tests only) never shows, so it needs no registration.
  `  if (-not $j.dry) { if (-not (Test-Path -LiteralPath '${AUMID_KEY}')) { 'failed unregistered'; exit 2 } }\n` +
  '  $n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$j.aumid)\n' +
  "  $s = 'Unknown'\n" +
  '  try { $s = [string]$n.get_Setting() } catch { $s = \'Unknown\' }\n' +
  "  if ($s -ne 'Enabled' -and $s -ne 'Unknown') { 'failed ' + $s; exit 2 }\n" +
  '  $d = New-Object Windows.Data.Xml.Dom.XmlDocument\n' +
  '  $d.LoadXml([string]$j.xml)\n' +
  '  $t = New-Object Windows.UI.Notifications.ToastNotification $d\n' +
  '  $t.Tag = [string]$j.tag\n' +
  "  $t.Group = 'pitwall'\n" +
  "  if ($j.dry) { 'shown'; exit 0 }\n" +
  '  $n.Show($t)\n' +
  "  'shown'\n" +
  '  exit 0\n' +
  CATCH;

/** Registration up to its payload literal (`{icon}`). Byte-constant. */
const REGISTER_PREFIX = HOST_SCRIPT_PREFIX;
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
  stdin: { end(data: string): void; on?(event: 'error', listener: (error: Error) => void): unknown } | null;
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

/** One base64 literal of UTF-8 JSON: the only part of a script that varies. */
function literal(data: unknown): string {
  return `'${Buffer.from(JSON.stringify(data), 'utf8').toString('base64')}'`;
}

export class WindowsToast {
  /** Hosts run one at a time per window; later ones queue. */
  private tail: Promise<unknown> = Promise.resolve();
  /** The icon path registered in this activation, and its outcome. */
  private registration?: { icon: string; result: Promise<'ok' | 'failed'> };
  /** "Remove Pop-up Registration" ran: no pop-up spawns until the next activation registers again. */
  private removed = false;

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
    if (this.removed) {
      this.options.log?.('[Pitwall] toast failed unregistered');
      return 'failed';
    }
    const data = { aumid: p.aumid, xml: toastXml(p), tag: p.tag, ...(options.dryRun ? { dry: true } : {}) };
    const result = await this.run(HOST_SCRIPT_PREFIX + literal(data) + HOST_SCRIPT_SUFFIX);
    if (!result.failure && result.answer === 'shown') {
      return 'shown';
    }
    this.options.log?.(`[Pitwall] toast failed ${result.failure ?? 'no-answer'}`);
    return 'failed';
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
