const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const manifest = require(path.join(repoRoot, 'package.json'));
const extensionId = `${manifest.publisher}.${manifest.name}`;
// The harnesses this build ships (src/harnesses/enabled.json); per-harness
// checks run only for these, and every other harness must contribute nothing.
const enabledHarnesses = require(path.join(repoRoot, 'src', 'harnesses', 'enabled.json'));
const ALL_HARNESSES = ['claude', 'opencode', 'codex', 'pi'];
const legacyHarness = enabledHarnesses[enabledHarnesses.length - 1];

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

exports.run = async function run() {
  console.log('== activation ==');
  const extension = vscode.extensions.getExtension(extensionId);
  assert(extension, `Pitwall extension (${extensionId}) is discoverable`);

  await extension.activate();
  check(extension.isActive, 'extension activates without throwing');

  console.log('\n== commands ==');
  const commands = await vscode.commands.getCommands(true);
  // Every contributed command needs a handler, or its menu entry fails when clicked.
  const unregistered = manifest.contributes.commands
    .map((entry) => entry.command)
    .filter((command) => !commands.includes(command));
  check(
    unregistered.length === 0,
    `all ${manifest.contributes.commands.length} contributed commands are registered${unregistered.length ? `; missing: ${unregistered.join(', ')}` : ''}`
  );

  console.log('\n== configuration ==');
  const config = vscode.workspace.getConfiguration('pitwall');
  check(
    JSON.stringify(config.get('harnessCommands')) ===
      JSON.stringify(
        Object.fromEntries(
          enabledHarnesses.map((id) => [id, id === legacyHarness ? `${id}-legacy` : id])
        )
      ),
    `harnessCommands has a default per enabled harness (${enabledHarnesses.join(', ')}), and an object saved by an earlier version still overrides one`
  );
  check(
    config.get('notifications.enabled') === true &&
      config.get('notifications.onTurnEnd') === true &&
      config.get('notifications.onNeedsInput') === true &&
      config.get('notifications.nativeBanner') === true,
    'notification settings default to on'
  );
  check(
    config.get('defaultSessionSurface') === 'terminal',
    'sessions default to the terminal surface'
  );
  check(
    config.get('defaultHarness') === '',
    'New Session asks which agent until a default agent is set'
  );
  check(
    config.get('sessionSearch.harness') === 'claude' &&
      config.get('sessionSearch.model') === '' &&
      config.get('sessionSearch.effort') === '',
    "Find Session defaults to Claude Code with the harness's configured model and effort"
  );
  check(
    config.get('autoImport.enabled') === true &&
      config.get('autoImport.retentionDays') === 15,
    'auto-import defaults to on with a fifteen-day retention'
  );

  console.log('\n== manifest ==');
  const contributes = manifest.contributes || {};
  const menus = contributes.menus || {};
  const contextMenus = menus['view/item/context'] || [];
  const submenuIds = new Set(
    (contributes.submenus || []).map((submenu) => submenu.id)
  );
  check(
    contextMenus.some((item) => item.submenu === 'pitwall.newSession'),
    'worktree context menu opens the new-session submenu'
  );
  const newSessionChildren = [
    ...(menus['pitwall.newSession'] || []),
    ...(menus['pitwall.newSessionContext'] || []),
  ];
  check(submenuIds.has('pitwall.newSession'), 'pitwall.newSession submenu is contributed');
  check(
    submenuIds.has('pitwall.newSessionContext'),
    'pitwall.newSessionContext submenu is contributed'
  );
  // Per-harness entries, checked for each enabled harness only.
  const harnessChecks = {
    claude: () => {
      check(
        newSessionChildren.some(
          (item) =>
            item.command === 'pitwall.newClaudeChat' &&
            item.when.includes('pitwall.claudeInstalled') &&
            item.when.includes('config.pitwall.defaultSessionSurface')
        ),
        'Claude new-session entry follows the configured surface'
      );
      check(
        newSessionChildren.some((item) => item.command === 'pitwall.newClaudeChatInUi'),
        'Claude exposes an explicit UI new-session entry'
      );
      check(
        contextMenus.some(
          (item) =>
            item.command === 'pitwall.openClaudeUi' &&
            item.when.includes('ClaudeUi') &&
            !item.when.includes('claudeUiInstalled') &&
            !String(item.group).startsWith('inline')
        ),
        'Claude UI entry stays visible on Claude rows without the extension'
      );
      check(
        contextMenus.some(
          (item) =>
            item.command === 'pitwall.openClaudeUi' &&
            item.when.includes('pitwall.claudeUiInstalled') &&
            String(item.group).startsWith('inline')
        ),
        'Claude UI hover action appears only when installed'
      );
    },
    opencode: () => {
      check(
        newSessionChildren.some(
          (item) => item.command === 'pitwall.newOpencodeChat' && item.when.includes('pitwall.opencodeInstalled')
        ),
        'opencode new-session entry is gated on the installed context key'
      );
    },
    codex: () => {
      check(
        newSessionChildren.some(
          (item) =>
            item.command === 'pitwall.newCodexChat' &&
            item.when.includes('pitwall.codexInstalled') &&
            item.when.includes('config.pitwall.defaultSessionSurface')
        ),
        'Codex new-session entry follows the configured surface'
      );
      check(
        newSessionChildren.some((item) => item.command === 'pitwall.newCodexChatInUi'),
        'Codex exposes an explicit UI new-session entry'
      );
      check(
        contextMenus.some(
          (item) =>
            item.command === 'pitwall.openCodexUi' &&
            item.when.includes('CodexUi') &&
            !item.when.includes('codexUiInstalled') &&
            !String(item.group).startsWith('inline')
        ),
        'Codex UI entry stays visible on Codex rows without the extension'
      );
      check(
        contextMenus.some(
          (item) =>
            item.command === 'pitwall.openCodexUi' &&
            item.when.includes('pitwall.codexUiInstalled') &&
            String(item.group).startsWith('inline')
        ),
        'Codex UI hover action appears only when installed'
      );
    },
    pi: () => {
      check(
        newSessionChildren.some(
          (item) => item.command === 'pitwall.newPiChat' && item.when.includes('pitwall.piInstalled')
        ),
        'Pi new-session entry is gated on the installed context key'
      );
    },
  };
  for (const id of enabledHarnesses) {
    harnessChecks[id]();
  }

  // A disabled harness contributes no command and no setting.
  const disabled = ALL_HARNESSES.filter((id) => !enabledHarnesses.includes(id));
  const words = (value) =>
    String(value)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map((word) => word.toLowerCase());
  const settingKeys = (contributes.configuration || []).flatMap((section) => Object.keys(section.properties || {}));
  const leaked = [...manifest.contributes.commands.map((entry) => entry.command), ...settingKeys].filter((id) =>
    words(id).some((word) => disabled.includes(word))
  );
  check(
    leaked.length === 0,
    `disabled harnesses (${disabled.join(', ') || 'none'}) contribute no command or setting${leaked.length ? `; found: ${leaked.join(', ')}` : ''}`
  );
  const registeredForDisabled = commands.filter(
    (command) => command.startsWith('pitwall.') && words(command).some((word) => disabled.includes(word))
  );
  check(
    registeredForDisabled.length === 0,
    `no command is registered for a disabled harness${registeredForDisabled.length ? `; found: ${registeredForDisabled.join(', ')}` : ''}`
  );

  const viewTitleMenus = menus['view/title'] || [];
  check(
    !commands.some((command) => command.includes('AttentionHooks')),
    'no attention-hook commands are registered'
  );
  check(
    !viewTitleMenus.some(
      (item) =>
        String(item.command).includes('AttentionHooks') ||
        String(item.when).includes('attentionHooks')
    ),
    'no attention-hook toggles remain in the view menu'
  );

  console.log('\n== wiring smoke tests ==');
  await vscode.commands.executeCommand('pitwall.refreshWorkspaces');
  check(true, 'refreshWorkspaces executes');

  console.log(
    `\n${failures === 0 ? 'ALL ACTIVATION CHECKS PASSED' : `${failures} ACTIVATION FAILURE(S)`}`
  );
  if (failures > 0) {
    throw new Error(`${failures} activation check(s) failed`);
  }
};
