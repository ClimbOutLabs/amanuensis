// Runs inside the page (`page.evaluate`), so it may only use the DOM and plain JS: no imports, no
// Node globals. Walks the visible headings, text and controls of the page in reading order, each
// already tagged with the field kind that governs whether its value may be shown.

/**
 * A field's name and id as plain lowercase words: `otp_code`, `otpCode` and `otp-code` all read
 * `otp code`, so the patterns below match whatever naming style a site uses.
 */
function nameWords(element) {
  return `${element.getAttribute('name') ?? ''} ${element.id ?? ''}`
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Name words that mark a field as a password, a card number, or a one-time code. */
const CARD_WORDS = /\b(card ?(number|no|num)|cc ?(num|number|no)|cvv|cvc|csc|security ?code)\b/;
const CODE_WORDS =
  /\b(otp|totp|passcode|mpin|tpin|(one ?time|verification|mfa|2 ?fa|sms|otp) ?code|(atm|card|security|secret|upi|txn|transaction) ?pin)\b/;
/**
 * "pin" names a secret unless it is a place or a postal code: a "PIN code" or "pincode" is a postal
 * code in India, and a map pin is a place, so neither is hidden.
 */
const BARE_PIN = /\bpin\b(?! ?code)/;
const PLACE_WORDS = /\b(map|location|place|drop|postal|post|zip|address|shipping|billing)\b/;

/** Whether the field takes only digits, by its keyboard, its type or its pattern. */
function takesDigits(element) {
  const type = (element.getAttribute('type') ?? '').toLowerCase();
  const inputMode = (element.getAttribute('inputmode') ?? '').toLowerCase();
  const pattern = element.getAttribute('pattern') ?? '';
  return (
    inputMode === 'numeric' || type === 'tel' || type === 'number' || pattern.includes('0-9') || pattern.includes('\\d')
  );
}

/** How far up from a one-digit box to look for the others in its row. */
const DIGIT_ROW_LEVELS = 5;

/** Whether a field has a label of its own: a count such as "Adults" is labelled, a code's digit boxes are not. */
function hasOwnLabel(element) {
  const aria = element.getAttribute('aria-label') ?? '';
  const labels = element.labels === null ? [] : [...element.labels];
  return /[a-z]{3}/i.test(aria) || labels.some(label => /[a-z]{3}/i.test(label.textContent ?? ''));
}

/** A one-digit box with no label of its own. */
function isDigitBox(element) {
  return element.getAttribute('maxlength') === '1' && takesDigits(element) && !hasOwnLabel(element);
}

/** A box for one digit next to others like it, however deeply each is wrapped: a code typed one digit per box. */
function isCodeDigitBox(element) {
  if (!isDigitBox(element)) {
    return false;
  }
  let around = element.parentElement;
  for (let level = 0; around !== null && level < DIGIT_ROW_LEVELS; level += 1, around = around.parentElement) {
    if ([...around.querySelectorAll('input[maxlength="1"]')].filter(isDigitBox).length >= 2) {
      return true;
    }
  }
  return false;
}

function fieldKind(element) {
  const type = (element.getAttribute('type') ?? '').toLowerCase();
  const autocomplete = (element.getAttribute('autocomplete') ?? '').toLowerCase();
  const words = nameWords(element);
  if (type === 'password') {
    return 'password';
  }
  if (autocomplete.startsWith('cc-') || CARD_WORDS.test(words)) {
    return 'card';
  }
  if (autocomplete === 'one-time-code' || CODE_WORDS.test(words)) {
    return 'otp';
  }
  const postal = autocomplete === 'postal-code' || autocomplete.startsWith('address');
  if (BARE_PIN.test(words) && !PLACE_WORDS.test(words) && !postal) {
    return 'otp';
  }
  // Only the first box of a code typed one digit per box often says what it is.
  if (isCodeDigitBox(element)) {
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
  const type = (element.getAttribute('type') ?? '').toLowerCase();
  if (element.tagName === 'BUTTON') {
    return type === '' || type === 'submit';
  }
  return element.tagName === 'INPUT' && (type === 'submit' || type === 'image');
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
export function elementInfo(path) {
  const element = elementAtPath(path);
  if (element === null) {
    return null;
  }
  return {
    field_kind: fieldKind(element),
    is_form_submit: isFormSubmit(element),
    accessible_name: accessibleName(element),
    form_values: formValuesOf(element),
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

/**
 * Where each element of `paths` sits in the viewport, read without changing anything on the page.
 * Elements that are gone, empty or out of view are left out. The viewport size comes with them, so
 * the sidecar can turn page pixels into picture pixels.
 */
export function boxesInView(paths) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const boxes = [];
  for (const path of paths) {
    const element = elementAtPath(path);
    if (element === null) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (
      rect.width === 0 ||
      rect.height === 0 ||
      rect.bottom < 0 ||
      rect.top > height ||
      rect.right < 0 ||
      rect.left > width
    ) {
      continue;
    }
    boxes.push({ path, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  }
  return { width, height, boxes };
}

/** Elements that show another document, whose fields this page cannot read. */
const EMBED_TAGS = new Set(['IFRAME', 'FRAME', 'EMBED', 'OBJECT']);
const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * What the model's copy of a screenshot must cover, read without changing the page: every password,
 * card or one-time-code field in view, including those inside open shadow roots, and every frame or
 * embed in view whole, since a frame's own fields (a hosted card form) cannot be read from here.
 */
export function maskBoxes() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const boxes = [];
  const visit = root => {
    for (const element of root.querySelectorAll('*')) {
      const covered =
        EMBED_TAGS.has(element.tagName) || (FIELD_TAGS.has(element.tagName) && fieldKind(element) !== null);
      if (covered) {
        const rect = element.getBoundingClientRect();
        const inView =
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom >= 0 &&
          rect.top <= height &&
          rect.right >= 0 &&
          rect.left <= width;
        if (inView) {
          boxes.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
        }
      }
      if (element.shadowRoot !== null) {
        visit(element.shadowRoot);
      }
    }
  };
  visit(document);
  return { width, height, boxes };
}
