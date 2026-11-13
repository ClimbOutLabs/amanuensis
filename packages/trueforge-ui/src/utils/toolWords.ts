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
  ...words(
    {
      doing: 'Checking your Google connection',
      done: 'Checked your Google connection',
      thing: 'Your Google connection',
    },
    ['google_setup_status', 'google_setup_read'],
  ),
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
  ...words(
    { doing: 'Checking your Google Drive files', done: 'Read your Google Drive files', thing: 'Your Drive files' },
    ['list_files', 'read_drive_file', 'google_drive_read'],
  ),
  ...words(
    {
      doing: 'Changing your Google Drive files',
      done: 'Changed your Google Drive files',
      thing: 'A Google Drive change',
    },
    ['create_doc', 'append_rows', 'google_drive_write'],
  ),
  ...words({ doing: 'Searching your notes', done: 'Searched your notes', thing: 'A notes search' }, [
    'search_notes',
    'notes_read',
  ]),
  ...words({ doing: 'Reading a note', done: 'Read note', thing: 'A note' }, ['read_note']),
  ...words({ doing: 'Adding to your notes inbox', done: 'Added to your notes inbox', thing: 'A notes inbox entry' }, [
    'append_to_inbox',
    'notes_write',
  ]),
  ...words({ doing: 'Making a note', done: 'Made a note', thing: 'A new note' }, ['create_note']),
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
    'edit_space',
    'replace_text',
    'revert_space',
    'space_write',
  ]),
  ...words({ doing: 'Moving a space to a folder', done: 'Moved a space to a folder', thing: 'A space move' }, [
    'move_space',
  ]),
  ...words({ doing: 'Setting a reminder', done: 'Set a reminder', thing: 'A reminder' }, ['set_reminder']),
  ...words({ doing: 'Sending you a notice', done: 'Sent you a notice', thing: 'A notice for you' }, [
    'delivery.created',
  ]),
  ...words(
    {
      doing: 'Sending a notice to your device',
      done: 'Sent a notice to your device',
      thing: 'A notice to your device',
    },
    ['delivery.web_push'],
  ),
  ...words({ doing: 'Sending you a text', done: 'Sent you a text', thing: 'A text for you' }, ['delivery.sms']),
  ...words({ doing: 'Calling you', done: 'Called you', thing: 'A phone call to you' }, ['delivery.call']),
  ...words({ doing: 'Turning texts off', done: 'Turned texts off after a STOP', thing: 'A STOP reply' }, [
    'delivery.sms_stop',
  ]),
  ...words(
    {
      doing: 'Dropping a new number',
      done: 'Dropped a new number after a STOP',
      thing: 'A STOP from a new number',
    },
    ['delivery.sms_new_number_stopped'],
  ),
  ...words(
    { doing: 'Confirming your number', done: 'Confirmed your number for texts', thing: 'Your number for texts' },
    ['delivery.sms_confirmed'],
  ),
  ...words({ doing: 'Removing your number', done: 'Removed your number for texts', thing: 'Your number for texts' }, [
    'delivery.sms_removed',
  ]),
  ...words({ doing: 'Checking your reminders', done: 'Checked your reminders', thing: 'Your reminders' }, [
    'list_reminders',
  ]),
  ...words({ doing: 'Cancelling a reminder', done: 'Cancelled a reminder', thing: 'A reminder' }, ['cancel_reminder']),
  ...words({ doing: 'Checking your schedules', done: 'Checked a schedule', thing: 'Your schedules' }, [
    'list_schedules',
    'schedule_read',
  ]),
  ...words({ doing: 'Creating a schedule', done: 'Created a schedule', thing: 'A new schedule' }, ['create_schedule']),
  ...words({ doing: 'Deleting a schedule', done: 'Deleted a schedule', thing: 'A schedule to delete' }, [
    'delete_schedule',
  ]),
  ...words({ doing: 'Changing a schedule', done: 'Changed a schedule', thing: 'A schedule change' }, [
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
  ...words({ doing: 'Checking the skills', done: 'Checked the skills', thing: 'The skills' }, [
    'list_skills',
    'skill_read',
  ]),
  ...words({ doing: 'Adding a skill', done: 'Added a skill', thing: 'A new skill' }, ['install_skill']),
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
