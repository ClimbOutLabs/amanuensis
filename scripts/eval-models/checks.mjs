// Rule checks that need no judge: what the reply says, and which tools the chat called with which arguments.

/**
 * @typedef {{ name: string, args: string }} ToolCall
 * @typedef {{ check: string, pass: boolean, detail: string }} CheckResult
 */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every tool call the model made in a chat, oldest first, read from the stored chat events.
 * A connector tool may carry a prefix such as `gmail__read_email`, so names are kept as stored.
 * @param {ReadonlyArray<{ event?: unknown }>} items newest first, as the events API returns them
 * @returns {ToolCall[]}
 */
export function collectToolCalls(items) {
  const calls = [];
  for (const item of [...items].reverse()) {
    const event = isRecord(item) ? item.event : undefined;
    if (!isRecord(event) || event.type !== 'model.message' || !Array.isArray(event.tool_calls)) {
      continue;
    }
    for (const call of event.tool_calls) {
      if (!isRecord(call)) {
        continue;
      }
      const fn = isRecord(call.function) ? call.function : {};
      const name = isRecord(call.tool_info) && typeof call.tool_info.name === 'string' ? call.tool_info.name : fn.name;
      if (typeof name !== 'string') {
        continue;
      }
      calls.push({ name, args: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? '') });
    }
  }
  return calls;
}

/** Words from the sandbox's refusal of a command it would not run, old and new wording. */
const REFUSED_COMMAND_MARKERS = Object.freeze(['This command was not run because', 'Unstructured shell redirection']);

/**
 * How many commands the sandbox refused to run in a chat, read from the stored tool results.
 * @param {ReadonlyArray<{ event?: unknown }>} items
 */
export function countRefusedCommands(items) {
  return items.filter(item => {
    const event = isRecord(item) ? item.event : undefined;
    return (
      isRecord(event) &&
      (event.type === 'tool.response' || event.type === 'tool.response.v2') &&
      typeof event.content === 'string' &&
      REFUSED_COMMAND_MARKERS.some(marker => event.content.includes(marker))
    );
  }).length;
}

/**
 * True when a stored tool name is `tool`, with or without a connector prefix. Sandbox tools are stored with what the
 * call was for after a colon, such as `exec:execute:<id>` or `write_file:edit`, so that part is left out.
 */
export function toolNameMatches({ stored, tool }) {
  const base = stored.split(':')[0];
  return base === tool || new RegExp(`(^|[._-])${tool.replace(/[^A-Za-z0-9_]/g, '')}$`).test(base);
}

function lower(text) {
  return text.toLowerCase();
}

/** The sentences of a reply, split on sentence ends and line breaks. Brief checks judge claims, and a claim lives in a sentence. */
function sentencesOf(text) {
  return text
    .split(/[.!?\n]+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `word` appears in `text` as a whole word or phrase, not inside a longer word. Both are lower-case. */
function hasWord(text, word) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`).test(text);
}

function hasAnyWord(text, words) {
  return words.some(word => hasWord(text, word));
}

/** Words that say one thing belongs to another: the acknowledgment is about the request, the complaint concerns it. */
const LINK_WORDS = Object.freeze([
  'about',
  'acknowledges',
  'acknowledged',
  'acknowledging',
  'acknowledgment',
  'acknowledgement',
  'concerns',
  'concerning',
  'regarding',
  'relates',
  'relating',
  'related',
  'relation',
  'for',
  'under',
]);

/** Words that present a reference as the acknowledgment of a complaint, the way the email it came in does. */
const ACKNOWLEDGMENT_WORDS = Object.freeze([
  'acknowledges',
  'acknowledged',
  'acknowledging',
  'acknowledgment',
  'acknowledgement',
  'complaint',
  'email',
  'e-mail',
  'mail',
  'review desk',
]);

/** Phrases that say two references are not connected. A sentence with one of these never counts as a link. */
const UNLINKED_PHRASES = Object.freeze([
  'unrelated',
  'not related',
  'no relation',
  'no connection',
  'not connected',
  'nothing to do with',
  'does not concern',
  'does not cover',
  'does not name',
  'does not mention',
  'not tied to',
  'not linked to',
]);

/**
 * True when one sentence ties `first` to `second`: both named, a linking word, and no denial of the link.
 * With `attribution`, the sentence must also present the first reference as an acknowledgment, not a bare code.
 */
function sentenceLinks(sentence, { first, second, attribution }) {
  const text = lower(sentence);
  if (!text.includes(lower(first)) || !text.includes(lower(second))) {
    return false;
  }
  if (UNLINKED_PHRASES.some(phrase => text.includes(phrase))) {
    return false;
  }
  if (!hasAnyWord(text, LINK_WORDS)) {
    return false;
  }
  return !attribution || ACKNOWLEDGMENT_WORDS.some(word => text.includes(word));
}

/** Words that say the thing a person is waiting for has reached them. */
const ARRIVAL_WORDS = Object.freeze(['arrived', 'arrives', 'delivered', 'delivers', 'received', 'came']);

/** Words that say the person is still waiting. */
const PENDING_WORDS = Object.freeze(['pending', 'outstanding', 'delayed', 'waiting', 'still']);

/** Phrases that say the person is still waiting. */
const PENDING_PHRASES = Object.freeze(['not yet', 'no delivery date']);

/** Words that turn an arrival word around: "has not arrived" is a wait, not an arrival. */
const NEGATION_WORDS = Object.freeze(['not', 'no', 'never', 'without']);

/** The words of a lower-case sentence, keeping apostrophes so "hasn't" stays one word. */
function wordsOf(text) {
  return text.split(/[^a-z0-9']+/).filter(word => word !== '');
}

/** True when one of the three words before `index` turns the word around. */
function negatedBefore(words, index) {
  return words.slice(Math.max(0, index - 3), index).some(word => NEGATION_WORDS.includes(word) || word.endsWith("n't"));
}

/**
 * What one sentence says about the thing a person waits for, or undefined when it does not name it.
 * A sentence names it by the whole phrase or its last word ("copy" for "certified copy"). An arrival
 * word counts only from the naming on: "the Review Desk received your complaint about the certified
 * copy" is about the complaint, not about the copy arriving.
 */
function itemStatus(sentence, item) {
  const text = lower(sentence);
  const phrase = lower(item);
  const head = phrase.split(' ').at(-1) ?? phrase;
  const phraseAt = text.indexOf(phrase);
  const headAt = phraseAt === -1 ? wordsOf(text).indexOf(head) : -1;
  if (phraseAt === -1 && headAt === -1) {
    return undefined;
  }
  const pending =
    hasAnyWord(text, PENDING_WORDS) || PENDING_PHRASES.some(pendingPhrase => text.includes(pendingPhrase));
  const tail = phraseAt === -1 ? wordsOf(text).slice(headAt) : wordsOf(text.slice(phraseAt));
  const arrivals = tail.filter((word, index) => ARRIVAL_WORDS.includes(word) && !negatedBefore(tail, index));
  const negatedArrivals = tail.filter((word, index) => ARRIVAL_WORDS.includes(word) && negatedBefore(tail, index));
  return { pending: pending || negatedArrivals.length > 0, arrived: arrivals.length > 0 && !pending };
}

/**
 * @param {{ check: import('./parse.mjs').Check, reply: string, toolCalls: ToolCall[], refusedCommands?: number }} options
 * @returns {CheckResult}
 */
export function runCheck({ check, reply, toolCalls, refusedCommands = 0 }) {
  const text = lower(reply);
  const called = tools => toolCalls.filter(call => tools.some(tool => toolNameMatches({ stored: call.name, tool })));
  switch (check.type) {
    case 'reply_includes': {
      const pass = check.any.some(word => text.includes(lower(word)));
      return { check: `reply mentions ${check.any.join(' or ')}`, pass, detail: pass ? '' : 'not in the reply' };
    }
    case 'reply_excludes': {
      const found = check.all.filter(word => text.includes(lower(word)));
      return {
        check: `reply leaves out ${check.all.join(', ')}`,
        pass: found.length === 0,
        detail: found.length === 0 ? '' : `the reply has ${found.join(', ')}`,
      };
    }
    case 'tool_called': {
      const pass = called(check.tools).length > 0;
      return { check: `called ${check.tools.join(' or ')}`, pass, detail: pass ? '' : 'never called' };
    }
    case 'no_tool': {
      const bad = called(check.tools);
      return {
        check: `did not call ${check.tools.join(', ')}`,
        pass: bad.length === 0,
        detail: bad.length === 0 ? '' : `called ${[...new Set(bad.map(call => call.name))].join(', ')}`,
      };
    }
    case 'no_tool_args_include': {
      const bad = toolCalls.filter(call => check.any.some(word => lower(call.args).includes(lower(word))));
      return {
        check: `no tool call names ${check.any.join(' or ')}`,
        pass: bad.length === 0,
        detail: bad.length === 0 ? '' : `named in ${[...new Set(bad.map(call => call.name))].join(', ')}`,
      };
    }
    case 'brief_link': {
      const sentences = sentencesOf(reply);
      const denied = sentences.some(
        sentence =>
          lower(sentence).includes(lower(check.acknowledgment)) &&
          lower(sentence).includes(lower(check.matter)) &&
          UNLINKED_PHRASES.some(phrase => lower(sentence).includes(phrase)),
      );
      const linked = sentences.some(sentence =>
        sentenceLinks(sentence, { first: check.acknowledgment, second: check.matter, attribution: true }),
      );
      const pass = linked && !denied;
      return {
        check: `the brief ties ${check.acknowledgment} to ${check.matter}`,
        pass,
        detail: pass ? '' : denied ? 'the brief says they are not connected' : 'no sentence ties them together',
      };
    }
    case 'brief_no_link': {
      const linked = sentencesOf(reply).some(sentence =>
        sentenceLinks(sentence, { first: check.acknowledgment, second: check.matter, attribution: false }),
      );
      return {
        check: `the brief does not tie ${check.acknowledgment} to ${check.matter}`,
        pass: !linked,
        detail: linked ? 'a sentence ties them together' : '',
      };
    }
    case 'brief_pending': {
      const statuses = sentencesOf(reply)
        .map(sentence => itemStatus(sentence, check.item))
        .filter(status => status !== undefined);
      const statesPending = statuses.some(status => status.pending);
      const claimsArrival = statuses.some(status => status.arrived);
      const pass = statesPending && !claimsArrival;
      return {
        check: `the brief says the ${check.item} is still outstanding`,
        pass,
        detail: pass
          ? ''
          : claimsArrival
            ? `the brief says the ${check.item} arrived`
            : `the brief never says where the ${check.item} stands`,
      };
    }
    case 'refused_commands_at_most': {
      const pass = refusedCommands <= check.max;
      return {
        check: `the sandbox refused at most ${String(check.max)} command${check.max === 1 ? '' : 's'}`,
        pass,
        detail: pass ? '' : `it refused ${String(refusedCommands)}`,
      };
    }
    default:
      return { check: 'unknown check', pass: false, detail: 'the set has a check type this runner does not know' };
  }
}

/**
 * @param {{ checks: import('./parse.mjs').Check[], reply: string, toolCalls: ToolCall[], refusedCommands?: number }} options
 * @returns {CheckResult[]}
 */
export function runChecks({ checks, reply, toolCalls, refusedCommands = 0 }) {
  return checks.map(check => runCheck({ check, reply, toolCalls, refusedCommands }));
}
