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
/** Controls a page builds from plain elements, such as a custom dropdown's options, which can be clicked too. */
const INTERACTIVE_ROLES = [
  'button',
  'link',
  'option',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'tab',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'treeitem',
];
const ROLE_SELECTOR = INTERACTIVE_ROLES.map(role => `[role="${role}"]`).join(',');

/** What a person sees as a control's state: the chosen option and the choices of a dropdown, or whether a box is ticked. */
function controlValue(element) {
  if (element.tagName === 'SELECT') {
    const chosen = element.selectedOptions[0]?.textContent?.trim() ?? '';
    const choices = Array.from(element.options)
      .map(option => option.textContent?.trim() ?? '')
      .filter(text => text !== '')
      .slice(0, 40);
    return `${chosen === '' ? '(none)' : chosen} (choices: ${choices.join(' | ')})`;
  }
  if (element.tagName === 'INPUT') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      return element.checked ? 'checked' : 'not checked';
    }
    return element.value;
  }
  if (element.tagName === 'TEXTAREA') {
    return element.value;
  }
  const state =
    element.getAttribute('aria-checked') ??
    element.getAttribute('aria-selected') ??
    element.getAttribute('aria-expanded');
  return state === null
    ? undefined
    : `${element.getAttribute('aria-expanded') !== null ? 'expanded' : 'checked'}: ${state}`;
}

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
  const selector = [...HEADING_TAGS, ...TEXT_TAGS, ...INTERACTIVE_TAGS, ROLE_SELECTOR].join(',');
  for (const element of document.querySelectorAll(selector)) {
    if (!isVisible(element)) {
      continue;
    }
    const roleControl = element.matches(ROLE_SELECTOR);
    if (TEXT_TAGS.has(element.tagName) && !roleControl) {
      const text = blockText(element);
      if (text !== '') {
        nodes.push({ id: domPath(element), role: 'text', name: text, field_kind: null, actionable: false });
      }
      continue;
    }
    const actionable = INTERACTIVE_TAGS.has(element.tagName) || roleControl;
    const name = accessibleName(element);
    nodes.push({
      id: domPath(element),
      role: roleOf(element),
      name: name === '' && roleControl ? (element.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) : name,
      value: controlValue(element),
      field_kind: fieldKind(element),
      actionable,
    });
  }
  // Pages also make plain boxes clickable (a styled bar with a click handler). Each outermost one that
  // shows a hand cursor, or has a click handler or keyboard focus, and holds no real control, is a button too.
  const seen = new Set(nodes.map(node => node.id));
  let extra = 0;
  for (const element of document.querySelectorAll('div,span,img,label,td,li,p,section,svg,i')) {
    if (extra >= 300) {
      break;
    }
    const clickable =
      element.hasAttribute('onclick') ||
      (element.hasAttribute('tabindex') && element.getAttribute('tabindex') !== '-1') ||
      window.getComputedStyle(element).cursor === 'pointer';
    if (!clickable || !isVisible(element)) {
      continue;
    }
    const parent = element.parentElement;
    if (parent !== null && window.getComputedStyle(parent).cursor === 'pointer') {
      continue;
    }
    if (element.closest('a,button,input,select,textarea,[role]') !== null) {
      continue;
    }
    if (element.querySelector('a,button,input,select,textarea') !== null) {
      continue;
    }
    const id = domPath(element);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    extra += 1;
    const text = (element.innerText ?? element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    nodes.push({ id, role: 'button', name: text, value: undefined, field_kind: null, actionable: true });
  }
  return nodes;
}
