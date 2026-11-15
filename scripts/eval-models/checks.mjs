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

/** True when a stored tool name is `tool`, with or without a connector prefix. */
export function toolNameMatches({ stored, tool }) {
  return stored === tool || new RegExp(`(^|[._-])${tool.replace(/[^A-Za-z0-9_]/g, '')}$`).test(stored);
}

function lower(text) {
  return text.toLowerCase();
}

/**
 * @param {{ check: import('./parse.mjs').Check, reply: string, toolCalls: ToolCall[] }} options
 * @returns {CheckResult}
 */
export function runCheck({ check, reply, toolCalls }) {
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
    default:
      return { check: 'unknown check', pass: false, detail: 'the set has a check type this runner does not know' };
  }
}

/**
 * @param {{ checks: import('./parse.mjs').Check[], reply: string, toolCalls: ToolCall[] }} options
 * @returns {CheckResult[]}
 */
export function runChecks({ checks, reply, toolCalls }) {
  return checks.map(check => runCheck({ check, reply, toolCalls }));
}
