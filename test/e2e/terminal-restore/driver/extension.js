const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const OUT = process.env.PITWALL_E2E_OUT;
const STATE = process.env.PITWALL_E2E_STATE;
const RUNS = process.env.PITWALL_E2E_RUNS;
const CHATS = JSON.parse(process.env.PITWALL_E2E_CHATS);
const EXPECT_RESUMES = Number(process.env.PITWALL_E2E_EXPECT_RESUMES || 3);
const EXPECT_TITLES = process.env.PITWALL_E2E_EXPECT_TITLES !== '0';
const EXTENSION_ID = process.env.PITWALL_E2E_EXTENSION_ID;
/**
 * What is in front when the window quits (R47): `chat` (the first chat's
 * tab), `file` (README.md in front of the chat tabs' group, focus in it) or
 * `terminal` (a plain terminal in the panel, focus in it, the first chat's tab
 * in front of its group).
 */
const FRONT = process.env.PITWALL_E2E_FRONT || 'chat';
const USER_SHELL = 'e2e-user-shell';
/** Terminals that are not chats: the user's plain shell, opened for the first quit in the `terminal` case. */
const otherTerminals = () => (FRONT === 'terminal' && stage !== 0 ? 1 : 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let stage = 0;

function log(entry) {
  fs.appendFileSync(OUT, JSON.stringify({ at: Date.now(), stage, ...entry }) + '\n');
}

function check(name, ok, detail) {
  log({ kind: 'check', name, ok: Boolean(ok), detail });
}

function observe(name, detail) {
  log({ kind: 'observation', name, detail });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return { stage: 0 };
  }
}

function writeState(next) {
  fs.writeFileSync(STATE, JSON.stringify(next));
}

function readRuns() {
  try {
    return fs
      .readFileSync(RUNS, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { args: line.split(' '), raw: line };
        }
      });
  } catch {
    return [];
  }
}

function runText(run) {
  return Array.isArray(run.args) ? run.args.join(' ') : String(run.raw ?? '');
}

function parseShortId(name) {
  const match = name.match(/\[([a-f0-9]{6})\]$/);
  return match ? match[1] : undefined;
}

function expectedName(chat) {
  return `Pitwall: ${chat.name} [${chat.id.substring(0, 6)}]`;
}

async function pidOf(terminal) {
  try {
    return await Promise.race([
      Promise.resolve(terminal.processId),
      sleep(500).then(() => undefined),
    ]);
  } catch {
    return undefined;
  }
}

async function readTerminals() {
  const terminals = [];
  for (const terminal of vscode.window.terminals) {
    terminals.push({
      name: terminal.name,
      pid: await pidOf(terminal),
      exit: terminal.exitStatus ? terminal.exitStatus.code : null,
      active: terminal === vscode.window.activeTerminal,
    });
  }
  return terminals;
}

async function snapshot() {
  const terminals = await readTerminals();
  observe(
    'terminals',
    JSON.stringify({
      active: vscode.window.activeTerminal?.name,
      terminals,
    })
  );
  return terminals;
}

async function waitFor(condition, what, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await condition()) {
      return true;
    }
    await sleep(250);
  }
  log({ kind: 'observation', name: 'timeout', detail: what });
  return false;
}

function waitForCommand(id) {
  return waitFor(
    async () => (await vscode.commands.getCommands(true)).includes(id),
    `${id} to be registered`
  );
}

/** The terminals that carry a chat's short ID. */
function chatTabs(terminals) {
  return terminals.filter((terminal) => parseShortId(terminal.name));
}

async function isRestored(terminals, expectedRuns, activeName) {
  const chats = chatTabs(terminals);
  if (chats.length !== 3 || terminals.length !== 3 + otherTerminals()) {
    return false;
  }
  const chatsByShortId = new Map(
    CHATS.map((chat) => [chat.id.substring(0, 6), chat])
  );
  const everyTab = chats.every((terminal) => {
    const shortId = parseShortId(terminal.name);
    const chat = shortId ? chatsByShortId.get(shortId) : undefined;
    return (
      Boolean(chat) &&
      terminal.name === expectedName(chat) &&
      typeof terminal.pid === 'number' &&
      terminal.exit === null
    );
  });
  return (
    everyTab &&
    readRuns().length >= expectedRuns &&
    (activeName === undefined || vscode.window.activeTerminal?.name === activeName)
  );
}

/** The label of the tab in front of the active editor group. */
function activeTabLabel() {
  const group = vscode.window.tabGroups.activeTabGroup;
  return group && group.activeTab ? group.activeTab.label : undefined;
}

/**
 * R44: which tab is in front, from the driver's activation on. Every change
 * of the active terminal and of the active editor tab is logged as an
 * observation, and `check` asserts that the tab in front at quit is in front
 * again, both as the active editor tab and as the active terminal.
 */
function watchFront(t0) {
  const since = () => Date.now() - t0;
  const events = [`at activation: tab ${JSON.stringify(activeTabLabel())}, terminal ${JSON.stringify(vscode.window.activeTerminal?.name)}`];
  let lastTab = activeTabLabel();
  const subscriptions = [
    vscode.window.onDidChangeActiveTerminal((terminal) =>
      events.push(`${since()} ms: active terminal ${JSON.stringify(terminal?.name)}`)
    ),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      const label = activeTabLabel();
      if (label !== lastTab) {
        lastTab = label;
        events.push(`${since()} ms: active tab ${JSON.stringify(label)}`);
      }
    }),
  ];
  return {
    /**
     * `front` is what was in front: `tab`, the active group's front tab;
     * `terminal`, the active terminal's name, or `other` for the user's plain
     * shell (whose name the editor may not keep); `file`, the active text
     * editor's path. A field left out is not asserted.
     */
    check(stageIndex, front, moment = 'quit', after = 'the restore') {
      subscriptions.forEach((subscription) => subscription.dispose());
      for (const event of events) observe('front', event);
      const tab = activeTabLabel();
      const active = vscode.window.activeTerminal;
      const terminal = active?.name;
      const file = vscode.window.activeTextEditor?.document.uri.fsPath;
      const terminalOk =
        front.terminal === undefined ||
        (front.terminal === 'other' ? Boolean(active) && !parseShortId(active.name) : terminal === front.terminal);
      const fileOk = front.file === undefined || (file !== undefined && path.resolve(file) === path.resolve(front.file));
      check(
        `stage ${stageIndex}: the tab in front at ${moment} is in front 3 s after ${after} (R44, R47 front=${FRONT})`,
        tab === front.tab && terminalOk && fileOk,
        `tab ${JSON.stringify(tab)}, terminal ${JSON.stringify(terminal)}, file ${JSON.stringify(file)}, expected ${JSON.stringify(front)}`
      );
    },
  };
}

async function openChat(chat) {
  const item = {
    itemType: 'chat',
    label: chat.name,
    collapsibleState: 0,
    data: chat,
  };
  await vscode.commands.executeCommand('pitwall.openChat', item);
}

function shortIdsIn(runs) {
  const found = [];
  for (const run of runs) {
    const text = runText(run);
    for (const chat of CHATS) {
      if (text.includes(chat.pendingHarnessSessionId)) {
        found.push(chat.pendingHarnessSessionId);
      }
    }
  }
  return found;
}

function checkRestored(stageIndex, terminals, state) {
  check(
    `stage ${stageIndex}: three chat tabs are open` + (otherTerminals() ? `, plus ${otherTerminals()} other` : ''),
    chatTabs(terminals).length === 3 && terminals.length === 3 + otherTerminals(),
    JSON.stringify(terminals.map((terminal) => terminal.name))
  );

  const chatsByShortId = new Map(
    CHATS.map((chat) => [chat.id.substring(0, 6), chat])
  );
  // The user's plain shell is the one terminal left out, when there is one
  // and every chat tab kept its title.
  const checked =
    otherTerminals() && chatTabs(terminals).length === 3
      ? chatTabs(terminals)
      : terminals.filter((terminal) => terminal.name !== USER_SHELL);
  for (const terminal of checked) {
    const shortId = parseShortId(terminal.name);
    const chat = shortId ? chatsByShortId.get(shortId) : undefined;
    check(
      `stage ${stageIndex}: tab ${shortId ?? '?'} carries its Pitwall title`,
      Boolean(chat) && terminal.name === expectedName(chat),
      terminal.name
    );
    check(
      `stage ${stageIndex}: tab ${shortId ?? '?'} has a running pty`,
      typeof terminal.pid === 'number' && terminal.exit === null,
      String(terminal.pid)
    );
  }

  if (state.activeName !== undefined) {
    check(
      `stage ${stageIndex}: the expected tab is active`,
      vscode.window.activeTerminal?.name === state.activeName,
      vscode.window.activeTerminal?.name
    );
  }

  const runs = readRuns();
  const expectedTotal = 3 + stageIndex * EXPECT_RESUMES;
  check(
    `stage ${stageIndex}: ${expectedTotal} harness launches in total`,
    runs.length === expectedTotal,
    String(runs.length)
  );

  // Stage 0 is the initial launch of every chat; later stages are resumes.
  const expectedCount = stageIndex === 0 ? 3 : EXPECT_RESUMES;
  const start = stageIndex === 0 ? 0 : 3 + (stageIndex - 1) * EXPECT_RESUMES;
  const action = stageIndex === 0 ? 'launched' : 'resumed';
  const attempted = runs.slice(start, start + expectedCount);
  const attemptedIds = shortIdsIn(attempted).sort();
  const expectedIds = CHATS.map((chat) => chat.pendingHarnessSessionId).sort();
  check(
    `stage ${stageIndex}: every tab ${action} its own session`,
    JSON.stringify(attemptedIds) === JSON.stringify(expectedIds),
    attemptedIds.join(', ')
  );

  // The workspace folder is the repository root. A resumed tab starts there
  // unless the restore path changes into the chat's linked worktree first.
  for (const run of attempted) {
    const text = runText(run);
    const chat = CHATS.find((candidate) =>
      text.includes(candidate.pendingHarnessSessionId)
    );
    if (!chat) {
      continue;
    }
    check(
      `stage ${stageIndex}: ${chat.name} ${action} in its worktree`,
      path.resolve(run.cwd || '') === path.resolve(chat.worktreePath),
      run.cwd
    );
  }
}

function checkNoRestore(stageIndex, terminals) {
  observe(
    `stage ${stageIndex}: tabs restored by VS Code`,
    JSON.stringify(terminals.map((terminal) => terminal.name))
  );

  const runs = readRuns();
  check(
    `stage ${stageIndex}: no harness resume was attempted`,
    runs.length === 3,
    `${runs.length} launches`
  );

  const pitwallNamed = terminals.filter((terminal) => parseShortId(terminal.name));
  check(
    `stage ${stageIndex}: no tab claims a Pitwall identity`,
    pitwallNamed.length === 0,
    pitwallNamed.map((terminal) => terminal.name).join(', ')
  );
}

/**
 * R1(b): when each revived tab's shell integrated, when its resume command
 * started, and when the harness ran, in ms after the driver activated (it
 * activates on startup finished, like Pitwall). Logged as observations;
 * nothing is asserted.
 */
function watchTiming(t0) {
  const since = () => Date.now() - t0;
  const events = [];
  const lines = [];
  for (const terminal of vscode.window.terminals) {
    if (terminal.shellIntegration) events.push(`${terminal.name}: integration present when the driver ran`);
  }
  const subscriptions = [
    vscode.window.onDidChangeTerminalShellIntegration(({ terminal }) =>
      events.push(`${terminal.name}: shell integration at ${since()} ms`)
    ),
    vscode.window.onDidStartTerminalShellExecution(({ terminal, execution }) => {
      const line = execution.commandLine && execution.commandLine.value;
      lines.push(String(line));
      // The whole line, so a resume line the starting shell only half read shows up.
      events.push(`${terminal.name}: command start at ${since()} ms (${JSON.stringify(String(line))})`);
    }),
  ];
  return {
    report(extensionActiveAt) {
      subscriptions.forEach((subscription) => subscription.dispose());
      observe('timing: Pitwall active', `${extensionActiveAt - t0} ms after the driver activated`);
      for (const event of events) observe('timing', event);
      for (const run of readRuns().slice(-EXPECT_RESUMES)) {
        observe('timing: harness ran', `${run.at - t0} ms (${runText(run).slice(-30)})`);
      }
    },
    /**
     * R42: each chat's resume line reached the shell with its change of
     * directory whole. A shell that drops the line's first keystroke ran
     * "et-Location ..." in Smoke 7; with the leading space it drops the space.
     */
    checkLines(stageIndex) {
      for (const chat of CHATS) {
        const resumeLines = lines.filter((line) => line.includes(chat.pendingHarnessSessionId));
        const whole = (line) =>
          isPowerShell()
            ? line.includes(`Set-Location -LiteralPath '${chat.worktreePath.replace(/'/g, "''")}'`)
            : /(^|\s)cd\s/.test(line) && line.includes(chat.worktreePath);
        check(
          `stage ${stageIndex}: ${chat.name}'s resume line reached the shell whole`,
          resumeLines.length > 0 && resumeLines.every(whole),
          JSON.stringify(resumeLines)
        );
      }
    },
  };
}

function isPowerShell() {
  return /(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(vscode.env.shell || '');
}

/**
 * The rename command, probed directly in this real editor:
 * - the new name is reported to the extension host before the command
 *   resolves (Pitwall's check-and-undo reads names right after it);
 * - an empty name is refused, so there is no way back to a dynamic title;
 * - with keyboard focus in one terminal and another shown without focus,
 *   the focused terminal is the one renamed (root cause 1).
 * Then a chat tab is shown without focus while the keyboard sits in a user's
 * panel terminal: Pitwall's own rename must leave that terminal its name.
 */
async function renameProbe() {
  const rename = (name) => vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name });
  const front = vscode.window.activeTerminal;
  const panel = vscode.window.createTerminal({ name: 'e2e-panel', location: vscode.TerminalLocation.Panel });
  panel.show(false);
  await waitFor(() => vscode.window.activeTerminal === panel, 'the panel probe terminal to be active');

  const rounds = 20;
  let reportedAtOnce = 0;
  for (let i = 0; i < rounds; i++) {
    const name = `e2e-panel-${i}`;
    await rename(name);
    if (panel.name === name) reportedAtOnce++;
  }
  check(
    `stage 0: a rename's new name is reported before the command resolves (${rounds} of ${rounds})`,
    reportedAtOnce === rounds,
    String(reportedAtOnce)
  );
  await rename('e2e-panel');

  const before = panel.name;
  await rename('');
  check('stage 0: an empty name is refused, so a title cannot be reset to dynamic', panel.name === before, panel.name);

  // Opening an editor terminal can itself take focus, so open it first,
  // then put the keyboard back in the panel, then show it without focus.
  const plain = vscode.window.createTerminal({ name: 'e2e-plain', location: vscode.TerminalLocation.Editor });
  plain.show(true);
  await waitFor(() => vscode.window.activeTerminal === plain, 'the plain tab to open');
  panel.show(false);
  await waitFor(() => vscode.window.activeTerminal === panel, 'the panel to be active again');
  plain.show(true);
  await waitFor(() => vscode.window.activeTerminal === plain, 'the plain tab to be active without focus');
  await rename('e2e-focus-probe');
  const focusFirst = panel.name === 'e2e-focus-probe';
  observe(
    'rename target with focus in the panel and another tab active',
    focusFirst ? 'the focused panel terminal (focus-first)' : plain.name === 'e2e-focus-probe' ? 'the active tab' : 'neither'
  );
  if (focusFirst) await rename('e2e-panel');
  plain.dispose();
  await waitFor(() => !vscode.window.terminals.includes(plain), 'the plain tab to close');

  // Pitwall re-applies a chat tab's title when the tab becomes active. With
  // the keyboard in the panel that rename lands on the panel and is undone.
  panel.show(false);
  await waitFor(() => vscode.window.activeTerminal === panel, 'the panel to be active again');
  const chatTab = vscode.window.terminals.find((terminal) => parseShortId(terminal.name));
  if (chatTab) {
    const chatTitle = chatTab.name;
    chatTab.show(true);
    await waitFor(() => vscode.window.activeTerminal === chatTab, 'the chat tab to be active without focus');
    // Pitwall's rename raises no event to wait on, so watch for a stray title
    // for a bounded window; one that stays is the bug.
    const strayed = await waitFor(() => parseShortId(panel.name), 'a Pitwall title on the panel', 3000);
    check(
      'stage 0: with focus in a user terminal, Pitwall never leaves its title there',
      !strayed && panel.name === 'e2e-panel' && chatTab.name === chatTitle,
      `${panel.name} / ${chatTab.name}`
    );
  }
  observe('focus-first reproduced in this run', String(focusFirst));
  panel.dispose();
  await waitFor(() => !vscode.window.terminals.includes(panel), 'the panel probe terminal to close');
  // Put back the tab that was in front, which the next stage expects active.
  if (front) {
    front.show(true);
    await waitFor(() => vscode.window.activeTerminal === front, 'the front tab to be active again');
  }
}

/**
 * R47 invariant: the identity is on the tab at quit. Every chat's tab must be
 * live and carry its `[shortId]` title right before the window quits or
 * reloads: every restore depends on it, whatever is in front.
 */
function checkIdentityBefore(stageIndex, moment) {
  const live = vscode.window.terminals.filter((terminal) => !terminal.exitStatus);
  observe(`stage ${stageIndex}: live terminals before the ${moment}`, JSON.stringify(live.map((terminal) => terminal.name)));
  const missing = CHATS.filter((chat) => live.filter((terminal) => terminal.name === expectedName(chat)).length !== 1);
  check(
    `stage ${stageIndex}: before the ${moment}, every live chat tab carries its [shortId] (R47)`,
    missing.length === 0,
    missing.map((chat) => chat.name).join(', ')
  );
}

/**
 * Put FRONT in front for the quit, starting from the first chat's tab in
 * front, and return what the restore must put back.
 */
async function arrangeFront() {
  if (FRONT === 'file') {
    const readme = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'README.md'));
    const group = vscode.window.tabGroups.all.find((candidate) =>
      candidate.tabs.some((tab) => tab.input instanceof vscode.TabInputTerminal)
    );
    await vscode.window.showTextDocument(readme, { viewColumn: group ? group.viewColumn : undefined, preview: false });
    await waitFor(() => activeTabLabel() === 'README.md', 'README.md in front of the chat tabs');
    return { activeName: undefined, front: { tab: 'README.md', file: readme.fsPath } };
  }
  if (FRONT === 'terminal') {
    const shell = vscode.window.createTerminal({ name: USER_SHELL, location: vscode.TerminalLocation.Panel });
    shell.show(false);
    await waitFor(() => vscode.window.activeTerminal === shell, 'the user shell to be active');
    await pidOf(shell);
    return { activeName: undefined, front: { tab: activeTabLabel(), terminal: 'other' } };
  }
  const name = vscode.window.activeTerminal?.name;
  return { activeName: name, front: { tab: name, terminal: name } };
}

async function quit() {
  await sleep(500);
  try {
    await vscode.commands.executeCommand('workbench.action.quit');
  } catch {
    // The window is already shutting down.
  }
}

exports.activate = async function activate() {
  const state = readState();
  // Stage 1 reloads its window once; the reloaded window is stage "1r".
  stage = state.stage === 1 && state.reload ? '1r' : state.stage || 0;
  log({ kind: 'observation', name: 'activate', detail: String(stage) });

  try {
    if (stage === 0) {
      const ready = await waitForCommand('pitwall.openChat');
      check('stage 0: pitwall.openChat is available', ready);
      if (!ready) {
        await quit();
        return;
      }

      for (const chat of CHATS) {
        await openChat(chat);
      }

      const target = { activeName: expectedName(CHATS[CHATS.length - 1]) };
      const settled = await waitFor(
        async () => isRestored(await readTerminals(), 3, target.activeName),
        'the three chats to open'
      );
      const terminals = await snapshot();
      check('stage 0: the three chats settled', settled, String(terminals.length));
      checkRestored(0, terminals, target);
      await renameProbe();

      // R44: quit with the FIRST chat in front, not the last one opened, so a
      // restore that leaves a later revived tab in front is caught (UJ run 11:
      // "Lab ready" in front at quit, "New Session" in front after it).
      const firstTab = vscode.window.terminals.find((terminal) => terminal.name === expectedName(CHATS[0]));
      if (firstTab) {
        firstTab.show(true);
        await waitFor(() => vscode.window.activeTerminal === firstTab, 'the first chat tab to be in front');
      }

      const { activeName, front } = await arrangeFront();
      checkIdentityBefore(0, 'quit');
      writeState({ stage: 1, activeName, front });
      await quit();
      return;
    }

    if (stage === '1r') {
      // After Developer: Reload Window every pty survives; Pitwall adopts each
      // tab by PID, keeps every title, and types into none of them.
      const front = watchFront(Date.now());
      const settled = await waitFor(async () => {
        const names = (await readTerminals()).map((terminal) => terminal.name).sort();
        return JSON.stringify(names) === JSON.stringify(state.reload.names);
      }, 'the reloaded tabs to keep their titles', 30000);
      // Adopted background tabs are renamed in the background; the tab in
      // front must be in front again once that is done (R44).
      await sleep(3000);
      front.check('1r', state.front, 'the reload', 'the tabs settle');
      const terminals = await snapshot();
      check('stage 1r: the tab count is unchanged after a reload', terminals.length === state.reload.names.length, String(terminals.length));
      check('stage 1r: every title is unchanged after a reload', settled, JSON.stringify(terminals.map((terminal) => terminal.name)));
      check(
        'stage 1r: every pty survived the reload',
        JSON.stringify(terminals.map((terminal) => terminal.pid).sort()) === JSON.stringify(state.reload.pids),
        JSON.stringify(terminals.map((terminal) => terminal.pid))
      );
      check('stage 1r: nothing was launched by the reload', readRuns().length === state.reload.runs, String(readRuns().length));
      check(
        'stage 1r: no two tabs share a short ID',
        new Set(terminals.map((terminal) => parseShortId(terminal.name))).size === terminals.length,
        JSON.stringify(terminals.map((terminal) => terminal.name))
      );
      checkIdentityBefore('1r', 'quit');
      writeState({ stage: 2, activeName: state.activeName, front: state.front });
      await quit();
      return;
    }

    if (stage === 1 || stage === 2) {
      // R44 (L1): the Pitwall sidebar is open while the restore runs, as in
      // the live test profile (pitwall.focusOnStartup), so its rows render and
      // reveal during the restore. The window keeps it open across the reload.
      void vscode.commands.executeCommand('workbench.view.extension.pitwall');
      const t0 = Date.now();
      const timing = watchTiming(t0);
      const front = watchFront(t0);
      const pitwall = EXTENSION_ID ? vscode.extensions.getExtension(EXTENSION_ID) : undefined;
      const pitwallActive = pitwall
        ? Promise.resolve(pitwall.activate()).then(() => Date.now(), () => Date.now())
        : Promise.resolve(t0);
      if (EXPECT_TITLES) {
        const expectedRuns = 3 + stage * EXPECT_RESUMES;
        // Settled = every title and every resume; which tab is in front is
        // checked separately, 3 s later, once the retitle pass has put it back.
        const settled = await waitFor(
          async () => isRestored(await readTerminals(), expectedRuns),
          'the restored tabs to resume',
          30000
        );
        await sleep(3000);
        const terminals = await snapshot();
        check(
          `stage ${stage}: restored tabs settled`,
          settled,
          String(terminals.length)
        );
        checkRestored(stage, terminals, state);
        front.check(stage, state.front);
        timing.report(await pitwallActive);
        timing.checkLines(stage);
      } else {
        // A resume that should not happen has no event to poll; give it time
        // to appear before asserting its absence.
        await sleep(5000);
        const terminals = await snapshot();
        checkNoRestore(stage, terminals);
      }

      if (stage === 1 && EXPECT_TITLES) {
        checkIdentityBefore(1, 'reload');
        const terminals = await readTerminals();
        writeState({
          stage: 1,
          activeName: state.activeName,
          front: state.front,
          reload: {
            names: terminals.map((terminal) => terminal.name).sort(),
            pids: terminals.map((terminal) => terminal.pid).sort(),
            runs: readRuns().length,
          },
        });
        try {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        } catch {
          // The window is already reloading.
        }
        return;
      }
      if (EXPECT_TITLES) {
        checkIdentityBefore(stage, 'quit');
      }
      writeState({
        stage: stage + 1,
        activeName: state.activeName,
        front: state.front,
      });
      await quit();
      return;
    }

    log({ kind: 'error', message: `unexpected stage ${stage}` });
    await quit();
  } catch (error) {
    log({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    await quit();
  }
};
