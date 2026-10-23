import type { InternalToolCallInfo } from '../../../src/core/llm/LLMTypes';
import type { TurnStepKind } from '../../../src/core/mcp/executeToolCalls';
import { findUnbackedClaim, stepKindsOf } from '../../../src/core/runtime/replyActionChecks';

function check(
  text: string,
  input: { successfulWrites?: number; stepKinds?: TurnStepKind[]; sandboxOn?: boolean } = {},
) {
  return findUnbackedClaim({
    text,
    successfulWrites: input.successfulWrites ?? 0,
    stepKinds: new Set(input.stepKinds ?? []),
    sandboxOn: input.sandboxOn ?? false,
  });
}

function info(input: { server: string; tool: string; readOnly?: boolean }): InternalToolCallInfo {
  return {
    type: input.server === 'sandbox' ? 'truefoundry-system' : 'mcp',
    mcp_server_id: input.server,
    mcp_server_name: input.server,
    original_tool_name: input.tool,
    ...(input.readOnly === true ? { read_only_hint: true } : {}),
  };
}

describe('findUnbackedClaim', () => {
  it('flags the clone repro: no sandbox, only a bundle load and the clock ran', () => {
    const reply =
      "I've cloned the lanternworks/tide-tables repository into your workspace. It has three folders: src, docs and scripts.";
    const stepKinds = [
      ...stepKindsOf(info({ server: 'host', tool: 'load_bundle', readOnly: true })),
      ...stepKindsOf(info({ server: 'clock', tool: 'get_current_datetime', readOnly: true })),
    ];
    expect(stepKinds).toEqual([]);
    expect(check(reply, { stepKinds, sandboxOn: false })).toBe('clone');
  });

  it.each([
    ['clone', 'I cloned the repo for you.'],
    ['clone', 'I have just downloaded the spreadsheet.'],
    ['clone', 'The repository has been cloned.'],
    ['clone', 'The archive was downloaded and unpacked.'],
    ['clone', "I've checked out the main branch."],
    ['run', 'I ran the test suite and all 42 tests passed.'],
    ['run', "I've executed the script."],
    ['run', 'The migration has been run.'],
    ['run', 'The build was executed without errors.'],
    ['read', 'I read the README and it covers setup.'],
    ['read', 'I looked at the config file and found two problems.'],
    ['read', "I've opened the report."],
    ['read', 'The file was opened and checked.'],
    ['workspace', 'Your notes file is now in your workspace.'],
    ['workspace', 'Everything is in the sandbox, ready to use.'],
    ['workspace', 'The project is checked out.'],
    ['change', "Done, I've set a 9:10 reminder."],
    ['change', 'The invite has been sent.'],
  ])('flags a %s claim: "%s"', (kind, text) => {
    expect(check(text)).toBe(kind);
  });

  it('does not flag a clone once a sandbox or git step ran', () => {
    const reply = "I've cloned the lanternworks/tide-tables repository into your workspace.";
    expect(check(reply, { stepKinds: ['sandbox', 'command', 'read'], sandboxOn: true })).toBeUndefined();
    expect(check('I cloned the repo.', { stepKinds: ['git'] })).toBeUndefined();
  });

  it('does not flag a run once a sandbox command ran', () => {
    expect(check('I ran the tests and they passed.', { stepKinds: ['command'], sandboxOn: true })).toBeUndefined();
  });

  it('does not flag a read once a read tool ran', () => {
    expect(check('I looked at the page and it lists three prices.', { stepKinds: ['read'] })).toBeUndefined();
  });

  it('does not flag a change once a write ran', () => {
    expect(check("Done, I've set a 9:10 reminder.", { successfulWrites: 1 })).toBeUndefined();
  });

  it('leaves workspace claims alone with the sandbox on', () => {
    expect(check('Your notes file is now in your workspace.', { sandboxOn: true })).toBeUndefined();
  });

  it('still flags a run when only a sandbox file write ran', () => {
    expect(check('I ran the script.', { stepKinds: ['sandbox'], sandboxOn: true })).toBe('run');
  });

  it.each([
    'I can clone it if you turn on the sandbox.',
    'I can clone it into your workspace if you turn on the sandbox.',
    "Once it is in your workspace, I'll read the README.",
    'Would you like me to run the tests?',
    "I haven't cloned anything yet.",
    'No repository was cloned, because code execution is off.',
    'I ran into a problem: the page did not load.',
    'I read that as a request for next week.',
    'Here is the list of events for Tuesday.',
    "I haven't set anything up yet.",
    'Would you like me to set a reminder?',
    'Your reminder is at 9:10.',
    'The meeting was moved to Thursday.',
  ])('leaves "%s" alone', text => {
    expect(check(text)).toBeUndefined();
  });
});

describe('stepKindsOf', () => {
  it('counts sandbox commands as commands that can also read', () => {
    expect(stepKindsOf(info({ server: 'sandbox', tool: 'exec' }))).toEqual(['sandbox', 'command', 'read']);
    expect(stepKindsOf(info({ server: 'sandbox', tool: 'run_code' }))).toEqual(['sandbox', 'command', 'read']);
  });

  it('counts a sandbox file write as a sandbox step only', () => {
    expect(stepKindsOf(info({ server: 'sandbox', tool: 'write_file' }))).toEqual(['sandbox']);
  });

  it('counts read-only connector reads, and git tools as git steps', () => {
    expect(stepKindsOf(info({ server: 'drive', tool: 'read_file', readOnly: true }))).toEqual(['read']);
    expect(stepKindsOf(info({ server: 'github', tool: 'get_file_contents', readOnly: true }))).toEqual(['read']);
    expect(stepKindsOf(info({ server: 'github', tool: 'clone_repository' }))).toEqual(['git']);
  });

  it('does not count the clock or a bundle load as a read', () => {
    expect(stepKindsOf(info({ server: 'clock', tool: 'get_current_datetime', readOnly: true }))).toEqual([]);
    expect(stepKindsOf(info({ server: 'host', tool: 'load_bundle', readOnly: true }))).toEqual([]);
  });
});
