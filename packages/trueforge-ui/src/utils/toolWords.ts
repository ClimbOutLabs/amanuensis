/**
 * The one owner of the plain words for a tool: what it reads as while it runs ("Reading your email"),
 * once it is done ("Read your email"), and when it did not run ("Your email"). Keyed by the tool name the runtime and the server record;
 * the older action kinds stay so earlier audit rows still read well. A raw tool name is never shown.
 */
type ToolWords = {
  doing: string;
  done: string;
  /** What the step is, for one that did not run: never reads as underway or finished. */
  thing: string;
};

function words(toolWords: ToolWords, toolNames: readonly string[]): [string, ToolWords][] {
  return toolNames.map(toolName => [toolName, toolWords]);
}

const TOOL_WORDS: ReadonlyMap<string, ToolWords> = new Map([
  ...words({ doing: 'Reading your email', done: 'Read your email', thing: 'Your email' }, [
    'read_email',
    'get_thread',
    'list_inbox_threads',
    'get_inbox_with_threads',
    'list_emails_metadata',
    'get_attachment_content',
    'download_attachment',
    'list_drafts',
    'get_draft',
    'gmail_read',
  ]),
  ...words({ doing: 'Searching your email', done: 'Read your email', thing: 'An email search' }, ['search_emails']),
  ...words({ doing: 'Drafting an email', done: 'Saved a draft', thing: 'An email draft' }, [
    'draft_email',
    'update_draft',
    'gmail_draft',
  ]),
  ...words({ doing: 'Sending an email', done: 'Sent an email', thing: 'An email' }, ['send_draft', 'gmail_send']),
  ...words({ doing: 'Checking your calendar', done: 'Read your calendar', thing: 'Your calendar' }, [
    'list_events',
    'get_event',
    'calendar_read',
  ]),
  ...words({ doing: 'Changing your calendar', done: 'Changed your calendar', thing: 'A calendar change' }, [
    'create_event',
    'update_event',
    'calendar_write',
  ]),
  ...words({ doing: 'Searching the web', done: 'Searched the web', thing: 'A web search' }, [
    'tavily_search',
    'web_search',
    'search',
    'google_search',
    'brave_search',
  ]),
  ...words({ doing: 'Reading a web page', done: 'Read a web page', thing: 'A web page' }, ['tavily_extract']),
  ...words({ doing: 'Looking up a map', done: 'Looked up a map', thing: 'A map' }, ['render_map']),
  ...words({ doing: 'Planning a route', done: 'Planned a route', thing: 'A route' }, ['render_route']),
  ...words({ doing: 'Looking up places', done: 'Looked up places', thing: 'A places search' }, ['render_places']),
  ...words({ doing: 'Checking the weather', done: 'Checked the weather', thing: 'The weather' }, ['get_weather']),
  ...words({ doing: 'Running a command', done: 'Ran a command', thing: 'A command' }, [
    'exec',
    'sandbox_exec',
    'sandbox_command',
    'run_command',
    'shell',
    'run_registered_command',
  ]),
  ...words({ doing: 'Running code', done: 'Ran code', thing: 'Some code' }, ['run_code']),
  ...words({ doing: 'Reading', done: 'Read files', thing: 'Some files' }, ['read_file', 'read', 'open_file', 'cat']),
  ...words({ doing: 'Editing files', done: 'Changed files', thing: 'A file change' }, [
    'write_file',
    'apply_patch',
    'edit_file',
  ]),
  ...words({ doing: 'Reading a space', done: 'Read a space', thing: 'A space' }, [
    'get_space',
    'list_spaces',
    'list_blocks',
    'space_read',
  ]),
  ...words({ doing: 'Making a space', done: 'Changed a space', thing: 'A new space' }, ['create_space']),
  ...words({ doing: 'Updating the space', done: 'Changed a space', thing: 'A space change' }, [
    'update_space',
    'replace_text',
    'revert_space',
    'space_write',
  ]),
  ...words({ doing: 'Checking your schedules', done: 'Checked a schedule', thing: 'Your schedules' }, [
    'list_schedules',
    'schedule_read',
  ]),
  ...words({ doing: 'Changing a schedule', done: 'Changed a schedule', thing: 'A schedule change' }, [
    'create_schedule',
    'delete_schedule',
    'pause_schedule',
    'resume_schedule',
    'schedule_write',
  ]),
  ...words({ doing: 'Checking the personas', done: 'Checked a persona', thing: 'The personas' }, [
    'list_personas',
    'persona_read',
  ]),
  ...words({ doing: 'Switching persona', done: 'Switched persona', thing: 'A persona switch' }, [
    'use_persona',
    'persona_switch',
  ]),
  ...words({ doing: 'Making a persona', done: 'Made a persona', thing: 'A new persona' }, ['create_persona']),
  ...words({ doing: 'Showing a picture', done: 'Showed a picture', thing: 'A picture' }, ['show_image']),
  ...words({ doing: 'Making a report', done: 'Made a report', thing: 'A report' }, ['create_document_report']),
  ...words({ doing: 'Making a plan', done: 'Made a plan', thing: 'A plan' }, ['submit_implementation_plan']),
  ...words({ doing: 'Consulting a helper', done: 'Consulted a helper', thing: 'A helper' }, ['create_sub_agent']),
  ...words({ doing: 'Asking a question', done: 'Asked a question', thing: 'A question' }, ['ask_user_question']),
]);

/** Used for a tool the table does not know yet, so a new tool never shows its raw name. */
export const TOOL_DONE_FALLBACK = 'Used a connected app';

/** What a tool reads as while it runs, or undefined when the table does not know it. */
export function toolDoingWords(toolName: string): string | undefined {
  return TOOL_WORDS.get(toolName)?.doing;
}

/** What a finished tool reads as; a tool the table does not know reads as the plain fallback. */
export function toolDoneWords(toolName: string): string {
  return TOOL_WORDS.get(toolName)?.done ?? TOOL_DONE_FALLBACK;
}

/** Names longer than this are cut, whatever the model put in a tool name. */
const MAX_TOOL_LABEL_CHARS = 64;

/** Tidies a tool name the table does not know, without inventing meaning: `list_dir` reads as `List dir`. */
export function humanizeToolName(toolName: string): string {
  const lastSegment = toolName.split('__').pop() ?? toolName;
  const plain = lastSegment.replace(/[_-]+/g, ' ').trim();
  if (!plain) return 'Working';
  const titled = plain.charAt(0).toUpperCase() + plain.slice(1);
  return titled.length > MAX_TOOL_LABEL_CHARS ? `${titled.slice(0, MAX_TOOL_LABEL_CHARS - 1).trimEnd()}…` : titled;
}

export type ToolStepState = 'running' | 'done' | 'not_done';

/**
 * A step's title in plain words: what it is doing while it runs, what it did once done, and only what
 * it is when it did not run, so a refused step never reads as done.
 */
export function toolStepTitle({ toolName, state }: { toolName: string; state: ToolStepState }): string {
  const known = TOOL_WORDS.get(toolName);
  if (known === undefined) return humanizeToolName(toolName);
  if (state === 'running') return known.doing;
  return state === 'done' ? known.done : known.thing;
}
