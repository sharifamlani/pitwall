#!/usr/bin/env bash
# Runs the editor CLI (Cursor by default; set PITWALL_EDITOR_CLI for another)
# with the Electron variables a parent editor leaves in the shell removed, so
# it starts as an editor rather than as Node or a hand-off to the parent.
# Keep the -u list in step with ELECTRON_VARS in test/electronEnv.js.
exec env -u ELECTRON_RUN_AS_NODE -u VSCODE_ESM_ENTRYPOINT -u VSCODE_CRASH_REPORTER_PROCESS_TYPE -u VSCODE_IPC_HOOK -u VSCODE_IPC_HOOK_CLI -u VSCODE_PID -u VSCODE_CWD "${PITWALL_EDITOR_CLI:-cursor}" "$@"
