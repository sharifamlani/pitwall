import * as vscode from 'vscode';

/**
 * The two sound switches and the Repos-header bell (row 5.3, Q41, Q47).
 *
 * Both default to off. A pop-up plays a sound only when its own kind's switch
 * is on: Windows' "Notification.Default" for the pop-up, "Glass" for the macOS
 * banner. The bell is the quick way to flip them; it writes only
 * `pitwall.sound.*`, only on the user's click, to the user (Global) target.
 */
export type SoundKind = 'needs' | 'finished';

/** The setting behind each kind, under `pitwall.`. */
const KEYS: Record<SoundKind, string> = { needs: 'sound.needsYou', finished: 'sound.finished' };

/** The context key the bell's two icons follow: true when either switch is on. */
export const SOUND_ON_CONTEXT = 'pitwall.soundOn';

type ConfigSource = () => vscode.WorkspaceConfiguration;

export class SoundSwitches implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this.emitter.event;
  private readonly listener: vscode.Disposable;

  constructor(private readonly config: ConfigSource = () => vscode.workspace.getConfiguration('pitwall')) {
    this.listener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('pitwall.sound')) {
        this.emitter.fire();
      }
    });
  }

  get(kind: SoundKind): boolean {
    return this.config().get<boolean>(KEYS[kind], false) === true;
  }

  /** True when either switch is on. */
  any(): boolean {
    return this.get('needs') || this.get('finished');
  }

  /** Write one switch to the user's settings (Q47 = A). Touches no other key. */
  async set(kind: SoundKind, on: boolean): Promise<void> {
    await this.config().update(KEYS[kind], on, vscode.ConfigurationTarget.Global);
    this.emitter.fire();
  }

  dispose(): void {
    this.listener.dispose();
    this.emitter.dispose();
  }
}

interface SoundItem extends vscode.QuickPickItem {
  sound: SoundKind;
}

/**
 * The bell's checkbox quick pick (§3d). Ticks match the settings; Enter
 * writes only the ones that changed; the Test sound button plays one pop-up
 * and keeps the menu open. Resolves when the menu closes.
 */
export function showSoundMenu(switches: SoundSwitches, testSound: () => Promise<void>): Promise<void> {
  const pick = vscode.window.createQuickPick<SoundItem>();
  pick.title = 'Sound alerts';
  pick.placeholder = 'Off by default. When on, the Windows pop-up plays the system notification sound. Also in Settings → Pitwall → Sound.';
  pick.canSelectMany = true;
  const items: SoundItem[] = [
    { label: 'When a session needs you', sound: 'needs' },
    { label: 'When a session finishes', sound: 'finished' },
  ];
  pick.items = items;
  pick.selectedItems = items.filter((item) => switches.get(item.sound));
  pick.buttons = [{ iconPath: new vscode.ThemeIcon('play'), tooltip: 'Test sound' }];

  return new Promise<void>((resolve) => {
    const subscriptions: vscode.Disposable[] = [];
    let applying: Promise<void> = Promise.resolve();
    subscriptions.push(
      pick.onDidTriggerButton(() => {
        void testSound().catch(() => undefined);
      }),
      pick.onDidAccept(() => {
        const ticked = new Set(pick.selectedItems.map((item) => item.sound));
        applying = (async () => {
          for (const item of items) {
            if (ticked.has(item.sound) !== switches.get(item.sound)) {
              await switches.set(item.sound, ticked.has(item.sound));
            }
          }
        })();
        pick.hide();
      }),
      pick.onDidHide(() => {
        subscriptions.forEach((subscription) => subscription.dispose());
        pick.dispose();
        void applying.catch(() => undefined).then(resolve);
      })
    );
    pick.show();
  });
}

/**
 * Register the bell's commands (one handler behind two icons, told apart by
 * `pitwall.soundOn`) and keep that context key current.
 */
export function registerSoundUi(switches: SoundSwitches, testSound: () => Promise<void>): vscode.Disposable[] {
  const refresh = () => void vscode.commands.executeCommand('setContext', SOUND_ON_CONTEXT, switches.any());
  refresh();
  const open = () => showSoundMenu(switches, testSound);
  return [
    vscode.commands.registerCommand('pitwall.soundMenu', open),
    vscode.commands.registerCommand('pitwall.soundMenuOn', open),
    vscode.commands.registerCommand('pitwall.testSound', testSound),
    switches.onDidChange(refresh),
  ];
}
