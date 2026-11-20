import * as vscode from 'vscode';
import { ChatSession } from '../types';
import { HarnessAdapter } from '../harness/types';
import { chatNativeSessionIds } from '../harness/sessionUtils';
import { samePath } from '../utils/paths';

/** What deciding "which chat is in front" reads from the rest of the extension. */
export interface ChatVisibilitySources {
  getChats(): ChatSession[];
  /** Adapters whose native-UI tabs may hold the active tab. */
  adapters(): readonly HarnessAdapter[];
  /** The chat an editor terminal tab belongs to, by the tab's title. */
  chatIdForTerminalName(name: string): string | undefined;
  /** Whether the chat's tab is in front only because Pitwall showed it (R43). */
  isPitwallActivation?(chatId: string): boolean;
}

/** The chat whose native-UI tab is the active editor tab, if any. */
export function activeNativeUiChatId(sources: ChatVisibilitySources): string | undefined {
  const activeSessions = new Map(
    sources.adapters().flatMap((adapter) => {
      const sessionId = adapter.nativeUi?.surfaces?.activeSessionId();
      return sessionId ? [[adapter.id, sessionId] as const] : [];
    })
  );
  if (activeSessions.size === 0) {
    return undefined;
  }
  return sources.getChats().find((chat) => {
    const sessionId = activeSessions.get(chat.harness);
    return sessionId !== undefined && chatNativeSessionIds(chat).includes(sessionId);
  })?.id;
}

/**
 * The chat in front of the user: the window has focus and the chat's tab is
 * the active tab of the active editor group, either its editor terminal tab
 * or its native-UI tab.
 *
 * `window.activeTerminal` is not used: it names the terminal that has or
 * most recently had focus, so it stays set after the user moves to another
 * tab. A terminal in the bottom panel therefore never counts as in front
 * (VS Code has no stable API for whether the panel is on screen); listing a
 * chat the user is looking at beats missing one they are not.
 */
export function chatIdInFront(sources: ChatVisibilitySources): string | undefined {
  if (!vscode.window.state.focused) {
    return undefined;
  }
  return chatIdOfActiveTab(sources);
}

/**
 * The native session in front of this window, whether or not the window has
 * focus: its chat's tab is the active tab of the active editor group. The
 * window registry publishes it as the record's `front`, beside `focused`
 * (Q33), so another window can tell that this chat is in front here.
 */
export function frontSessionId(sources: ChatVisibilitySources): string | undefined {
  const chatId = chatIdOfActiveTab(sources);
  return (chatId && sources.getChats().find((chat) => chat.id === chatId)?.harnessSessionId) || undefined;
}

/** The chat whose terminal or native-UI tab is the active tab of the active group, focus aside. */
function chatIdOfActiveTab(sources: ChatVisibilitySources): string | undefined {
  const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (!activeTab) {
    return undefined;
  }
  if (activeTab.input instanceof vscode.TabInputTerminal) {
    const chatId = sources.chatIdForTerminalName(activeTab.label);
    // A tab Pitwall showed to rename it is in front, but the user did not
    // bring it there (R43).
    return chatId && sources.isPitwallActivation?.(chatId) ? undefined : chatId;
  }
  return activeNativeUiChatId(sources);
}

/**
 * How long after it opened an unbound tab can still stand for a new chat. A
 * new chat's tab binds once its title names the chat, seconds into the first
 * turn; a tab left unbound longer holds no new chat, so it silences nothing.
 */
export const UNBOUND_FRONT_MAX_MS = 10 * 60_000;

/** What the unbound-tab front check reads (PR #73). */
export interface UnboundFrontDeps {
  adapters(): readonly HarnessAdapter[];
  /** Every listed chat: the tab stands for one only when exactly one fits. */
  chats(): readonly ChatSession[];
  worktreePathOf(chat: ChatSession): string | undefined;
  folders(): readonly string[];
  /** A terminal or tab of the chat is open in this window, or a tab in another (the registry's openSessionIds). */
  isOpenAnywhere(chat: ChatSession): boolean;
  now?(): number;
}

/**
 * Whether this window's active tab may be this chat's own, not bound yet
 * (PR #73). A brand-new chat's tab binds only once its title names the chat,
 * so a user watching its first turn would otherwise get a pop-up.
 *
 * The active tab must be a native-UI tab of the chat's harness that no
 * session is bound to and that opened in this window under
 * UNBOUND_FRONT_MAX_MS ago (a restored tab has no open time, so it counts
 * for nothing). It stands for a chat only when exactly one listed chat fits:
 * one of this window's folders, with no open surface anywhere (a chat in a
 * terminal or with its own tab is never in a tab it does not have), whose
 * session started at or after the tab opened. So it can never silence an
 * older chat, or either of two new ones. Focus is the caller's check.
 */
export function unboundTabMayBeChat(chat: ChatSession, deps: UnboundFrontDeps): boolean {
  const surfaces = deps.adapters().find((adapter) => adapter.id === chat.harness)?.nativeUi?.surfaces;
  const openedAt = surfaces?.activeUnboundTabOpenedAt?.();
  if (openedAt === undefined || (deps.now?.() ?? Date.now()) - openedAt > UNBOUND_FRONT_MAX_MS) {
    return false;
  }
  const folders = deps.folders();
  const fits = (candidate: ChatSession): boolean => {
    const worktreePath = deps.worktreePathOf(candidate);
    return (
      candidate.harness === chat.harness &&
      Boolean(candidate.harnessSessionId) &&
      sessionStartedAt(candidate) >= openedAt &&
      Boolean(worktreePath && folders.some((folder) => samePath(folder, worktreePath))) &&
      !deps.isOpenAnywhere(candidate)
    );
  };
  if (!fits(chat)) {
    return false;
  }
  const candidates = deps.chats().filter(fits);
  return candidates.length === 1 && candidates[0].id === chat.id;
}

/**
 * The latest the chat's session can have started: the earlier of when its
 * row was made and its last known activity, neither of which can be before
 * the session began. A chat with neither counts as started before any tab,
 * so it never fits.
 */
function sessionStartedAt(chat: ChatSession): number {
  const stamps = [chat.createdAt, chat.lastAccessedAt].filter((stamp) => Number.isFinite(stamp));
  return stamps.length > 0 ? Math.min(...stamps) : Number.NEGATIVE_INFINITY;
}

/** Whether this chat is the one in front of the user right now. */
export function isChatVisible(sources: ChatVisibilitySources, chatId: string): boolean {
  return chatIdInFront(sources) === chatId;
}

/**
 * Calls `listener` whenever the chat in front may have changed: the active
 * terminal, a tab, a tab group or window focus. The attention service uses
 * this only to record what the user has looked at; it never polls from here.
 */
export function onFrontMayChange(listener: () => void): vscode.Disposable[] {
  return [
    vscode.window.onDidChangeActiveTerminal(() => listener()),
    vscode.window.tabGroups.onDidChangeTabs(() => listener()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => listener()),
    vscode.window.onDidChangeWindowState(() => listener()),
  ];
}
