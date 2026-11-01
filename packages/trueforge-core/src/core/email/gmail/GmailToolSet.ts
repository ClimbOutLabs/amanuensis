import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MAX_BYTES_PER_DOCUMENT } from '../../../documents/documentExtraction';
import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../../documents/toolContract';
import { CHAT_IMAGE_INPUT_MIME_TYPES } from '../../chatImages';
import { InvalidFileInputError } from '../../errors';
import { GoogleApiError, GoogleOAuthError, GoogleReconnectRequiredError } from '../../google/errors';
import type { GoogleFeature } from '../../google/scopes';
import { errorResult, failureResult, jsonResult as neutralizedJsonResult } from '../../google/toolResults';
import type { InternalToolCallInfo } from '../../llm/LLMTypes';
import { toolResultResponse, type ToolInvocationContext } from '../../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../mcp/LocalToolMCP';
import { stampSentinelDecision } from '../../mcp/ToolSet';
import { classifyHostToolCall } from '../../permissions/classifier';
import type { SentinelHostContext } from '../../permissions/context';
import { DEMO_SEND_REFUSAL, recipientsAllowed } from '../../permissions/sendAllowlist';
import { assertAttachmentBatch } from '../../runtime/attachmentStaging';
import type { ToolBundleName } from '../../runtime/toolBundleCatalog';
import { SandboxFileUploadError, type SandboxInfo } from '../../sandbox/Sandbox';
import type { AgentTracing } from '../../tracing/AgentTracing';
import { assessDraft } from './draftAssessment';
import { hashDraft, type ReviewableDraft } from './draftReview';
import { mapSkippingMissing, type GmailApiPort } from './gmailApi';
import { decodeAttachmentData, type GmailMessage } from './gmailWire';
import { mailboxOf, nameLeftOff } from './mailbox';
import { headerOf, listAttachments, rawHeaderOf } from './message';
import { buildRawMessage, replyHeaders, replySubject, type RawDraftContent, type ReplyTarget } from './rawMessage';
import { answeredMessageOf, checkReplyThreading, isReply, type AnsweredMessage } from './replyThread';
import {
  getDraftResult,
  listDraftsResult,
  listThreadsResult,
  MAX_ATTACHMENTS_LISTED,
  readEmailResult,
  threadResult,
  UNTRUSTED_NOTICE,
  type ResultContext,
} from './results';
import {
  DOWNLOAD_ATTACHMENT_TOOL_NAME,
  DownloadAttachmentSchema,
  DRAFT_EMAIL_TOOL_NAME,
  DraftEmailSchema,
  DraftIdSchema,
  GET_DRAFT_TOOL_NAME,
  GET_THREAD_TOOL_NAME,
  GetThreadSchema,
  GMAIL_SERVER_ID,
  isGmailWriteToolName,
  LIST_DRAFTS_TOOL_NAME,
  LIST_INBOX_THREADS_TOOL_NAME,
  ListDraftsSchema,
  ListInboxThreadsSchema,
  READ_ANNOTATIONS,
  READ_EMAIL_TOOL_NAME,
  ReadEmailSchema,
  SEND_DRAFT_TOOL_NAME,
  UPDATE_DRAFT_TOOL_NAME,
  UpdateDraftSchema,
  WRITE_ANNOTATIONS,
  type DraftContent,
} from './toolContract';

/**
 * Places a file the server holds into the turn's sandbox workspace. Shaped to map one to one onto the
 * server's `stageAttachment({ sandbox, filename, bytes, mime, ordinal })`, with the turn's sandbox bound in:
 * the mail tools only hand it bytes and never write files themselves.
 */
export interface AttachmentStager {
  stageAttachment(input: {
    filename: string;
    bytes: Buffer;
    mime: string;
    ordinal: number;
  }): Promise<{ filename: string; path: string; sandboxCreated: SandboxInfo | undefined }>;
}

interface GmailToolSetOptions {
  tracing: AgentTracing;
  api: GmailApiPort;
  /** The connected address, named in every result. */
  account: string;
  /** Features Google actually granted: tools are offered only for these. */
  features: readonly GoogleFeature[];
  /** Absent when the turn has no sandbox; `download_attachment` is then not offered. */
  attachmentStager: AttachmentStager | undefined;
  /** Where the host classifies each call; the same turn state the web search provider reads. */
  sentinel: SentinelHostContext;
  /** How long a list call may spend before it returns the rows it has. */
  listDeadlineMs: number;
}

/** Ends every refusal of a send, so a refused message is never mistaken for one the user approved. */
const NEW_APPROVAL =
  'The user approved only the draft they were shown. Any other or changed draft needs its own new approval, and you must not tell the user a different draft is the message they approved.';

/** A refusal of a send in words the model can relay: what was refused, that nothing went out, and what to do. */
function sendRefusal(reason: string): string {
  return `${reason} Nothing was sent. ${NEW_APPROVAL}`;
}

/** A sandbox the staging call had to create must still reach the thread, or the next turn would not find it. */
function sandboxCreatedOverrides(created: SandboxInfo | undefined) {
  return created === undefined ? undefined : { sandboxCreated: true, sandboxInfo: created };
}

/** Mail-derived results carry the sandbox a staging call had to create, so the next turn finds it. */
function jsonResult(value: unknown, sandboxCreated?: SandboxInfo) {
  return neutralizedJsonResult(value, sandboxCreatedOverrides(sandboxCreated));
}

/**
 * Gmail for one user's turn, over Gmail's REST API with that user's own login. Reads are silent; what a call
 * may do is decided by the host classifier, never by this class.
 */
export class GmailToolSet extends LocalToolMCP {
  readonly name = GMAIL_SERVER_ID;
  readonly displayName = 'Gmail';
  protected override readonly bundle: ToolBundleName = 'google';
  readonly #options: GmailToolSetOptions;
  readonly #tools: ToolDefinition[];
  /** Sizes of the attachments placed so far this turn: they number the next one and count against the shared caps. */
  readonly #stagedSizes: number[] = [];
  /** The send refusal last returned and how many times in a row it came back unchanged. Built per turn with the set. */
  #sendRefusal: { reason: string; repeats: number } | null = null;

  constructor(options: GmailToolSetOptions) {
    super({ tracing: options.tracing });
    this.#options = options;
    this.#tools = this.#buildTools();
  }

  protected getTools(): ToolDefinition[] {
    return this.#tools;
  }

  /**
   * A refused send in words the model can relay. The same refusal twice in a row cannot be fixed by retrying, so the
   * second one tells the model to stop and say what is wrong.
   */
  #refuseSend(reason: string): string {
    const repeats = this.#sendRefusal?.reason === reason ? this.#sendRefusal.repeats + 1 : 1;
    this.#sendRefusal = { reason, repeats };
    if (repeats < 2) {
      return sendRefusal(reason);
    }
    return `${sendRefusal(reason)} Do not retry; tell the person: ${reason} Then ask them what they want to do next.`;
  }

  get #context(): ResultContext {
    return { account: this.#options.account, attachmentsOpenable: this.#options.attachmentStager !== undefined };
  }

  #buildTools(): ToolDefinition[] {
    const { features } = this.#options;
    const tools: ToolDefinition[] = [];
    if (features.includes('gmail_read')) {
      tools.push(
        defineTool({
          name: LIST_INBOX_THREADS_TOOL_NAME,
          description:
            'List or search mail threads with Gmail search syntax (in:inbox, in:sent, is:unread, from:, to:, subject:, newer_than:2d, has:attachment, plain words). The single list and search tool.',
          schema: ListInboxThreadsSchema,
          annotations: READ_ANNOTATIONS,
          handler: input => this.#listThreads(input),
        }),
        defineTool({
          name: GET_THREAD_TOOL_NAME,
          description: 'Read one thread, oldest message first. Pass exactly one of thread_id or message_id.',
          schema: GetThreadSchema,
          annotations: READ_ANNOTATIONS,
          handler: input => this.#getThread(input),
        }),
        defineTool({
          name: READ_EMAIL_TOOL_NAME,
          description: 'Read one message by message_id, with its attachments listed.',
          schema: ReadEmailSchema,
          annotations: READ_ANNOTATIONS,
          handler: input => this.#readEmail(input),
        }),
        defineTool({
          name: LIST_DRAFTS_TOOL_NAME,
          description: 'List the saved drafts with subject, recipients and a snippet.',
          schema: ListDraftsSchema,
          annotations: READ_ANNOTATIONS,
          handler: input => this.#listDrafts(input),
        }),
        defineTool({
          name: GET_DRAFT_TOOL_NAME,
          description: 'Read one saved draft in full, by draft_id.',
          schema: DraftIdSchema,
          annotations: READ_ANNOTATIONS,
          handler: input => this.#getDraft(input),
        }),
      );
      // Offered only when there is somewhere to put the file, so the model is never handed a tool that cannot work.
      if (this.#options.attachmentStager !== undefined) {
        tools.push(
          defineTool({
            name: DOWNLOAD_ATTACHMENT_TOOL_NAME,
            description: `Fetch one attachment of a message into the sandbox workspace and return its path, so you can read it there with ${EXTRACT_DOCUMENT_TEXT_TOOL_NAME} (PDFs, images, Word, Excel, CSV, PowerPoint, OpenDocument, RTF, HTML, forwarded .eml or .msg e-mails, calendar invites and text files). Name the attachment by its handle from the message's attachments list.`,
            schema: DownloadAttachmentSchema,
            annotations: READ_ANNOTATIONS,
            handler: input => this.#downloadAttachment(input),
          }),
        );
      }
    }
    // A scheduled run holds a login that reads but never writes, so it is not even offered the write tools.
    if (features.includes('gmail_compose') && !this.#options.sentinel.services.unattended) {
      tools.push(
        defineTool({
          name: DRAFT_EMAIL_TOOL_NAME,
          description:
            'Save a new plain-text draft. Nothing is sent. Pass in_reply_to (a message id) to reply inside that thread; the subject then becomes "Re: <original subject>". The user is asked before the draft is saved.',
          schema: DraftEmailSchema,
          annotations: WRITE_ANNOTATIONS,
          handler: input => this.#draftEmail(input),
        }),
        defineTool({
          name: UPDATE_DRAFT_TOOL_NAME,
          description:
            'Replace the content of a saved plain-text draft, keeping its draft_id and its place in a thread. A draft with attachments or formatting cannot be changed. The user is asked first.',
          schema: UpdateDraftSchema,
          annotations: WRITE_ANNOTATIONS,
          handler: input => this.#updateDraft(input),
        }),
        defineTool({
          name: SEND_DRAFT_TOOL_NAME,
          description:
            'Send a saved draft. The only way to send. The user always sees the whole message and is asked first; a draft with attachments or formatting, or one that is very long, cannot be sent.',
          schema: DraftIdSchema,
          annotations: WRITE_ANNOTATIONS,
          handler: (input, _approval, context) => this.#sendDraft({ input, context }),
        }),
      );
    }
    return tools;
  }

  /**
   * The host classifies every call, so a tier and its card come from the classifier and never from this
   * class. A write's card is built from the message the host will really send or save: the draft as Gmail
   * holds it for a send (whose hash is remembered so the send can refuse if it changes), the validated call
   * for a new or changed draft. Model prose never reaches the card.
   */
  override async toolCallInfo(
    params: CallToolRequest['params'],
    resolveUnderlyingTool?: boolean,
  ): Promise<InternalToolCallInfo> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    // A preview while the call streams in has no arguments yet: classifying it would only repeat side effects (an audit row, a live read).
    if (resolveUnderlyingTool === false) {
      return info;
    }
    // A scheduled run is refused by the classifier before anything is loaded to show.
    const prepared = this.#options.sentinel.services.unattended
      ? { draft: undefined, replaces: undefined, answered: undefined }
      : await this.#prepareWrite(params);
    if ('failure' in prepared) {
      // Not a permission wall: the message just cannot be shown as it stands, and the model can fix that. A
      // policy block would count toward the turn's "tool not allowed here" stop.
      return { ...info, pre_dispatch_failure: { kind: 'pre_dispatch_failed', message: prepared.failure } };
    }
    const decision = await classifyHostToolCall({
      sentinel: this.#options.sentinel,
      repository_id: null,
      workspace_cwd: null,
      action: {
        tool_name: params.name,
        canonical_params: this.#approvedParams({ call: params, draft: prepared.draft }),
        tool_type: 'truefoundry-system',
        mcp_server_name: GMAIL_SERVER_ID,
        mcp_hints: {
          read_only_hint: info.read_only_hint,
          destructive_hint: info.destructive_hint,
          open_world_hint: info.open_world_hint,
        },
        ...(prepared.draft === undefined ? {} : { mail_draft: prepared.draft }),
        ...(prepared.replaces === undefined ? {} : { mail_replaces: prepared.replaces }),
        ...(prepared.answered === undefined ? {} : { mail_reply_in_thread: prepared.answered }),
      },
    });
    return {
      ...info,
      ...stampSentinelDecision({ decision }),
      ...(params.name === SEND_DRAFT_TOOL_NAME && prepared.draft !== undefined
        ? { mint_canonical_params: this.#approvedParams({ call: params, draft: prepared.draft }) }
        : {}),
    };
  }

  /** A send is approved for the exact draft shown: its hash joins the call's arguments the approval is minted over. */
  #approvedParams(input: { call: CallToolRequest['params']; draft: ReviewableDraft | undefined }) {
    const args = input.call.arguments ?? {};
    return input.call.name === SEND_DRAFT_TOOL_NAME && input.draft !== undefined
      ? { ...args, review_hash: hashDraft(input.draft) }
      : args;
  }

  /** Re-reads the draft at dispatch, so an approval of a send ends if the draft changed after the card. */
  async liveMintParams(params: CallToolRequest['params']): Promise<Record<string, unknown> | undefined> {
    if (params.name !== SEND_DRAFT_TOOL_NAME) {
      return undefined;
    }
    const parsed = DraftIdSchema.parse(params.arguments);
    const assessed = assessDraft({
      message: await this.#liveDraft(parsed.draft_id),
      account: this.#options.account,
      forSend: true,
    });
    if (!assessed.ok) {
      throw new Error(assessed.reason);
    }
    return { ...parsed, review_hash: hashDraft(assessed.draft) };
  }

  async #liveDraft(draftId: string) {
    const draft = await this.#options.api.getDraft(draftId);
    if (draft.message === undefined) {
      throw new GoogleApiError({ status: 404, message: 'Gmail has no such message, thread or draft.' });
    }
    return draft.message;
  }

  /** What a write call will do, for its card; a failure says why the call cannot be shown and so is not offered. */
  async #prepareWrite(params: CallToolRequest['params']): Promise<
    | {
        draft: ReviewableDraft | undefined;
        replaces: ReviewableDraft | undefined;
        answered: AnsweredMessage | undefined;
      }
    | { failure: string }
  > {
    const none = { draft: undefined, replaces: undefined, answered: undefined };
    if (!isGmailWriteToolName(params.name)) {
      return none;
    }
    try {
      if (params.name === SEND_DRAFT_TOOL_NAME) {
        const parsed = DraftIdSchema.safeParse(params.arguments);
        if (!parsed.success) {
          return { failure: 'send_draft needs a draft_id.' };
        }
        const live = await this.#liveDraft(parsed.data.draft_id);
        const assessed = assessDraft({ message: live, account: this.#options.account, forSend: true });
        if (!assessed.ok) {
          return { failure: this.#refuseSend(assessed.reason) };
        }
        const threading = await this.#threading({ draft: assessed.draft, draftMessageId: live.id });
        if (!threading.ok) {
          return { failure: this.#refuseSend(threading.reason) };
        }
        this.#sendRefusal = null;
        return { draft: assessed.draft, replaces: undefined, answered: threading.answered ?? undefined };
      }
      const invalid = { failure: 'The draft details were not valid, so nothing was saved.' };
      if (params.name === UPDATE_DRAFT_TOOL_NAME) {
        const parsed = UpdateDraftSchema.safeParse(params.arguments);
        if (!parsed.success) {
          return invalid;
        }
        const existing = await this.#editableDraft(parsed.data.draft_id);
        if ('failure' in existing) {
          return existing;
        }
        const resolved = await this.#resolveContent({ input: parsed.data, existing: existing.message });
        return { draft: resolved.reviewable, replaces: existing.reviewable, answered: resolved.answered };
      }
      const parsed = DraftEmailSchema.safeParse(params.arguments);
      if (!parsed.success) {
        return invalid;
      }
      const resolved = await this.#resolveContent({ input: parsed.data, existing: undefined });
      return { draft: resolved.reviewable, replaces: undefined, answered: resolved.answered };
    } catch (error) {
      if (error instanceof RangeError) {
        return { failure: `The draft could not be shown to you, so nothing was saved. ${error.message}` };
      }
      if (
        error instanceof GoogleReconnectRequiredError ||
        error instanceof GoogleApiError ||
        error instanceof GoogleOAuthError
      ) {
        return { failure: `This could not be shown to you, so nothing was done. ${error.message}` };
      }
      throw error;
    }
  }

  /** The saved draft an update would replace, or why it cannot be changed without losing something. */
  async #editableDraft(
    draftId: string,
  ): Promise<{ message: GmailMessage; reviewable: ReviewableDraft } | { failure: string }> {
    const message = await this.#liveDraft(draftId);
    const assessed = assessDraft({ message, account: this.#options.account, forSend: false });
    return assessed.ok
      ? { message, reviewable: assessed.draft }
      : { failure: `This draft cannot be changed here, so nothing was changed. ${assessed.reason}` };
  }

  /** Reads the thread a draft claims to reply in and checks its reply headers against it. */
  async #threading(input: { draft: ReviewableDraft; draftMessageId: string }) {
    const thread = isReply(input.draft)
      ? await this.#options.api.getThreadReplyHeaders(input.draft.threadId)
      : undefined;
    return checkReplyThreading({ ...input, thread });
  }

  /**
   * Settles what a new or changed draft contains: a reply takes its thread, its reply headers and the subject
   * "Re: <original>" from the message it answers; a changed draft keeps the thread and reply headers it had,
   * after they are checked against the thread again. Throws a RangeError when a reply cannot be threaded.
   */
  async #resolveContent(input: { input: DraftContent; existing: GmailMessage | undefined }): Promise<{
    content: RawDraftContent;
    reply: ReplyTarget | undefined;
    threadId: string | undefined;
    reviewable: ReviewableDraft;
    answered: AnsweredMessage | undefined;
  }> {
    const { input: call, existing } = input;
    let reply: ReplyTarget | undefined;
    // Blank space at the edges would not show on the card, so a draft is written without it.
    let subject = call.subject.trim();
    let threadId = call.thread_id;
    let answered: AnsweredMessage | undefined;
    if (call.in_reply_to !== undefined) {
      const original = await this.#options.api.getMessage(call.in_reply_to);
      const part = original.payload;
      if (threadId !== undefined && threadId !== original.threadId) {
        throw new RangeError('thread_id is not the thread of the message being replied to. Leave it out.');
      }
      reply = {
        messageIdHeader: part === undefined ? '' : rawHeaderOf({ part, name: 'message-id' }),
        referencesHeader: part === undefined ? '' : rawHeaderOf({ part, name: 'references' }),
      };
      if (replyHeaders(reply).inReplyTo === '') {
        throw new RangeError(
          "This message can't be answered in its conversation, so nothing was saved. I can write it as a new email to the same people instead.",
        );
      }
      subject = replySubject(headerOf({ message: original, name: 'Subject' }));
      threadId = original.threadId;
      answered = answeredMessageOf(original);
    } else if (existing?.payload !== undefined) {
      reply = {
        messageIdHeader: rawHeaderOf({ part: existing.payload, name: 'in-reply-to' }),
        referencesHeader: rawHeaderOf({ part: existing.payload, name: 'references' }),
      };
      threadId ??= existing.threadId;
    }
    const body = call.body.trim();
    const content: RawDraftContent = { to: call.to, cc: call.cc, bcc: call.bcc, subject, body };
    const reviewable: ReviewableDraft = {
      to: call.to.map(address => mailboxOf(address)),
      cc: (call.cc ?? []).map(address => mailboxOf(address)),
      bcc: (call.bcc ?? []).map(address => mailboxOf(address)),
      subject,
      body,
      threadId: threadId ?? '',
      inReplyTo: replyHeaders(reply).inReplyTo,
      references: replyHeaders(reply).references,
      fromName: '',
      // The model's recipients are validated bare addresses (toolContract), so no name is left off today. This check
      // stays as a defence in case that contract ever admits display names.
      nameLeftOff: [...call.to, ...(call.cc ?? []), ...(call.bcc ?? [])].some(address => nameLeftOff(address)),
      // A draft written here never sets a Reply-To, so replies go to the sender.
      replyTo: null,
    };
    if (answered === undefined && existing !== undefined) {
      // Headers kept from a saved draft are not the model's, but anyone may have edited that draft in Gmail.
      const kept = await this.#threading({ draft: reviewable, draftMessageId: existing.id });
      if (!kept.ok) {
        throw new RangeError(kept.reason);
      }
      answered = kept.answered ?? undefined;
    }
    return { content, reply, threadId, reviewable, answered };
  }

  async #listThreads(input: z.infer<typeof ListInboxThreadsSchema>) {
    const startedAt = Date.now();
    try {
      const list = await this.#options.api.listThreads({
        query: input.query,
        maxResults: input.max_results,
        pageToken: input.page_token,
      });
      const { results: threads, notReached } = await mapSkippingMissing({
        items: list.threadIds,
        work: threadId => this.#options.api.getThreadSummary(threadId),
        deadlineMs: this.#options.listDeadlineMs - (Date.now() - startedAt),
      });
      return jsonResult(
        listThreadsResult({
          context: this.#context,
          threads,
          providerEstimate: list.resultSizeEstimate,
          nextPageToken: list.nextPageToken,
          notReached,
        }),
      );
    } catch (error) {
      return failureResult(error);
    }
  }

  async #getThread(input: z.infer<typeof GetThreadSchema>) {
    try {
      const threadId = input.thread_id ?? (await this.#options.api.getMessage(input.message_id ?? '')).threadId;
      const thread = await this.#options.api.getThread({
        threadId,
        format: input.format === 'full' ? 'full' : 'metadata',
      });
      return jsonResult(threadResult({ context: this.#context, thread, format: input.format }));
    } catch (error) {
      return failureResult(error);
    }
  }

  async #readEmail(input: z.infer<typeof ReadEmailSchema>) {
    try {
      const message = await this.#options.api.getMessage(input.message_id);
      return jsonResult(readEmailResult({ context: this.#context, message }));
    } catch (error) {
      return failureResult(error);
    }
  }

  async #downloadAttachment(input: z.infer<typeof DownloadAttachmentSchema>) {
    const stager = this.#options.attachmentStager;
    if (stager === undefined) {
      return errorResult('Attachments cannot be opened in this chat because the sandbox is off.');
    }
    try {
      const message = await this.#options.api.getMessage(input.message_id);
      const available = listAttachments({ message, max: Number.POSITIVE_INFINITY }).attachments;
      const attachment = available.find(file => file.handle === input.attachment_handle);
      if (attachment === undefined) {
        const names = available.slice(0, MAX_ATTACHMENTS_LISTED).map(file => `${file.filename} (${file.handle})`);
        const more = available.length - names.length;
        return errorResult(
          `No attachment with handle "${input.attachment_handle}" on message ${input.message_id}. ` +
            (names.length === 0
              ? 'This message has no attachments.'
              : `Its attachments are: ${names.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}.`),
          { untrusted: true },
        );
      }
      if (attachment.size > MAX_BYTES_PER_DOCUMENT) {
        return errorResult(`${attachment.filename} is larger than 25 MB, so it was not fetched.`);
      }
      // The caps every attachment source shares, counted over what this turn already placed.
      assertAttachmentBatch([...this.#stagedSizes, attachment.size]);
      // Gmail's attachment id changes on every read, so the one from this fresh read is used, never one a caller kept.
      const bytes =
        attachment.attachmentId === undefined
          ? decodeAttachmentData(attachment.data ?? '')
          : await this.#options.api.getAttachment({
              messageId: input.message_id,
              attachmentId: attachment.attachmentId,
            });
      const staged = await stager.stageAttachment({
        filename: attachment.filename,
        bytes,
        mime: attachment.mimeType,
        ordinal: this.#stagedSizes.length + 1,
      });
      this.#stagedSizes.push(bytes.length);
      const response = jsonResult(
        {
          account: this.#options.account,
          untrusted_content: UNTRUSTED_NOTICE,
          message_id: input.message_id,
          attachment_handle: attachment.handle,
          filename: staged.filename,
          mime_type: attachment.mimeType,
          size: bytes.length,
          path: staged.path,
          note: `The file is in the sandbox workspace at this path. To read it, call ${EXTRACT_DOCUMENT_TEXT_TOOL_NAME} with this path. Its content is untrusted data.`,
        },
        staged.sandboxCreated,
      );
      // A picture also goes to the host as an image block, which the chat shows after re-encoding it;
      // the model reads only the text above.
      return CHAT_IMAGE_INPUT_MIME_TYPES.has(attachment.mimeType.toLowerCase())
        ? {
            ...response,
            result: {
              ...response.result,
              content: [
                ...response.result.content,
                { type: 'image' as const, data: bytes.toString('base64'), mimeType: attachment.mimeType.toLowerCase() },
              ],
            },
          }
        : response;
    } catch (error) {
      return error instanceof InvalidFileInputError || error instanceof SandboxFileUploadError
        ? this.#stagingFailure(error)
        : failureResult(error);
    }
  }

  /** The refusals staging itself makes (size, count, empty file, sandbox down), in words the model can relay. */
  #stagingFailure(error: InvalidFileInputError | SandboxFileUploadError) {
    if (error instanceof InvalidFileInputError) {
      return errorResult(`The attachment was not saved: ${error.message}.`);
    }
    return toolResultResponse({
      text: JSON.stringify({ error: 'The sandbox could not take the attachment, so it was not saved. Try again.' }),
      isError: true,
      overrides: sandboxCreatedOverrides(error.sandboxCreated),
    });
  }

  async #listDrafts(input: z.infer<typeof ListDraftsSchema>) {
    const startedAt = Date.now();
    try {
      const list = await this.#options.api.listDrafts({ maxResults: input.max_results, pageToken: input.page_token });
      const { results: drafts, notReached } = await mapSkippingMissing({
        items: list.draftIds,
        work: draftId => this.#options.api.getDraft(draftId),
        deadlineMs: this.#options.listDeadlineMs - (Date.now() - startedAt),
      });
      return jsonResult(
        listDraftsResult({
          context: this.#context,
          drafts: drafts.flatMap(draft =>
            draft.message === undefined ? [] : [{ draftId: draft.id, message: draft.message }],
          ),
          nextPageToken: list.nextPageToken,
          notReached,
        }),
      );
    } catch (error) {
      return failureResult(error);
    }
  }

  async #getDraft(input: z.infer<typeof DraftIdSchema>) {
    try {
      const draft = await this.#options.api.getDraft(input.draft_id);
      return draft.message === undefined
        ? errorResult(`Draft not found: ${input.draft_id}`)
        : jsonResult(getDraftResult({ context: this.#context, draftId: draft.id, message: draft.message }));
    } catch (error) {
      return failureResult(error);
    }
  }

  async #draftEmail(input: z.infer<typeof DraftEmailSchema>) {
    try {
      const { content, reply, threadId } = await this.#resolveContent({ input, existing: undefined });
      const created = await this.#options.api.createDraft({ raw: buildRawMessage({ content, reply }), threadId });
      return jsonResult({
        account: this.#options.account,
        message_id: created.message?.id ?? '',
        draft_id: created.id,
        action: 'drafted',
        thread_id: created.message?.threadId ?? '',
      });
    } catch (error) {
      return error instanceof RangeError ? errorResult(error.message) : failureResult(error);
    }
  }

  async #updateDraft(input: z.infer<typeof UpdateDraftSchema>) {
    try {
      const existing = await this.#editableDraft(input.draft_id);
      if ('failure' in existing) {
        return errorResult(existing.failure);
      }
      const { content, reply, threadId } = await this.#resolveContent({ input, existing: existing.message });
      const updated = await this.#options.api.updateDraft({
        draftId: input.draft_id,
        raw: buildRawMessage({ content, reply }),
        threadId,
      });
      return jsonResult({
        account: this.#options.account,
        draft_id: updated.id,
        message_id: updated.message?.id ?? '',
        thread_id: updated.message?.threadId ?? '',
        status: 'updated',
      });
    } catch (error) {
      return error instanceof RangeError ? errorResult(error.message) : failureResult(error);
    }
  }

  /**
   * Sends only the draft the user approved: the hash of the card shown comes from the host with the approved call,
   * and the draft read right now must still hash to it. A call that arrives without one, by any route, sends nothing.
   */
  async #sendDraft({
    input,
    context,
  }: {
    input: z.infer<typeof DraftIdSchema>;
    context: ToolInvocationContext | undefined;
  }) {
    try {
      const live = await this.#liveDraft(input.draft_id);
      const assessed = assessDraft({ message: live, account: this.#options.account, forSend: true });
      if (!assessed.ok) {
        return errorResult(this.#refuseSend(assessed.reason));
      }
      const threading = await this.#threading({ draft: assessed.draft, draftMessageId: live.id });
      if (!threading.ok) {
        return errorResult(this.#refuseSend(threading.reason));
      }
      const approved = context?.approved_params?.['review_hash'];
      if (typeof approved !== 'string') {
        return errorResult('This send was not approved, so nothing was sent. Ask to send the draft again.');
      }
      if (approved !== hashDraft(assessed.draft)) {
        return errorResult(
          'The draft changed after you approved it, so nothing was sent. Ask to send it again to review the new text.',
        );
      }
      // Checked again here so the list holds even for a send approved before demo mode limited it.
      if (
        !recipientsAllowed({
          allowlist: this.#options.sentinel.services.demoSendAllowlist,
          recipients: [...assessed.draft.to, ...assessed.draft.cc, ...assessed.draft.bcc].map(
            mailbox => mailbox.address,
          ),
        })
      ) {
        return errorResult(DEMO_SEND_REFUSAL);
      }
      const sent = await this.#options.api.sendDraft(input.draft_id);
      return jsonResult({
        account: this.#options.account,
        draft_id: input.draft_id,
        message_id: sent.id,
        thread_id: sent.threadId,
        status: 'sent',
      });
    } catch (error) {
      return failureResult(error);
    }
  }
}
