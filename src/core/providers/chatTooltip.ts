import * as vscode from 'vscode';
import { ChatSession } from '../types';
import { SessionMetadata } from '../harness/types';
import { lastExchange, sessionUsageLine } from '../harness/sessionUtils';
import { clampInlineText, formatRelativeTime } from '../utils/text';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The lines under a session tooltip's title (§3b): status and time, folder, and the ⧉ line. */
export interface ChatTooltipHeader {
  /** "needs you · 2m", as on the row. */
  status: string;
  /** The session's folder, shown for every session, main worktree too (D14). */
  folder: string;
  /** Set for a session in a worktree that is not the repo's main one. */
  worktree?: string;
}

/**
 * A session brief: the title, its status and folder (§3b), then what the
 * session is about, where the last turn ended, and the usage facts the row
 * does not show. Harness, open state and star are absent on purpose: the row
 * already carries them.
 */
export function chatTooltip(
  chat: ChatSession,
  harnessName: string,
  meta: SessionMetadata | null,
  header?: ChatTooltipHeader
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const paragraph = (text: string) => md.appendMarkdown(`${text}\n\n`);
  paragraph(`**${escape(chat.name)}**`);
  if (header) {
    paragraph(escape(header.status));
    paragraph(`Folder: ${escape(header.folder)}`);
    if (header.worktree) {
      paragraph(`Worktree: a separate folder, so it runs in its own window (${escape(header.worktree)})`);
    }
  }

  if (!chat.harnessSessionId) {
    paragraph('**No messages yet**');
    paragraph('The first prompt will create the native session.');
    paragraph(`Started ${formatRelativeTime(chat.createdAt)}.`);
    return md;
  }
  if (!meta) {
    paragraph('**Session unavailable**');
    paragraph('Pitwall could not read the native session. It may have been removed or moved.');
    return md;
  }

  const { lastAsk, lastReply } = lastExchange(meta);
  if (lastAsk || lastReply) {
    paragraph('**Last exchange**');
    if (lastAsk) {
      paragraph(`**You${when(lastAsk.timestamp)}**`);
      paragraph(`> ${escape(clampInlineText(lastAsk.text, 220))}`);
    }
    if (lastReply) {
      paragraph(`**${escape(harnessName)}${when(lastReply.timestamp)}**`);
      paragraph(escape(clampInlineText(lastReply.text, 220)));
    }
  } else if (!meta.model && !meta.agent) {
    paragraph('No recent messages.');
  }

  const footer = [sessionUsageLine(meta)];
  if (meta.lastActivity && Date.now() - meta.lastActivity > DAY_MS) {
    footer.push(`last active ${new Date(meta.lastActivity).toLocaleDateString()}`);
  }
  const line = footer.filter(Boolean).join(' · ');
  if (line) {
    paragraph(`---\n\n${line}`);
  }
  return md;
}

function when(timestamp: number | null | undefined): string {
  return timestamp ? ` · ${formatRelativeTime(timestamp)}` : '';
}

function escape(text: string): string {
  return text.replace(/([\\`*_{}\[\]<>#|~])/g, '\\$1');
}
