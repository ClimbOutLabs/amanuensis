// Turns the page elements `extract.mjs` reads out of the DOM into the short text the model reads
// instead of a screenshot: the title and address, then the page's text and one line per heading or
// control, each actionable one carrying a short ref such as `e14`. A password, card or one-time-code
// field never shows its value.

/** About four characters per token; the budget this module cuts text to. */
const TARGET_TOKENS = 8000;
const CHARS_PER_TOKEN = 4;
const MAX_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;

const CUT_NOTE = '\n…(cut; this page has more. Scroll, or ask a narrower question, to see the rest.)';

/** A sensitive field's value is never shown, however the page or the model asks for it. */
export function sensitivityOf(node) {
  if (node.field_kind === 'password') {
    return 'password field';
  }
  if (node.field_kind === 'card') {
    return 'payment detail field';
  }
  if (node.field_kind === 'otp') {
    return 'one-time code field';
  }
  return null;
}

function oneLine({ node, ref }) {
  if (node.role === 'text') {
    return node.name;
  }
  const hidden = sensitivityOf(node);
  const name = node.name === '' ? '(no label)' : node.name;
  const prefix = ref === null ? '-' : `[${ref}]`;
  if (hidden !== null) {
    return `${prefix} ${node.role} ${name}: [hidden: ${hidden}]`;
  }
  if (node.value !== undefined && node.value !== '') {
    return `${prefix} ${node.role} ${name}: ${node.value}`;
  }
  return `${prefix} ${node.role} ${name}`;
}

/**
 * Builds the snapshot text. `nodes` is the extractor's flat list of visible content in reading order; `refs` maps each actionable node to the short id it keeps for this page (stable
 * across re-reads of the same page, assigned once by the caller that tracks them).
 */
export function renderSnapshot({ title, url, nodes, refs }) {
  const header = `# ${title === '' ? '(untitled)' : title}\n${url}\n`;
  const lines = nodes.map(node => oneLine({ node, ref: refs.get(node.id) ?? null }));
  let body = lines.join('\n');
  let truncated = false;
  if (header.length + body.length > MAX_CHARS) {
    const budget = Math.max(0, MAX_CHARS - header.length - CUT_NOTE.length);
    body = body.slice(0, budget);
    const lastBreak = body.lastIndexOf('\n');
    if (lastBreak > 0) {
      body = body.slice(0, lastBreak);
    }
    truncated = true;
  }
  return `${header}${body}${truncated ? CUT_NOTE : ''}`;
}

/**
 * Assigns a stable ref to each actionable node of a page, by its DOM path: a node keeps its ref
 * across reads of the same page (scrolling, a value typed in) as long as the page itself does not
 * reload, so a tool call made from one read's ref still means the same element on the next.
 */
export class RefAssigner {
  #byPath = new Map();
  #next = 1;

  refsFor(nodes) {
    const refs = new Map();
    for (const node of nodes) {
      if (!node.actionable) {
        continue;
      }
      let ref = this.#byPath.get(node.id);
      if (ref === undefined) {
        ref = `e${String(this.#next)}`;
        this.#next += 1;
        this.#byPath.set(node.id, ref);
      }
      refs.set(node.id, ref);
    }
    return refs;
  }

  reset() {
    this.#byPath.clear();
    this.#next = 1;
  }
}
