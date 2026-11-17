import * as vscode from 'vscode';
import { ChatSession } from '../types';
import { HarnessAdapter } from '../harness/types';
import { chatNativeSessionIds } from '../harness/sessionUtils';

/** What deciding "which chat is in front" reads from the rest of the extension. */
export interface ChatVisibilitySources {
  getChats(): ChatSession[];
  /** Adapters whose native-UI tabs may hold the active tab. */
  adapters(): readonly HarnessAdapter[];
  getTerminal(chatId: string): vscode.Terminal | undefined;
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

/** Whether the chat's terminal or native-UI tab is the one in front of the user. */
export function isChatVisible(sources: ChatVisibilitySources, chatId: string): boolean {
  const terminal = sources.getTerminal(chatId);
  return (terminal !== undefined && terminal === vscode.window.activeTerminal) || activeNativeUiChatId(sources) === chatId;
}
