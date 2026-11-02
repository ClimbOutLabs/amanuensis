import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RefAssigner, renderSnapshot, sensitivityOf } from '../src/snapshot.mjs';

function node(overrides) {
  return { id: 'x', role: 'text', name: '', value: undefined, field_kind: null, actionable: false, ...overrides };
}

test('actionable nodes get refs; non-actionable ones do not', () => {
  const nodes = [
    node({ id: 'h1', role: 'heading-1', name: 'Account' }),
    node({ id: 'a1', role: 'link', name: 'Cancel membership', actionable: true }),
  ];
  const refs = new RefAssigner().refsFor(nodes);
  assert.equal(refs.has('h1'), false);
  assert.equal(refs.get('a1'), 'e1');
});

test('refs are stable across reads of the same page', () => {
  const assigner = new RefAssigner();
  const first = [node({ id: 'a1', actionable: true }), node({ id: 'a2', actionable: true })];
  const firstRefs = assigner.refsFor(first);
  // A second read of the same page, after a scroll: same ids, same refs.
  const second = [node({ id: 'a1', actionable: true }), node({ id: 'a2', actionable: true })];
  const secondRefs = assigner.refsFor(second);
  assert.equal(firstRefs.get('a1'), secondRefs.get('a1'));
  assert.equal(firstRefs.get('a2'), secondRefs.get('a2'));
});

test('reset starts a fresh ref table for a new page', () => {
  const assigner = new RefAssigner();
  assigner.refsFor([node({ id: 'a1', actionable: true })]);
  assigner.reset();
  const refs = assigner.refsFor([node({ id: 'a1', actionable: true })]);
  assert.equal(refs.get('a1'), 'e1');
});

test('a password field never shows its value', () => {
  const field = node({ id: 'p1', role: 'textbox', name: 'Password', value: 'hunter2', field_kind: 'password' });
  assert.equal(sensitivityOf(field), 'password field');
  const refs = new Map();
  const text = renderSnapshot({ title: 'Sign in', url: 'https://example.com', nodes: [field], refs });
  assert.doesNotMatch(text, /hunter2/);
  assert.match(text, /\[hidden: password field\]/);
});

test('a card number field never shows its value', () => {
  const field = node({ id: 'c1', role: 'textbox', name: 'Card number', value: '4111111111111111', field_kind: 'card' });
  const text = renderSnapshot({ title: 'Checkout', url: 'https://example.com', nodes: [field], refs: new Map() });
  assert.doesNotMatch(text, /4111111111111111/);
  assert.match(text, /\[hidden: payment detail field\]/);
});

test('a one-time-code field never shows its value', () => {
  const field = node({ id: 'o1', role: 'textbox', name: 'Code', value: '482913', field_kind: 'otp' });
  const text = renderSnapshot({ title: 'Verify', url: 'https://example.com', nodes: [field], refs: new Map() });
  assert.doesNotMatch(text, /482913/);
  assert.match(text, /\[hidden: one-time code field\]/);
});

test('includes the title and the address', () => {
  const text = renderSnapshot({ title: 'Hulu', url: 'https://hulu.com/account', nodes: [], refs: new Map() });
  assert.match(text, /^# Hulu\nhttps:\/\/hulu\.com\/account\n/);
});

test('cuts a very long page and says how to see more', () => {
  const nodes = Array.from({ length: 5000 }, (_v, i) =>
    node({ id: `n${String(i)}`, role: 'text', name: `Line number ${String(i)} of filler text to pad this out` }),
  );
  const text = renderSnapshot({ title: 'Long page', url: 'https://example.com', nodes, refs: new Map() });
  assert.ok(text.length < nodes.length * 60, 'the text was cut, not rendered in full');
  assert.match(text, /cut; this page has more/);
});
