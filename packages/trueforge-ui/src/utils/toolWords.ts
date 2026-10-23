/**
 * The one owner of the plain words for a tool: what it reads as while it runs ("Reading your email")
 * and once it is done ("Read your email"). Keyed by the tool name the runtime and the server record;
 * the older action kinds stay so earlier audit rows still read well. A raw tool name is never shown.
 */
type ToolWords = { doing: string; done: string };

function words(doing: string, done: string, toolNames: readonly string[]): [string, ToolWords][] {
  return toolNames.map(toolName => [toolName, { doing, done }]);
}

const TOOL_WORDS: ReadonlyMap<string, ToolWords> = new Map([
  ...words('Reading your email', 'Read your email', [
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
  ...words('Searching your email', 'Read your email', ['search_emails']),
  ...words('Drafting an email', 'Saved a draft', ['draft_email', 'update_draft', 'gmail_draft']),
  ...words('Sending an email', 'Sent an email', ['send_draft', 'gmail_send']),
  ...words('Checking your calendar', 'Read your calendar', ['list_events', 'get_event', 'calendar_read']),
  ...words('Changing your calendar', 'Changed your calendar', ['create_event', 'update_event', 'calendar_write']),
  ...words('Searching the web', 'Searched the web', [
    'tavily_search',
    'web_search',
    'search',
    'google_search',
    'brave_search',
  ]),
  ...words('Reading a web page', 'Read a web page', ['tavily_extract']),
  ...words('Looking up a map', 'Looked up a map', ['render_map']),
  ...words('Planning a route', 'Planned a route', ['render_route']),
  ...words('Looking up places', 'Looked up places', ['render_places']),
  ...words('Checking the weather', 'Checked the weather', ['get_weather']),
  ...words('Running a command', 'Ran a command', [
    'exec',
    'sandbox_exec',
    'sandbox_command',
    'run_command',
    'shell',
    'run_registered_command',
  ]),
  ...words('Running code', 'Ran code', ['run_code']),
  ...words('Reading', 'Read files', ['read_file', 'read', 'open_file', 'cat']),
  ...words('Editing files', 'Changed files', ['write_file', 'apply_patch', 'edit_file']),
  ...words('Reading a space', 'Read a space', ['get_space', 'list_spaces', 'list_blocks', 'space_read']),
  ...words('Making a space', 'Changed a space', ['create_space']),
  ...words('Updating the space', 'Changed a space', ['update_space', 'replace_text', 'revert_space', 'space_write']),
  ...words('Checking your schedules', 'Checked a schedule', ['list_schedules', 'schedule_read']),
  ...words('Changing a schedule', 'Changed a schedule', [
    'create_schedule',
    'delete_schedule',
    'pause_schedule',
    'resume_schedule',
    'schedule_write',
  ]),
  ...words('Checking the specialists', 'Checked a specialist', ['list_personas', 'persona_read']),
  ...words('Switching specialist', 'Switched specialist', ['use_persona', 'persona_switch']),
  ...words('Making a specialist', 'Made a specialist', ['create_persona']),
  ...words('Showing a picture', 'Showed a picture', ['show_image']),
  ...words('Making a report', 'Made a report', ['create_document_report']),
  ...words('Making a plan', 'Made a plan', ['submit_implementation_plan']),
  ...words('Consulting a helper', 'Consulted a helper', ['create_sub_agent']),
  ...words('Asking a question', 'Asked a question', ['ask_user_question']),
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

/** A step's title in plain words: what it is doing while it runs, what it did once done. */
export function toolStepTitle({ toolName, running }: { toolName: string; running: boolean }): string {
  const known = TOOL_WORDS.get(toolName);
  if (known === undefined) return humanizeToolName(toolName);
  return running ? known.doing : known.done;
}
