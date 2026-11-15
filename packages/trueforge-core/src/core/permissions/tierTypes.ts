import type { CaldavEventReview } from '../calendar/caldav/eventReview';
import type { CalendarWriteReview } from '../calendar/eventWrite';
import type { DriveWriteReview } from '../drive/writeReview';
import type { ReviewableDraft } from '../email/gmail/draftReview';
import type { AnsweredMessage } from '../email/gmail/replyThread';
import type { MailForwardReview } from '../email/mailConnector/forwardReview';
import type { BrowserElementReview, DocumentScope, MapsHosts } from '../llm/LLMTypes';
import type { SentinelCallIdentity, SentinelServices } from './context';
import type { Tier3Persona, Tier3Schedule, Tier3Skill } from './tier';
import type { FileDigest, PathMissing, PathResolution } from './trackedExecutables';
import type { WebSearchTurnState } from './webSearch';

/** The call the classifier judges, with every fact the host settled before asking. */
export interface SentinelAction {
  /** Original tool name (sandbox name or mcp server tool name). */
  tool_name: string;
  /** The exact arguments the server will act on. */
  canonical_params: Record<string, unknown>;
  /** 'truefoundry-system' for sandbox and other built-in tools, 'mcp' for MCP tools. */
  tool_type: 'truefoundry-system' | 'mcp';
  /** Sandbox command effect when the action ran through the sandbox effect layer. */
  sandbox_effect?: string | undefined;
  /** Connector serving an MCP tool; keys the user's standing tool grants. */
  mcp_server_name?: string | undefined;
  /** Connector's server id; with `mcp_server_host` it is bound into the approval token. */
  mcp_server_id?: string | undefined;
  /** Host of the connector's configured server URL, for the approval card. Never derived from tool arguments. */
  mcp_server_host?: string | undefined;
  /** What a standing grant on this connector binds to (see `ToolGrantKey`). Set by the host, never from tool arguments. */
  mcp_grant_binding?: string | undefined;
  /** The host provisioned this connector itself. Never derived from tool metadata or client input. */
  mcp_first_party?: boolean | undefined;
  /** The CalDAV event a change names, read once before classifying. Set only for the CalDAV connector. */
  caldav_event?: CaldavEventReview | null | undefined;
  /** The message an Email forward sends on, read once before classifying. Set only for the Email connector. */
  mail_forward?: MailForwardReview | null | undefined;
  /** The user designated this connector as their search provider. Set by the host from the connector record only. */
  mcp_search_provider?: boolean | undefined;
  /** The host's own list for the designated provider names this tool as a search tool. Never from tool metadata. */
  mcp_search_tool?: boolean | undefined;
  /** Top-level argument names the catalog declares as the designated provider's plumbing (session id, model name). Never from tool metadata. */
  mcp_search_plumbing_fields?: readonly string[] | undefined;
  mcp_hints: {
    read_only_hint?: boolean | undefined;
    destructive_hint?: boolean | undefined;
    open_world_hint?: boolean | undefined;
  };
  /**
   * Configured maps upstream hosts for the approval card destination. Set by the
   * server-owned maps tool from server config, never from model params.
   */
  maps_hosts?: MapsHosts | undefined;
  /**
   * Host-derived folders the document reader may read without asking: the staged uploads
   * directory and the bound project folder. Set by the documents tool set from the sandbox
   * and the session binding, never from model params.
   */
  document_scope?: DocumentScope | undefined;
  /**
   * The message a Gmail write would send or save, as the host holds it. Set by the Gmail tool set from a live
   * read and the validated call, so the card shows what would really go out.
   */
  mail_draft?: ReviewableDraft | undefined;
  /** For a draft change: the saved draft it replaces, as Gmail holds it now. */
  mail_replaces?: ReviewableDraft | undefined;
  /** For a reply: the message in its own thread that it answers, read by the host from Gmail. */
  mail_reply_in_thread?: AnsweredMessage | undefined;
  /**
   * The event a Calendar write would add or change, settled by the Calendar tool set from the validated call and,
   * for a change, the event as Google holds it now, so the card shows what would really be written.
   */
  calendar_write?: CalendarWriteReview | undefined;
  /**
   * The Drive write a create or append would make, settled by the Drive tool set from the validated call and,
   * for an append, the spreadsheet as Google holds it now, so the card shows what would really be written.
   */
  drive_write?: DriveWriteReview | undefined;
  /** The schedule a create or delete would save or remove, settled by the schedule tool set from the store. */
  schedule_write?: Tier3Schedule | undefined;
  /** The persona a create would add, settled by the persona tool set from the request and the owner's personas. */
  persona_write?: Tier3Persona | undefined;
  /** The skill an install would add, settled by the skill tool set from the place the skill comes from. */
  skill_install?: Tier3Skill | undefined;
  /** The schedule a pause or resume would change, settled by the schedule tool set from the store. */
  schedule_status?: ScheduleStatusReview | undefined;
  /**
   * The reminder a set or cancel call touches, settled by the schedule tool set: the activity line of a set and
   * the card of a cancel read it, never the model's words.
   */
  reminder?: ReminderLine | undefined;
  /**
   * Context for the element a browser click, type or select acts on, read from the live page first:
   * the site, its name and role, whether it submits a form, the form's values, and its address when it
   * is a plain link. Set by the browser tool set from the sidecar's read, never from model params.
   * Undefined when the host could not read it, which refuses the call before any card.
   */
  browser_element?: BrowserElementReview | undefined;
}

/** What a pause or resume card shows: which schedule, and when it runs, as the store holds it. */
export interface ScheduleStatusReview {
  action: 'pause' | 'resume';
  name: string;
  when: string;
  time_zone: string;
}

/** What is shown about one reminder: when it is due in plain words, and what it says. */
export interface ReminderLine {
  when: string | null;
  what: string | null;
}

export interface ClassifyContext extends SentinelCallIdentity {
  services: SentinelServices;
  /** Host state for the turn's silent web searches. */
  web_search: WebSearchTurnState;
  /** How this call's paths are resolved; set by the sandbox provider. Absent means the server's own filesystem. */
  path_resolution?: PathResolution | undefined;
  /** Reads file digests from a remote sandbox, so approvals can bind to file content there too. */
  file_digest?: FileDigest | undefined;
  /** Asks a remote sandbox whether a path is free, so a write that only creates a file can be told from an edit. */
  path_missing?: PathMissing | undefined;
  /** `none` when nothing run in the calling sandbox can reach a network; set by the sandbox provider. Absent means it may. */
  sandbox_network?: 'none' | undefined;
}
