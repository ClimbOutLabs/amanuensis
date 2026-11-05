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

/** An element's name as a person reads it, with characters that show nothing taken out. */
function accessibleName(element) {
  return visibleCharacters(rawAccessibleName(element)).trim();
}

function rawAccessibleName(element) {
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
  if (element.tagName === 'INPUT') {
    // A button-like input carries its label in its own value, and an image input in its alt text:
    // neither has text content, so without this step such a control reads as having no name at all.
    const inputType = (element.getAttribute('type') ?? '').toLowerCase();
    if (inputType === 'image') {
      const alt = element.getAttribute('alt');
      if (alt !== null && alt.trim() !== '') {
        return alt.trim();
      }
    }
    if (inputType === 'submit' || inputType === 'button' || inputType === 'reset' || inputType === 'image') {
      const value = element.getAttribute('value');
      if (value !== null && value.trim() !== '') {
        return value.trim();
      }
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
  const text = visibleCharacters(element.textContent ?? '').trim();
  if (text === '') {
    return innerImageName(element);
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Characters that show nothing (zero-width spaces and joiners, soft hyphens, direction marks) are taken
 * out of a name, so a label spelled with them in the middle reads as the word a person sees.
 */
function visibleCharacters(text) {
  return text.replace(/\p{Cf}/gu, '');
}

/** The name of an icon-only control: the alt text or label of the images and icons inside it. */
function innerImageName(element) {
  const parts = [];
  for (const inner of element.querySelectorAll('img[alt], [aria-label], svg title')) {
    const part = visibleCharacters(
      inner.tagName.toLowerCase() === 'title'
        ? (inner.textContent ?? '')
        : (inner.getAttribute('alt') ?? inner.getAttribute('aria-label') ?? ''),
    ).trim();
    if (part !== '') {
      parts.push(part);
    }
  }
  return parts.join(' ');
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

/**
 * The form this control belongs to: the form around it, or the one its `form` attribute names when
 * it sits outside that form. The platform's own `form` property covers both, so it goes first.
 */
function formOf(element) {
  if (element.form !== undefined && element.form !== null) {
    return element.form;
  }
  return element.closest('form');
}

/** True when this element submits its form: a submit input/button, an image input, or a plain button in a form. */
function isFormSubmit(element) {
  const form = formOf(element);
  if (form === null) {
    return false;
  }
  // The element's own `type` property, not the attribute: a button with a type the browser does not
  // know (`type="primary"`) still submits, and the property says so where the raw attribute does not.
  if (element.tagName === 'BUTTON') {
    return element.type === 'submit';
  }
  return element.tagName === 'INPUT' && (element.type === 'submit' || element.type === 'image');
}

/**
 * The address a plain link goes to, or null for anything else. A plain link is an `<a>` or `<area>`
 * with an http or https address of another page: the browser itself follows it with an ordinary page
 * load. A link to a spot on the same page (`href="#"`), one that runs script (`javascript:`), one that
 * downloads, and one that says it is a button are not plain links, because what they do is up to the
 * page's own script.
 */
function linkUrlOf(element) {
  if (element.tagName !== 'A' && element.tagName !== 'AREA') {
    return null;
  }
  if (!element.hasAttribute('href') || element.hasAttribute('download')) {
    return null;
  }
  const role = (element.getAttribute('role') ?? '').trim().toLowerCase();
  if (role !== '' && role !== 'link') {
    return null;
  }
  let target;
  try {
    target = new URL(element.href);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return null;
  }
  const here = new URL(window.location.href);
  target.hash = '';
  here.hash = '';
  if (target.href === here.href) {
    return null;
  }
  return element.href;
}

/** Values of every named field on the clicked button's form, for the approval card. Sensitive values are masked. */
export function formValuesOf(element) {
  const form = formOf(element);
  if (form === null) {
    return {};
  }
  const values = {};
  for (const field of form.elements) {
    const name = field.name || field.id;
    if (name === '' || name === undefined) {
      continue;
    }
    const kind = fieldKind(field);
    values[name] = kind === null ? (field.value ?? '') : `[hidden: ${kind} field]`;
  }
  return values;
}

/** The element a snapshot id (`domPath`'s output) names, or null when the page no longer has it. */
export function elementAtPath(path) {
  if (path === '') {
    return document.body;
  }
  let node = document.body;
  for (const part of path.split('/')) {
    const [tag, indexText] = part.split(':');
    const index = Number(indexText);
    const match = Array.from(node.children).filter(child => child.tagName === tag)[index];
    if (match === undefined) {
      return null;
    }
    node = match;
  }
  return node;
}

/** Field, click and form context for one element, read without changing the page. */
export function elementInfoOf(element) {
  if (!element.isConnected) {
    return null;
  }
  return {
    field_kind: fieldKind(element),
    is_form_submit: isFormSubmit(element),
    accessible_name: accessibleName(element),
    form_values: formValuesOf(element),
    link_url: linkUrlOf(element),
    tag: element.tagName,
  };
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
