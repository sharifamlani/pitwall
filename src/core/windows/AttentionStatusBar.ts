import * as vscode from 'vscode';
import { JumpWalk } from './JumpWalk';

export type StatusKind = 'needs' | 'working' | 'finished';

export interface Counts {
  needs: number;
  working: number;
  finished: number;
}

/** What the bar reads: the sidebar list's counts (Q38) and when they change. */
export interface AttentionSource {
  counts(): Counts;
  onDidChange: vscode.Event<unknown>;
  /** The needs-you chats Next ▸ could still visit from this window (the one in front here left out). */
  order?(): string[];
}

/** The command a count opens its list with, and the one Next ▸ runs. */
export const SHOW_STATUS_LIST = 'pitwall.showStatusList';
export const JUMP_NEXT = 'pitwall.jumpNext';

/** Just after the repo item (priority 100), which sits first on the left. */
const FIRST_PRIORITY = 99;

interface Kind {
  kind: StatusKind;
  text: (n: number) => string;
  title: string;
  tooltip: (n: number) => string;
  color: string;
}

const KINDS: Kind[] = [
  {
    kind: 'needs',
    text: (n) => `$(bell) ${n} need you`,
    title: 'List the sessions that need you',
    tooltip: (n) => (n === 1 ? '1 session needs you. Click to list it.' : `${n} sessions need you. Click to list them.`),
    color: 'charts.orange',
  },
  {
    kind: 'working',
    text: (n) => `$(circle-filled) ${n} working`,
    title: 'List the sessions that are working',
    tooltip: (n) => (n === 1 ? '1 session is working. Click to list it.' : `${n} sessions are working. Click to list them.`),
    color: 'charts.blue',
  },
  {
    kind: 'finished',
    text: (n) => `$(circle-filled) ${n} finished`,
    title: 'List the sessions that finished',
    tooltip: (n) => (n === 1 ? '1 session finished. Click to list it.' : `${n} sessions finished. Click to list them.`),
    color: 'charts.green',
  },
];

/**
 * The bottom bar's `{n} need you` · `{n} working` · `{n} finished` (row 5.4,
 * Q38), each hidden at 0, right after the repo item, the same numbers in
 * every window because every window counts the same sidebar list. After a
 * jump, while another session waits, `Next ▸` follows them (Q40).
 */
export class AttentionStatusBar implements vscode.Disposable {
  private readonly items = new Map<StatusKind, vscode.StatusBarItem>();
  private readonly next: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** A newer refresh makes an older one's walk lookup stale. */
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly source: AttentionSource,
    private readonly walk: JumpWalk
  ) {
    KINDS.forEach((entry, index) => {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, FIRST_PRIORITY - index);
      item.color = new vscode.ThemeColor(entry.color);
      this.items.set(entry.kind, item);
    });
    this.next = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, FIRST_PRIORITY - KINDS.length);
    this.next.text = 'Next ▸';
    this.next.tooltip = 'Go to the next session that needs you';
    this.next.command = JUMP_NEXT;
    this.subscriptions.push(
      source.onDidChange(() => this.refresh()),
      walk.onDidChange(() => this.refresh())
    );
  }

  /** Redraw the counts now; Next ▸ follows once the walk file has been read. */
  refresh(): void {
    if (this.disposed) {
      return;
    }
    const counts = this.source.counts();
    for (const entry of KINDS) {
      const item = this.items.get(entry.kind)!;
      const n = counts[entry.kind];
      if (n > 0) {
        item.text = entry.text(n);
        item.tooltip = entry.tooltip(n);
        item.command = { command: SHOW_STATUS_LIST, title: entry.title, arguments: [entry.kind] };
        item.show();
      } else {
        item.hide();
      }
    }
    void this.refreshNext(++this.generation, counts.needs);
  }

  dispose(): void {
    this.disposed = true;
    this.subscriptions.forEach((entry) => entry.dispose());
    this.items.forEach((item) => item.dispose());
    this.next.dispose();
  }

  private async refreshNext(generation: number, needs: number): Promise<void> {
    let show = false;
    if (needs > 0) {
      const order = this.source.order?.();
      show = order ? (await this.walk.peek(order)) !== undefined : await this.walk.active();
    }
    if (this.disposed || generation !== this.generation) {
      return;
    }
    if (show) {
      this.next.show();
    } else {
      this.next.hide();
    }
  }
}
