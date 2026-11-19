# 0022 — Windows pop-ups under Pitwall's own sender, clicked through a link

- **Status:** Proposed
- **Date:** 2026-11-19

## Context

Phase 5 (rows 5.2, 5.3) asks for an OS pop-up on Windows when a chat needs you or finishes,
sent by "Pitwall", that lands on the right window and chat when clicked. VS Code has no
OS-notification API: `showInformationMessage` renders inside the window only. Windows shows a
toast under an AppUserModelID (AUMID), and names the sender only if it knows that ID. A toast
click can launch a URI, and the editor routes `<uriScheme>://<publisher.name>/...` to the
extension's `UriHandler` in a running window.

The text of a pop-up (repo name, chat title, wait reason) comes from the user's repos and the
agent's transcript. Whatever carries it to Windows must not let it run as code, and must not
show it to other processes.

## Decision

- **Sender: a per-user AUMID key (Q46 = A).** After the first render, once per activation and
  idempotently, Pitwall writes `HKCU\Software\Classes\AppUserModelId\sharifamlani.pitwall` with
  `DisplayName` = `Pitwall` and `IconUri` = the packaged `resources/icons/pitwall.png` (rewritten
  when the extension path changes). No admin. **Pitwall: Remove Pop-up Registration** deletes it,
  and so does the manifest's `vscode:uninstall` script (`out/uninstall.js`). Smoke S3
  (`scripts/toast-probe.ps1 -Register`) checks that the sender reads "Pitwall" and that toasts
  stay in Action Center under it.
- **Host: one hidden PowerShell per pop-up.** `powershell.exe -NoProfile -NonInteractive
  -Command -` with `windowsHide`, killed after 10 s, at most one in flight per window (the rest
  queue). No `-ExecutionPolicy Bypass` and no `-WindowStyle Hidden`, two common EDR heuristics.
  Stdin is a byte-constant script whose only variable part is one single-quoted base64 literal of
  UTF-8 JSON `{aumid, xml, tag}`; the script decodes it and hands the XML to WinRT as data. The
  XML escapes every text node. A sender Windows has switched off (`ToastNotifier.Setting`) fails
  the host with that setting's name.
- **One pop-up per chat and kind.** The toast tag is `<id8>-<kind>`, so a newer pop-up for the
  same chat and kind replaces the older one in Action Center.
- **Fallback.** A failed host (timeout, error, switched off, registration removed) shows the
  in-window message instead, once (Q35). A session ID that is not a UUID (the link carries UUIDs
  only) keeps the in-window message too. macOS and Linux keep the in-window message.
- **Click: a link, through the router (Q37).** The body and **Open chat** launch
  `<vscode.env.uriScheme>://sharifamlani.pitwall/open?session=<uuid>`. `PopupUriHandler` accepts
  only path `/open`, exactly one `session` that is a UUID Pitwall lists, and no other query key
  (an allow-list, empty until S4 shows a key the editor adds). It routes through
  `ChatRouter.route({kind: 'open'})`: never a new chat, never a prompt. A chat live in a terminal
  Pitwall doesn't own returns the router's own `'outside'` result: the Q28 warning, nothing opens,
  and the chat is marked seen (Q48).

## Alternatives

- **A Start-menu shortcut carrying the AUMID (Q46 B):** the classic route, but a visible Start
  entry. Fallback if S3 shows the registry key doesn't take.
- **Cursor's AUMID (C):** nothing to install, but the sender reads "Cursor" and the per-app
  switch is Cursor's.
- **node-notifier / SnoreToast (D):** a bundled LGPL binary that antivirus flags, and its own
  shortcut.
- **PowerShell's AUMID (E):** the sender reads "Windows PowerShell".
- **A long-lived host per window** fed JSON lines: faster per pop-up, but one more resident
  process per window. Kept as S8's fallback if spawn time exceeds 1.5 s at p95.
- **Pop-up text in argv or interpolated into the script:** visible to every process, and one
  quote away from running as code.

## Consequences

- The key is per Windows user, not per editor profile: uninstalling Pitwall from one profile
  removes the key another profile uses until that profile's next start writes it again, and
  pop-ups from every profile share one "Pitwall" entry in Action Center.
- Windows keeps pop-up text in its Notification history until it is cleared
  (`docs/privacy.md`).
- The first click from a pop-up may show the editor's own "Allow … to open this URI?" prompt;
  its "Do not ask me again" writes `extensions.confirmedUriHandlerExtensionIds` to user
  settings, on the user's click.
- Any local app or web page can fire the link. It can only open a chat Pitwall already lists,
  the same way a row click does; everything else is logged as `[Pitwall] uri rejected <reason>`.
- Each pop-up costs one PowerShell start (about 0.5 s on the dev machine), off the attention
  tick: `notify` returns once the lock is won and delivery finishes in the background.
