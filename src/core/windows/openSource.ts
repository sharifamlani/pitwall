/**
 * What asked for an open (0.6.0 gate: three routes nobody could explain).
 * Every `[Pitwall] route …` and `[Pitwall] open …` line ends with
 * ` via=<trigger>`, so the Operations log tells a user's click from a hotkey,
 * a pop-up or a claimed handoff. A row click adds whether its row was newly
 * selected just before (a pointer click selects, then runs the command;
 * Enter on a selected row runs it alone), and #80's redirect adds the rows.
 */
export type OpenTrigger =
  /** A chat row's click or Enter (its argument-free row command). */
  | 'row-click'
  /** A repo row's click or Enter: its main-folder chats. */
  | 'repo-click'
  /** Ctrl+↓/↑: the list moved and selected the next row, which ran its command. */
  | 'keyboard-move'
  /** The bell on a needs-you row. */
  | 'bell'
  /** Ctrl+Alt+1–9 pressed again on the repo it shows: its next chat. */
  | 'hotkey'
  /** A pick in the search box. */
  | 'search'
  /** A pick in Find Session. */
  | 'find-session'
  /** A pick in a repo's session history. */
  | 'history'
  /** A pick in the starred sessions. */
  | 'starred'
  /** Ctrl+Alt+0, Next ▸ or a bottom-bar count. */
  | 'jump'
  /** A Windows pop-up's click (the open link). */
  | 'popup-click'
  /** The in-window message's Open button. */
  | 'notification'
  /** Open in <agent> UI. */
  | 'explicit-ui'
  /** Open in Terminal. */
  | 'explicit-terminal'
  /** A request another window handed to this one. */
  | 'claimed'
  /** A repo row's "+": a new chat. */
  | 'new-session'
  /** Show its open chats side by side. */
  | 'side-by-side'
  /** A row's context menu. */
  | 'menu'
  /** The command palette (no row). */
  | 'palette';

/** An open's trigger, and for a row click what the selection did just before. */
export interface OpenSource {
  via: OpenTrigger;
  /** Extra `key=value` words for the line, such as `selected=new+12ms` or `redirect=<from>→<to>`. */
  detail?: string;
}

/** The ` via=…` tail of a route or open line. */
export function viaTail(source: OpenSource): string {
  return ` via=${source.via}${source.detail ? ` ${source.detail}` : ''}`;
}

/**
 * The source a command was given as its last argument, else `fallback`.
 * Commands run from a menu or the palette get no source argument.
 */
export function sourceArg(value: unknown, fallback: OpenSource): OpenSource {
  if (value && typeof value === 'object' && typeof (value as OpenSource).via === 'string') {
    return value as OpenSource;
  }
  return fallback;
}
