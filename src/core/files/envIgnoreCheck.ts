import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logOperation } from '../services/OperationLog';

/** Templates meant to be committed: never offered (Q11). */
const ENV_TEMPLATES: ReadonlySet<string> = new Set(['.env.example', '.env.sample', '.env.template']);

const ADD = 'Add to .gitignore';
const NOT_NOW = 'Not now';

/** Whether a copied file's name looks like a secrets file: `.env` or `.env.*`, except the templates (Q11). */
export function isEnvLike(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === '.env' || (lower.startsWith('.env.') && !ENV_TEMPLATES.has(lower));
}

/** A repo-relative path as git and .gitignore spell it: forward slashes. */
function gitPath(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

/**
 * Whether git ignores `relPath` in the repo at `repoRoot`: `git check-ignore -q`
 * run there. Exit 0 = ignored, 1 = not ignored; anything else (128: not a
 * repo, or git missing) is `'error'`.
 */
export function checkIgnored(repoRoot: string, relPath: string): Promise<boolean | 'error'> {
  return new Promise((resolve) => {
    execFile('git', ['check-ignore', '-q', '--', gitPath(relPath)], { cwd: repoRoot, windowsHide: true }, (error) => {
      if (!error) {
        resolve(true);
      } else if ((error as { code?: unknown }).code === 1) {
        resolve(false);
      } else {
        resolve('error');
      }
    });
  });
}

/** Append `/{rel}` to the repo's .gitignore, creating it, with a newline first when the file lacks a final one. */
export async function appendToGitignore(repoRoot: string, relPath: string): Promise<void> {
  const file = path.join(repoRoot, '.gitignore');
  let existing = '';
  try {
    existing = await fs.promises.readFile(file, 'utf8');
  } catch {
    // Missing: created below.
  }
  const lead = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  // Glob characters are escaped, so `app/[id]/.env` matches only itself.
  const pattern = gitPath(relPath).replace(/[[\]*?]/g, '\\$&');
  await fs.promises.appendFile(file, `${lead}/${pattern}\n`);
}

/**
 * After a file lands at `destPath` in the repo at `repoRoot`: when the source
 * was named like a secrets file and git does not ignore the copy, warn and
 * offer to add it to that repo's .gitignore (Q11, §3f). A failed check makes
 * no offer and is logged.
 */
export async function offerGitignore(repo: { name: string; rootPath: string }, sourceName: string, destPath: string): Promise<void> {
  if (!isEnvLike(sourceName)) {
    return;
  }
  const rel = path.relative(repo.rootPath, destPath);
  const destName = path.basename(destPath);
  const ignored = await checkIgnored(repo.rootPath, rel);
  if (ignored === 'error') {
    logOperation(`[Pitwall] git check-ignore failed for ${gitPath(rel)} in ${repo.rootPath}; no .gitignore offer`);
    return;
  }
  if (ignored) {
    return;
  }
  const answer = await vscode.window.showWarningMessage(
    `⚠ ${repo.name}'s .gitignore does not cover ${destName}, so it could get committed.`,
    ADD,
    NOT_NOW
  );
  if (answer !== ADD) {
    return;
  }
  try {
    await appendToGitignore(repo.rootPath, rel);
  } catch (error) {
    logOperation(`[Pitwall] .gitignore append failed in ${repo.rootPath}: ${String(error)}`);
    return;
  }
  logOperation(`Added /${gitPath(rel)} to ${path.join(repo.rootPath, '.gitignore')}`);
  if ((await checkIgnored(repo.rootPath, rel)) === true) {
    vscode.window.showInformationMessage(`Added ${destName} to ${repo.name}'s .gitignore.`);
  } else {
    logOperation(`[Pitwall] ${gitPath(rel)} is still not ignored in ${repo.rootPath} after the .gitignore append`);
  }
}
