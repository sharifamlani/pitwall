/**
 * `readJsonlTail`: a window grown from the end of the file until the scan
 * decides, and, with `maxBytes`, never past that size (E16: discovery reads
 * every recent transcript's tail on the extension host).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { readJsonlTail } from '../../../src/core/utils/jsonlTail';
import { tempDir } from '../support';

const line = (value: object) => `${JSON.stringify(value)}\n`;

/** A file of one marked entry followed by `padding` bytes of unmarked ones. */
function write(t: { after(fn: () => void): void }, padding: number): string {
  const file = path.join(tempDir(t, 'pitwall-tail-'), 'record.jsonl');
  const filler = line({ pad: 'x'.repeat(1000) });
  fs.writeFileSync(file, line({ mark: true }) + filler.repeat(Math.ceil(padding / filler.length)));
  return file;
}

/** Decides on the last marked entry; undecided otherwise, with `fallback`. */
const lastMark = (fallback: string) => (entries: unknown[]) =>
  entries.some((entry) => (entry as { mark?: boolean }).mark)
    ? { value: 'found', decided: true }
    : { value: fallback, decided: false };

test('the window grows until the scan decides', async (t) => {
  const file = write(t, 200 * 1024);
  assert.equal(await readJsonlTail(file, lastMark('start')), 'found');
});

test('an undecided scan that reaches the start returns its value there', async (t) => {
  const file = path.join(tempDir(t, 'pitwall-tail-'), 'record.jsonl');
  fs.writeFileSync(file, line({ pad: 1 }) + line({ pad: 2 }));
  assert.equal(await readJsonlTail(file, lastMark('start')), 'start');
});

test('with maxBytes, a scan still undecided at that window returns null', async (t) => {
  const file = write(t, 300 * 1024);
  const windows: number[] = [];
  const scan = (entries: unknown[]) => {
    windows.push(entries.length);
    return lastMark('start')(entries);
  };
  assert.equal(await readJsonlTail(file, scan, { maxBytes: 64 * 1024 }), null);
  assert.equal(windows.length, 2, 'the 16 KB window, then the 64 KB one, and no larger');
  // Within the limit, the same file decides.
  assert.equal(await readJsonlTail(file, lastMark('start'), { maxBytes: 1024 * 1024 }), 'found');
});
