import { NotifierSetting, WindowsToast } from './WindowsToast';

/**
 * What Windows would do with Pitwall's pop-ups (row 5.5, Q42). Read-only: the
 * registry switch for all toasts, `ToastNotifier.Setting` for Pitwall's own
 * sender, and Focus assist. Anything that can't be read is 'unknown', and
 * 'unknown' never prompts. vscode-free.
 */
export interface NotificationState {
  toasts: 'on' | 'off' | 'unknown';
  app: 'on' | 'off' | 'unknown';
  focus: 'off' | 'priority' | 'alarms' | 'unknown';
}

export interface Readers {
  /** `{ toasts, focus }` raw answers (WindowsToast.readState). */
  state(): Promise<{ toasts: string; focus: string }>;
  /** `ToastNotifier.Setting` for Pitwall's AUMID (WindowsToast.notifierSetting). */
  notifier(): Promise<NotifierSetting>;
}

/** Readers over a toast host. `registered` gates the app switch: before registration Windows doesn't know the sender. */
export function readersFor(toast: WindowsToast, registered: Promise<'ok' | 'failed'> = Promise.resolve('ok')): Readers {
  return {
    state: () => toast.readState(),
    notifier: async () => ((await registered) === 'ok' ? toast.notifierSetting() : 'unknown'),
  };
}

const orFallback = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await read();
  } catch {
    return fallback;
  }
};

export async function notificationState(read: Readers = readersFor(new WindowsToast())): Promise<NotificationState> {
  const [raw, setting] = await Promise.all([
    orFallback(() => read.state(), { toasts: 'unknown', focus: 'unknown' }),
    orFallback<NotifierSetting>(() => read.notifier(), 'unknown'),
  ]);
  const toasts = raw.toasts === 'on' || raw.toasts === 'off' ? raw.toasts : 'unknown';
  const focus = raw.focus === 'off' || raw.focus === 'priority' || raw.focus === 'alarms' ? raw.focus : 'unknown';
  const app = setting === 'enabled' ? 'on' : setting === 'unknown' ? 'unknown' : 'off';
  return { toasts, app, focus };
}
