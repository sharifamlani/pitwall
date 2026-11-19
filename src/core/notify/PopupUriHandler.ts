import * as vscode from 'vscode';
import { ChatSession } from '../types';
import type { RouteResult } from '../windows/ChatRouter';

/** The extension ID the editor routes `<scheme>://sharifamlani.pitwall/...` links to. */
export const URI_AUTHORITY = 'sharifamlani.pitwall';
/** The one path a pop-up click uses. */
export const OPEN_PATH = '/open';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a session ID can ride a pop-up's open link (Q37: UUIDs only). */
export function isOpenableSessionId(sessionId: string): boolean {
  return UUID.test(sessionId);
}

/** A pop-up's click target: `<vscode.env.uriScheme>://sharifamlani.pitwall/open?session=<uuid>` (Q37). */
export function openUri(sessionId: string): string {
  return `${vscode.env.uriScheme}://${URI_AUTHORITY}${OPEN_PATH}?session=${sessionId}`;
}

/**
 * Read a pop-up link. Accepted: path `/open`, exactly one `session` that is a
 * UUID, and no other query key unless `allowKeys` names it (keys Cursor adds,
 * found by S4; QA N4). Everything else is an error naming why, for the log.
 */
export function parseOpenUri(uri: vscode.Uri, allowKeys: ReadonlySet<string> = new Set()): { sessionId: string } | { error: string } {
  if (uri.authority.toLowerCase() !== URI_AUTHORITY) {
    return { error: 'authority' };
  }
  if (uri.path !== OPEN_PATH) {
    return { error: 'path' };
  }
  const params = new URLSearchParams(uri.query);
  for (const key of params.keys()) {
    if (key !== 'session' && !allowKeys.has(key)) {
      return { error: 'param' };
    }
  }
  const sessions = params.getAll('session');
  if (sessions.length !== 1) {
    return { error: 'session' };
  }
  if (!UUID.test(sessions[0])) {
    return { error: 'not-uuid' };
  }
  return { sessionId: sessions[0] };
}

/** At most this many keys, each at most 32 characters, go into the probe line. */
const MAX_PROBE_KEYS = 10;
const MAX_KEY_LENGTH = 32;

/** The query keys, never values, made safe for one log line. */
function probeKeys(uri: vscode.Uri): string {
  const keys = [...new URLSearchParams(uri.query).keys()];
  return keys
    .slice(0, MAX_PROBE_KEYS)
    .map((key) => key.slice(0, MAX_KEY_LENGTH).replace(/[^A-Za-z0-9_.-]/g, '?'))
    .join(',');
}

export interface PopupUriDeps {
  /** The listed chat holding this native session, if Pitwall lists one (Q31, Q37). */
  chatForSession: (sessionId: string) => ChatSession | undefined;
  /** Phase 4's router. */
  route: (request: { kind: 'open'; chats: ChatSession[] }) => Promise<RouteResult>;
  /** Mark the chat seen and select its row here (D18). */
  activateLocal: (chat: ChatSession) => void;
  /** The Operations log. Lines carry an id8 or a reason, never a title, a path or a query value. */
  log: (line: string) => void;
  /** Query keys accepted beside `session` (empty until S4 names one Cursor adds). */
  allowKeys?: ReadonlySet<string>;
  /**
   * Bring this window forward after a click it handled (v0.6.0). A routed
   * click is raised by the handoff in the window it lands in.
   */
  raiseWindow?: () => unknown;
}

/**
 * A pop-up click (Q37, Q48). Any local app or web page can fire this link, so
 * it only ever opens a chat Pitwall lists, through the same router as every
 * other open (D35): never a new chat, never a prompt. A chat opened here, or
 * held back (gone, or live in a terminal Pitwall doesn't own), is marked seen
 * here, so a finished row turns idle (D18), and this window is raised so the
 * chat or the warning is in front; a routed one is marked and raised by the
 * window it lands in.
 */
export class PopupUriHandler implements vscode.UriHandler {
  constructor(private readonly deps: PopupUriDeps) {}

  async handleUri(uri: vscode.Uri): Promise<void> {
    this.deps.log(`[Pitwall] uri probe keys=${probeKeys(uri)}`);
    const parsed = parseOpenUri(uri, this.deps.allowKeys);
    if ('error' in parsed) {
      this.deps.log(`[Pitwall] uri rejected ${parsed.error}`);
      return;
    }
    const chat = this.deps.chatForSession(parsed.sessionId);
    if (!chat) {
      this.deps.log('[Pitwall] uri rejected unknown');
      return;
    }
    const id8 = parsed.sessionId.slice(0, 8);
    const where = await this.deps.route({ kind: 'open', chats: [chat] });
    this.deps.log(where === 'outside' ? `[Pitwall] popup click ${id8} outside` : `[Pitwall] popup click ${id8}`);
    if (where !== 'routed') {
      this.deps.activateLocal(chat);
      try {
        await this.deps.raiseWindow?.();
      } catch {
        // The chat is open (or the warning shown) either way.
      }
    }
  }
}
