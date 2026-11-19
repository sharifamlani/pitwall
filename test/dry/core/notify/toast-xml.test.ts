/**
 * The Windows pop-up's XML (row 5.2, §3a, Q36, Q41): every text node escaped,
 * the canvas copy, `<audio>` per the sound switch, and the click wiring (the
 * body and Open chat launch the open URI; Dismiss is a system action).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { popupCopy, toastXml, ToastPayload } from '../../../../src/core/notify/toastXml';

const URI = 'cursor://sharifamlani.pitwall/open?session=5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

function payload(overrides: Partial<ToastPayload> = {}): ToastPayload {
  return {
    aumid: 'sharifamlani.pitwall',
    title: 'uj-lab-b needs you',
    body: 'Fix map: Claude is waiting for you.',
    attribution: 'permission prompt',
    sound: false,
    openUri: URI,
    tag: '5f0c3d4e-needs',
    ...overrides,
  };
}

/** The text of every `<text>` node, unescaped as an XML reader would. */
function texts(xml: string): string[] {
  return [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) =>
    match[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
  );
}

test('toastXml escapes <, &, " and \' in titles', () => {
  const hostile = `uj-lab-b <script> & "quoted" 'single' </text><text>forged`;
  const xml = toastXml(payload({ title: hostile, body: 'a & b <c>', attribution: `"why" & 'how'` }));
  assert.ok(!xml.includes('<script>'), 'no raw <');
  assert.ok(!xml.includes('</text><text>forged'), 'a title cannot close its node');
  assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(xml), 'every & is an entity');
  assert.deepEqual(texts(xml), [hostile, 'a & b <c>', `"why" & 'how'`], 'the text reads back unchanged');
  // Exactly three text nodes, two actions, one audio element: the title added no element.
  assert.equal((xml.match(/<text/g) ?? []).length, 3);
  assert.equal((xml.match(/<action /g) ?? []).length, 2);
  assert.equal((xml.match(/<audio /g) ?? []).length, 1);
  // XML 1.0 forbids control characters; they are dropped rather than breaking LoadXml.
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(toastXml(payload({ title: 'a\u0001b\u001bc' }))));
});

test('copy matches §3a for needs and finished', () => {
  assert.deepEqual(popupCopy('needs', { repo: 'uj-lab-b', chat: 'Fix map', waitingFor: 'permission prompt' }), {
    title: 'uj-lab-b needs you',
    body: 'Fix map: Claude is waiting for you.',
    attribution: 'permission prompt',
  });
  assert.deepEqual(popupCopy('finished', { repo: 'uj-lab-c', chat: 'Notes sync', waitingFor: 'ignored' }), {
    title: 'uj-lab-c: finished',
    body: 'Notes sync: Your turn.',
  });
  assert.deepEqual(popupCopy('needs', { repo: 'uj-lab-b', chat: 'Fix map' }), {
    title: 'uj-lab-b needs you',
    body: 'Fix map: Claude is waiting for you.',
  }, 'no reason, no attribution line');

  const xml = toastXml(payload());
  assert.deepEqual(texts(xml), ['uj-lab-b needs you', 'Fix map: Claude is waiting for you.', 'permission prompt']);
  assert.match(xml, /<text placement="attribution">permission prompt<\/text>/);
  assert.match(xml, /<action content="Open chat" /);
  assert.match(xml, /<action content="Dismiss" /);
  assert.deepEqual(texts(toastXml(payload({ title: 'uj-lab-c: finished', body: 'Notes sync: Your turn.', attribution: undefined }))), [
    'uj-lab-c: finished',
    'Notes sync: Your turn.',
  ]);
  for (const line of [...texts(xml), 'Open chat', 'Dismiss']) {
    assert.ok(!line.includes('!'), 'no exclamation marks');
  }
});

test('sound off writes audio silent, sound on writes Notification.Default', () => {
  const off = toastXml(payload({ sound: false }));
  assert.match(off, /<audio silent="true"\/>/);
  assert.ok(!off.includes('ms-winsoundevent'));
  const on = toastXml(payload({ sound: true }));
  assert.match(on, /<audio src="ms-winsoundevent:Notification\.Default"\/>/);
  assert.ok(!on.includes('silent'));
});

test('Open chat and the body launch the open URI; Dismiss is a system action', () => {
  const uri = 'cursor://sharifamlani.pitwall/open?session=5f0c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f&x="y"';
  const xml = toastXml(payload({ openUri: uri }));
  const escaped = uri.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  assert.match(xml, new RegExp(`^<toast launch="${escapeRe(escaped)}" activationType="protocol">`), 'a body click launches the URI');
  assert.match(xml, new RegExp(`<action content="Open chat" activationType="protocol" arguments="${escapeRe(escaped)}"/>`));
  assert.match(xml, /<action content="Dismiss" activationType="system" arguments="dismiss"\/>/);
  assert.match(xml, /<binding template="ToastGeneric">/);
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
