// Runs inside the page (`page.evaluate`), so it may only use the DOM and plain JS: no imports, no
// Node globals. Walks the visible headings, text and controls of the page in reading order, each
// already tagged with the field kind that governs whether its value may be shown.

/** Attribute and name patterns that mark a field as a password, a card number, or a one-time code. */
function fieldKind(element) {
  const type = (element.getAttribute('type') ?? '').toLowerCase();
  const autocomplete = (element.getAttribute('autocomplete') ?? '').toLowerCase();
  const name = `${element.getAttribute('name') ?? ''} ${element.id ?? ''}`.toLowerCase();
  if (type === 'password') {
    return 'password';
  }
  if (autocomplete.startsWith('cc-') || /\b(card.?number|cvv|cvc|security.?code)\b/.test(name)) {
    return 'card';
  }
  if (autocomplete === 'one-time-code' || /\b(otp|one.?time.?code|verification.?code)\b/.test(name)) {
    return 'otp';
  }
  return null;
}

const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

function isVisible(element) {
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function accessibleName(element) {
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.trim() !== '') {
    return ariaLabel.trim();
  }
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(part => part !== '')
      .join(' ');
    if (text !== '') {
      return text;
    }
  }
  if (element.id !== '') {
    const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
    if (label?.textContent !== undefined && label.textContent.trim() !== '') {
      return label.textContent.trim();
    }
  }
  const placeholder = element.getAttribute('placeholder');
  if (placeholder !== null && placeholder.trim() !== '') {
    return placeholder.trim();
  }
  const title = element.getAttribute('title');
  if (title !== null && title.trim() !== '') {
    return title.trim();
  }
  const text = element.textContent?.trim() ?? '';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function roleOf(element) {
  const explicit = element.getAttribute('role');
  if (explicit !== null && explicit.trim() !== '') {
    return explicit.trim();
  }
  const tag = element.tagName;
  if (tag === 'A') {
    return 'link';
  }
  if (tag === 'BUTTON') {
    return 'button';
  }
  if (tag === 'SELECT') {
    return 'combobox';
  }
  if (tag === 'TEXTAREA') {
    return 'textbox';
  }
  if (tag === 'INPUT') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox') {
      return 'checkbox';
    }
    if (type === 'radio') {
      return 'radio';
    }
    if (type === 'submit' || type === 'button') {
      return 'button';
    }
    return 'textbox';
  }
  if (HEADING_TAGS.has(tag)) {
    return `heading-${tag.slice(1)}`;
  }
  return 'text';
}

/** A stable id for one element: its position among same-tag siblings at each level, root to element. */
function domPath(element) {
  const parts = [];
  let node = element;
  while (node !== null && node !== document.body && node.parentElement !== null) {
    const siblings = Array.from(node.parentElement.children).filter(child => child.tagName === node.tagName);
    parts.unshift(`${node.tagName}:${String(siblings.indexOf(node))}`);
    node = node.parentElement;
  }
  return parts.join('/');
}

/** Text a person reads on the page, outside headings and controls. */
const TEXT_TAGS = new Set(['P', 'LI', 'TD', 'TH', 'DT', 'DD', 'BLOCKQUOTE', 'PRE', 'FIGCAPTION']);
const MAX_TEXT_CHARS = 1000;

/** The visible text of one text block, or '' when a block around it already carries that text. */
function blockText(element) {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    if (TEXT_TAGS.has(parent.tagName)) {
      return '';
    }
  }
  const text = (element.innerText ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

/** Visible page content in reading order: headings, text, and the controls, each with a stable id. */
export function extractSnapshotNodes() {
  const nodes = [];
  const selector = [...HEADING_TAGS, ...TEXT_TAGS, ...INTERACTIVE_TAGS].join(',');
  for (const element of document.querySelectorAll(selector)) {
    if (!isVisible(element)) {
      continue;
    }
    if (TEXT_TAGS.has(element.tagName)) {
      const text = blockText(element);
      if (text !== '') {
        nodes.push({ id: domPath(element), role: 'text', name: text, field_kind: null, actionable: false });
      }
      continue;
    }
    const actionable = INTERACTIVE_TAGS.has(element.tagName);
    nodes.push({
      id: domPath(element),
      role: roleOf(element),
      name: accessibleName(element),
      value: element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' ? element.value : undefined,
      field_kind: fieldKind(element),
      actionable,
    });
  }
  return nodes;
}
