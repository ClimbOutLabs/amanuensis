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

/**
 * What an action on one element is checked against: the site, the element's name and role, whether
 * it submits a form, the form's values, and the address when it is a plain link. Read without changing
 * the page, or null when the element is no longer on it.
 */
export function elementReviewOf(element) {
  if (!element.isConnected) {
    return null;
  }
  return {
    site: window.location.hostname,
    accessible_name: accessibleName(element),
    role: roleOf(element),
    is_form_submit: isFormSubmit(element),
    form_values: formValuesOf(element),
    link_url: linkUrlOf(element),
  };
}

/** Which fields of a read an action must find unchanged: typing changes a form's values, so only a click checks them. */
const CHECKED_FIELDS = {
  click: ['site', 'accessible_name', 'role', 'is_form_submit', 'form_values', 'link_url'],
  type: ['site', 'accessible_name', 'role'],
  select: ['site', 'accessible_name', 'role'],
};

/** True when two reads agree on every field the action checks: the one place that comparison is made. */
export function sameElementReview({ a, b, action }) {
  return CHECKED_FIELDS[action].every(field => {
    if (field !== 'form_values') {
      return a[field] === b[field];
    }
    const aNames = Object.keys(a.form_values).sort();
    const bNames = Object.keys(b.form_values).sort();
    return (
      aNames.length === bNames.length &&
      aNames.every((name, index) => name === bNames[index] && a.form_values[name] === b.form_values[name])
    );
  });
}

/** Input types that hold typed text; a checkbox, a button or a file picker is not typed into. */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'number',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
]);

/** Picks a `<select>` option the way a person's choice does, so the page's own code sees the change. */
function pickOption(element, value) {
  // The platform's own setter: a page framework that wraps the element's `value` still sees the change.
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(element, value);
  element.dispatchEvent(new window.Event('input', { bubbles: true }));
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}

/**
 * Arms the read world's input guard (set up by the sidecar at the start of every document) for one
 * element: until the sidecar disarms it, input that lands anywhere else is stopped before the page
 * sees it. False when the guard is missing, so the action is refused rather than run unguarded.
 */
function armGuard({ element, mode }) {
  const guard = globalThis.amanGuard;
  // A guard set up after the page's own scripts may not be the first to see input, so it is not used.
  if (guard === undefined || guard.late === true) {
    return false;
  }
  guard.element = element;
  guard.mode = mode;
  guard.strayed = false;
  guard.landed = false;
  return true;
}

/** Characters that are not text: a line break or tab would press Enter or Tab, which can send a form. */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/** In a multi-line field, the line breaks and tabs that the caller inserts as text rather than pressing as keys. */
const TYPED_BREAKS = new Set(['\n', '\r', '\t']);

/**
 * Reads the element at a snapshot id and, unless the action is only a read (`info`), checks it and
 * starts the action in the same step, so nothing the page does can come between the check and the
 * action. Runs in a script world of its own, where the page's scripts cannot change what the read sees.
 *
 * A click on a plain link is not pressed: the caller opens its address, so no script of the page
 * runs. Any other click is pressed by the caller with real input at the point returned here, which
 * was just checked to land on the element; typing is done by the caller with real keystrokes into the
 * field focused here. Both run under the input guard. Picking an option sets it here.
 */
export function actOnElement({ path, action, expect, option, text }) {
  const element = elementAtPath(path);
  const review = element === null ? null : elementReviewOf(element);
  if (review === null) {
    return { status: 'refused', reason: 'stale_ref' };
  }
  if (action === 'info') {
    return { status: 'ok', review };
  }
  if (!sameElementReview({ a: review, b: expect, action })) {
    return { status: 'refused', reason: 'changed' };
  }
  if (action === 'click' && review.link_url !== null) {
    return { status: 'navigate', url: review.link_url };
  }
  if (element.disabled === true || element.getAttribute('aria-disabled') === 'true') {
    return { status: 'refused', reason: 'disabled' };
  }
  if (action === 'click') {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit === null || !element.contains(hit)) {
      return { status: 'refused', reason: 'covered' };
    }
    return armGuard({ element, mode: 'press' })
      ? { status: 'press', x, y }
      : { status: 'refused', reason: 'unchecked' };
  }
  if (action === 'type') {
    if (fieldKind(element) !== null) {
      return { status: 'refused', reason: 'sensitive_field' };
    }
    if (element.tagName !== 'TEXTAREA' && !(element.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(element.type))) {
      return { status: 'refused', reason: 'not_a_field' };
    }
    if (element.readOnly) {
      return { status: 'refused', reason: 'read_only' };
    }
    const multiline = element.tagName === 'TEXTAREA';
    const characters = Array.from(text);
    const refused = character => CONTROL_CHARACTERS.test(character) && !(multiline && TYPED_BREAKS.has(character));
    if (characters.some(refused)) {
      return { status: 'refused', reason: multiline ? 'control_character' : 'line_break' };
    }
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    element.focus();
    if (document.activeElement !== element) {
      return { status: 'refused', reason: 'changed' };
    }
    // What is in the field is replaced by the keystrokes: the caller selects it all with a real key press first.
    return armGuard({ element, mode: 'keys' })
      ? { status: 'keys', multiline, clear: element.value !== '' }
      : { status: 'refused', reason: 'unchecked' };
  }
  if (element.tagName !== 'SELECT') {
    return { status: 'refused', reason: 'no_such_option' };
  }
  const picked = Array.from(element.options).find(
    candidate => candidate.value === option || candidate.label.trim() === option || candidate.text.trim() === option,
  );
  if (picked === undefined || picked.disabled) {
    return { status: 'refused', reason: 'no_such_option' };
  }
  pickOption(element, picked.value);
  return { status: 'done' };
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
