import * as vscode from 'vscode';
import { ChatSession } from '../types';
import { HarnessAdapter } from '../harness/types';
import { chatNativeSessionIds } from '../harness/sessionUtils';

/** What deciding "which chat is in front" reads from the rest of the extension. */
export interface ChatVisibilitySources {
  getChats(): ChatSession[];
  /** Adapters whose native-UI tabs may hold the active tab. */
  adapters(): readonly HarnessAdapter[];
  /** The chat an editor terminal tab belongs to, by the tab's title. */
  chatIdForTerminalName(name: string): string | undefined;
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
  const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (!activeTab) {
    return undefined;
  }
  if (activeTab.input instanceof vscode.TabInputTerminal) {
    return sources.chatIdForTerminalName(activeTab.label);
  }
  return activeNativeUiChatId(sources);
}

/** Whether this chat is the one in front of the user right now. */
export function isChatVisible(sources: ChatVisibilitySources, chatId: string): boolean {
  return chatIdInFront(sources) === chatId;
}

/** R40 red stub: replaced in the fix commit. */
export function onFrontMayChange(_listener: () => void): vscode.Disposable[] {
  return [];
}
