import * as path from 'path';
import * as vscode from 'vscode';
import { logOperation } from '../services/OperationLog';
import { offerGitignore } from './envIgnoreCheck';

/** A repo as the sidebar names it. */
export interface RepoRef {
  name: string;
  rootPath: string;
}

/**
 * The first free name for `sourceName` in `targetDir`: the name itself, then
 * `{name} copy{.ext}`, then `{name} copy 2{.ext}`, and so on.
 */
export async function uniqueDest(targetDir: string, sourceName: string): Promise<string> {
  const ext = path.extname(sourceName);
  const base = ext ? sourceName.slice(0, -ext.length) : sourceName;
  for (let counter = 0; ; counter++) {
    const suffix = counter === 0 ? '' : counter === 1 ? ' copy' : ` copy ${counter}`;
    const candidate = path.join(targetDir, `${base}${suffix}${ext}`);
    const taken = await vscode.workspace.fs.stat(vscode.Uri.file(candidate)).then(
      () => true,
      () => false
    );
    if (!taken) {
      return candidate;
    }
  }
}

/** Copy `srcPath` into the repo root, never overwriting: a name clash saves as `{name} copy{.ext}`. */
export async function copyInto(repoRoot: string, srcPath: string): Promise<{ dest: string; clashed: boolean }> {
  const name = path.basename(srcPath);
  const dest = await uniqueDest(repoRoot, name);
  await vscode.workspace.fs.copy(vscode.Uri.file(srcPath), vscode.Uri.file(dest), { overwrite: false });
  return { dest, clashed: path.basename(dest) !== name };
}

/** The §3f "Pasted / Moved" message, with the name-clash sentence when the copy was renamed. */
export function landedMessage(
  verb: 'Pasted' | 'Moved',
  name: string,
  fromRepo: string,
  intoName: string,
  intoPath: string,
  dest: string
): string {
  const destName = path.basename(dest);
  const clash =
    destName !== name ? ` A file with that name was already there, so it was saved as '${destName}'.` : '';
  return `${verb} ${name} from ${fromRepo} into ${intoName} (${intoPath}).${clash}`;
}

/**
 * Copy a file into another repo's root (Copy to another repo, or a drop on its
 * row), say where it landed, and offer the .gitignore rule for a `.env` copy.
 */
export async function copyIntoRepo(target: RepoRef, srcPath: string, fromRepo: string): Promise<void> {
  const name = path.basename(srcPath);
  let dest: string;
  try {
    ({ dest } = await copyInto(target.rootPath, srcPath));
  } catch (error) {
    logOperation(`Copy to ${target.rootPath} failed: ${srcPath} (${String(error)})`);
    vscode.window.showErrorMessage(`Paste failed: ${error}`);
    return;
  }
  logOperation(`Copied ${srcPath} -> ${dest}`);
  vscode.window.showInformationMessage(landedMessage('Pasted', name, fromRepo, target.name, target.rootPath, dest));
  await offerGitignore(target, name, dest);
}
