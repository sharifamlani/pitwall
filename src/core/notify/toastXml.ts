/**
 * The Windows pop-up's XML (row 5.2, §3a). Pure and vscode-free, so the
 * uninstall script and tests can load it.
 */

/** One pop-up, as the host shows it. */
export interface ToastPayload {
  /** The sender's AppUserModelID (`sharifamlani.pitwall`, Q46). */
  aumid: string;
  title: string;
  body: string;
  /** The small grey line under the body: the raw wait reason (needs you only). */
  attribution?: string;
  /** Play Windows' "Notification.Default" (Q41); otherwise silent. */
  sound: boolean;
  /** What a click on the body or Open chat launches (Q37). */
  openUri: string;
  /** `<id8>-<kind>`: a newer pop-up for the same chat and kind replaces the older one. */
  tag: string;
}

/** The pop-up copy (Q36, canvas §3a). */
export interface PopupCopy {
  title: string;
  body: string;
  attribution?: string;
}

/**
 * Title, body and attribution for a needs-you or finished pop-up:
 * `{repo} needs you` / `{repo}: finished`, `{chat}: Claude is waiting for you.`
 * / `{chat}: Your turn.`, and the raw wait reason under a needs-you one.
 */
export function popupCopy(kind: 'needs' | 'finished', names: { repo: string; chat: string; waitingFor?: string }): PopupCopy {
  if (kind === 'finished') {
    return { title: `${names.repo}: finished`, body: `${names.chat}: Your turn.` };
  }
  const reason = names.waitingFor?.trim();
  return {
    title: `${names.repo} needs you`,
    body: `${names.chat}: Claude is waiting for you.`,
    ...(reason ? { attribution: reason } : {}),
  };
}

/** Characters XML 1.0 forbids (every C0 control but tab, newline and carriage return). */
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

/** Escape text for an XML text node or a double-quoted attribute. */
export function escapeXml(text: string): string {
  return text
    .replace(FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The toast XML. Every text node and attribute value is escaped. A click on
 * the body (`launch`) and on Open chat both launch `openUri` by protocol;
 * Dismiss is Windows' own dismiss. `<audio>` follows `sound`.
 */
export function toastXml(p: ToastPayload): string {
  const uri = escapeXml(p.openUri);
  const attribution = p.attribution ? `<text placement="attribution">${escapeXml(p.attribution)}</text>` : '';
  const audio = p.sound ? '<audio src="ms-winsoundevent:Notification.Default"/>' : '<audio silent="true"/>';
  return (
    `<toast launch="${uri}" activationType="protocol">` +
    '<visual><binding template="ToastGeneric">' +
    `<text>${escapeXml(p.title)}</text>` +
    `<text>${escapeXml(p.body)}</text>` +
    attribution +
    '</binding></visual>' +
    '<actions>' +
    `<action content="Open chat" activationType="protocol" arguments="${uri}"/>` +
    '<action content="Dismiss" activationType="system" arguments="dismiss"/>' +
    '</actions>' +
    audio +
    '</toast>'
  );
}
