// Variables an editor inherits from the shell that launched it. The first three
// make a spawned editor start as plain Node; the last four make the CLI hand
// off to the editor that spawned the shell instead of starting a new one.
const ELECTRON_VARS = [
  'ELECTRON_RUN_AS_NODE',
  'VSCODE_ESM_ENTRYPOINT',
  'VSCODE_CRASH_REPORTER_PROCESS_TYPE',
  'VSCODE_IPC_HOOK',
  'VSCODE_IPC_HOOK_CLI',
  'VSCODE_PID',
  'VSCODE_CWD',
];

/** Deletes the variables in place and returns `env`. */
function scrubElectronEnv(env = process.env) {
  for (const name of ELECTRON_VARS) {
    delete env[name];
  }
  return env;
}

module.exports = { ELECTRON_VARS, scrubElectronEnv };
