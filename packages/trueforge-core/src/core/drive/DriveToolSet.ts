import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { ApprovalDecision } from '../events/schema';
import { GoogleApiError, GoogleOAuthError, GoogleReconnectRequiredError } from '../google/errors';
import type { GoogleFeature } from '../google/scopes';
import { errorResult, failureResult, jsonResult } from '../google/toolResults';
import type { InternalToolCallInfo } from '../llm/LLMTypes';
import type { ToolInvocationContext } from '../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../mcp/LocalToolMCP';
import { stampSentinelDecision } from '../mcp/ToolSet';
import { stableStringify } from '../permissions/approvalTokens';
import { classifyHostToolCall } from '../permissions/classifier';
import type { SentinelHostContext } from '../permissions/context';
import type { ToolBundleName } from '../runtime/toolBundleCatalog';
import type { AgentTracing } from '../tracing/AgentTracing';
import { sheetRange, type DriveApiPort } from './driveApi';
import { DOC_MIME_TYPE, docTextOf, driveKindLabel, SHEET_MIME_TYPE, sheetTitlesOf, type DriveFile } from './driveWire';
import { docResult, listFilesResult, sheetResult, type DriveResultContext } from './results';
import {
  APPEND_ROWS_TOOL_NAME,
  AppendRowsSchema,
  CREATE_DOC_TOOL_NAME,
  CreateDocSchema,
  DRIVE_READ_ANNOTATIONS,
  DRIVE_SERVER_ID,
  DRIVE_WRITE_ANNOTATIONS,
  isDriveWriteToolName,
  LIST_FILES_TOOL_NAME,
  ListFilesSchema,
  READ_DRIVE_FILE_TOOL_NAME,
  ReadDriveFileSchema,
  type AppendRowsInput,
  type CreateDocInput,
} from './toolContract';
import {
  hashDriveWrite,
  reviewForAppend,
  reviewForCreate,
  sharedWithCount,
  type DriveWriteReview,
} from './writeReview';

/** Key the host adds to an approved write: the hash of the write the card showed. */
const REVIEW_HASH_KEY = 'review_hash';

const NOT_APPROVED = 'This was not approved, so nothing was changed. Ask again to make the change.';

/** Said when a write's target cannot be shown as it is, so the call is not offered at all. */
function notShown(error: unknown): string {
  return error instanceof GoogleReconnectRequiredError ||
    error instanceof GoogleApiError ||
    error instanceof GoogleOAuthError
    ? `This could not be shown to you, so nothing was done. ${error.message}`
    : 'This could not be shown to you, so nothing was done.';
}

interface DriveToolSetOptions {
  tracing: AgentTracing;
  api: DriveApiPort;
  /** The connected address, named in every result. */
  account: string;
  /** Features Google actually granted: the tools are offered only when Drive is among them. */
  features: readonly GoogleFeature[];
  /** Where the host classifies each call; the same turn state the web search provider reads. */
  sentinel: SentinelHostContext;
}

/**
 * Google Drive for one user's turn, over the Drive, Docs and Sheets APIs with that user's own login.
 * Reads are silent; creating a Doc or adding rows to a Sheet asks first, and nothing here deletes a
 * file or changes who it is shared with.
 */
export class DriveToolSet extends LocalToolMCP {
  readonly name = DRIVE_SERVER_ID;
  readonly displayName = 'Google Drive';
  protected override readonly bundle: ToolBundleName = 'google';
  readonly #options: DriveToolSetOptions;
  readonly #tools: ToolDefinition[];

  constructor(options: DriveToolSetOptions) {
    super({ tracing: options.tracing });
    this.#options = options;
    this.#tools = this.#buildTools();
  }

  protected getTools(): ToolDefinition[] {
    return this.#tools;
  }

  get #context(): DriveResultContext {
    return { account: this.#options.account };
  }

  #buildTools(): ToolDefinition[] {
    if (!this.#options.features.includes('drive_files')) {
      return [];
    }
    return [
      defineTool({
        name: LIST_FILES_TOOL_NAME,
        description:
          'List or search the Google Drive files Aman can see: files Aman created, or that the user opened with Aman. Most recently changed first. Pass query words to search file names. The single list and search tool.',
        schema: ListFilesSchema,
        annotations: DRIVE_READ_ANNOTATIONS,
        handler: input => this.#listFiles(input),
      }),
      defineTool({
        name: READ_DRIVE_FILE_TOOL_NAME,
        description:
          'Read one file Aman can see, by file_id from list_files: the text of a Google Doc, or the rows of one tab of a Google Sheet. Name the tab with sheet, or read the first tab.',
        schema: ReadDriveFileSchema,
        annotations: DRIVE_READ_ANNOTATIONS,
        handler: input => this.#readFile(input),
      }),
      defineTool({
        name: CREATE_DOC_TOOL_NAME,
        description:
          'Create a new Google Doc with a title and text. The user sees the title and the whole text and is asked first.',
        schema: CreateDocSchema,
        annotations: DRIVE_WRITE_ANNOTATIONS,
        handler: (input, approval, context) => this.#createDoc({ input, approval, context }),
      }),
      defineTool({
        name: APPEND_ROWS_TOOL_NAME,
        description:
          'Add rows to one tab of a Google Sheet, by file_id from list_files, after its existing rows. Values are read the way Sheets reads typed values, so a number stays a number. The user sees every row and is asked first.',
        schema: AppendRowsSchema,
        annotations: DRIVE_WRITE_ANNOTATIONS,
        handler: (input, approval, context) => this.#appendRows({ input, approval, context }),
      }),
    ];
  }

  /**
   * The host classifies every call, so a tier and its card come from the classifier and never from this
   * class. A write's card is built from the write as it will really be sent: for an append, settled here
   * from the spreadsheet as Google holds it now, so the card names the file and tab that exist.
   */
  override async toolCallInfo(
    params: CallToolRequest['params'],
    resolveUnderlyingTool?: boolean,
  ): Promise<InternalToolCallInfo> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    // A preview while the call streams in has no arguments yet: classifying it would only repeat side effects (a live read).
    if (resolveUnderlyingTool === false) {
      return info;
    }
    const prepared = isDriveWriteToolName(params.name) ? await this.#prepareWrite(params) : undefined;
    if (prepared !== undefined && 'failure' in prepared) {
      // Not a permission wall: the write cannot be shown as it stands, and the model can fix that.
      return { ...info, pre_dispatch_failure: { kind: 'pre_dispatch_failed', message: prepared.failure } };
    }
    const decision = await classifyHostToolCall({
      sentinel: this.#options.sentinel,
      repository_id: null,
      workspace_cwd: null,
      action: {
        tool_name: params.name,
        canonical_params: prepared?.approved ?? params.arguments ?? {},
        tool_type: 'truefoundry-system',
        mcp_server_name: DRIVE_SERVER_ID,
        mcp_hints: {
          read_only_hint: info.read_only_hint,
          destructive_hint: info.destructive_hint,
          open_world_hint: info.open_world_hint,
        },
        ...(prepared === undefined ? {} : { drive_write: prepared.review }),
      },
    });
    return {
      ...info,
      ...stampSentinelDecision({ decision }),
      ...(prepared === undefined ? {} : { mint_canonical_params: prepared.approved }),
    };
  }

  /**
   * Re-derives a write's approved params from the call as it reaches dispatch, reading the spreadsheet
   * again for an append, so an approval ends when the arguments or the sheet changed after the card.
   */
  async liveMintParams(params: CallToolRequest['params']): Promise<Record<string, unknown> | undefined> {
    if (!isDriveWriteToolName(params.name)) {
      return undefined;
    }
    const prepared = await this.#prepareWrite(params);
    if ('failure' in prepared) {
      throw new Error(prepared.failure);
    }
    return prepared.approved;
  }

  /** What a write call will do, for its card; a failure says why it cannot be shown and so is not offered. */
  async #prepareWrite(
    params: CallToolRequest['params'],
  ): Promise<{ approved: Record<string, unknown>; review: DriveWriteReview } | { failure: string }> {
    try {
      if (params.name === CREATE_DOC_TOOL_NAME) {
        const parsed = CreateDocSchema.safeParse(params.arguments);
        if (!parsed.success) {
          return { failure: 'The Doc details were not valid, so nothing was created.' };
        }
        const review = reviewForCreate({ call: parsed.data, account: this.#options.account });
        const hash = hashDriveWrite({
          tool_name: CREATE_DOC_TOOL_NAME,
          title: parsed.data.title,
          text: parsed.data.text,
          request: undefined,
        });
        return { approved: { ...parsed.data, [REVIEW_HASH_KEY]: hash }, review };
      }
      const parsed = AppendRowsSchema.safeParse(params.arguments);
      if (!parsed.success) {
        return { failure: 'The rows were not valid, so nothing was added.' };
      }
      const settled = await this.#settleAppend(parsed.data);
      if ('failure' in settled) {
        return settled;
      }
      const { file, request } = settled;
      const review = reviewForAppend({
        account: this.#options.account,
        file_name: file.name,
        request,
        shared_with: sharedWithCount(file),
      });
      const hash = hashDriveWrite({ tool_name: APPEND_ROWS_TOOL_NAME, title: undefined, text: undefined, request });
      return { approved: { ...parsed.data, [REVIEW_HASH_KEY]: hash }, review };
    } catch (error) {
      if (
        error instanceof GoogleReconnectRequiredError ||
        error instanceof GoogleApiError ||
        error instanceof GoogleOAuthError
      ) {
        return { failure: notShown(error) };
      }
      throw error;
    }
  }

  /**
   * Settles an append against the file as Google holds it now: it must be a Sheet, and the tab must be one
   * it has (the first tab when the call names none).
   */
  async #settleAppend(
    call: AppendRowsInput,
  ): Promise<
    { file: DriveFile; request: { file_id: string; sheet_title: string; rows: string[][] } } | { failure: string }
  > {
    const file = await this.#options.api.getFile(call.file_id);
    if (file.mimeType !== SHEET_MIME_TYPE) {
      return {
        failure: `That file is a ${driveKindLabel(file.mimeType)}, not a Google Sheet, so rows cannot be added to it.`,
      };
    }
    const spreadsheet = await this.#options.api.getSpreadsheet(call.file_id);
    const titles = sheetTitlesOf(spreadsheet);
    const sheetTitle = call.sheet ?? titles[0];
    if (sheetTitle === undefined) {
      return { failure: 'That Sheet has no tabs, so rows cannot be added to it.' };
    }
    if (!titles.includes(sheetTitle)) {
      return {
        failure: `That Sheet has no tab named "${call.sheet ?? ''}". Its tabs are: ${titles.join(', ')}.`,
      };
    }
    return { file, request: { file_id: call.file_id, sheet_title: sheetTitle, rows: call.rows } };
  }

  /**
   * Whether this write may run: the person's answer to this call, or a standing grant for this tool.
   * The approved params are settled when the call is classified, before anyone answers, so only the
   * answer to this very call, or a grant the classifier admitted, lets it write.
   */
  async #writePermitted(input: { approval: ApprovalDecision | undefined; toolName: string }): Promise<boolean> {
    if (input.approval !== undefined) {
      return input.approval.status === 'allow';
    }
    const { sentinel } = this.#options;
    return sentinel.services.tool_grants.hasToolGrant({
      tenant_id: sentinel.tenant_id,
      created_by: sentinel.created_by,
      mcp_server_name: DRIVE_SERVER_ID,
      tool_name: input.toolName,
      mcp_server_host: null,
    });
  }

  /**
   * The hash the user approved this exact call under. A call that arrives without it, or with arguments
   * other than the approved ones, changes nothing; so does any call in a scheduled run, where nobody
   * approved it in the run itself.
   */
  async #approvedWrite<T>(input: {
    call: T;
    schema: z.ZodType<T>;
    toolName: string;
    approval: ApprovalDecision | undefined;
    context: ToolInvocationContext | undefined;
    changedRefusal: string;
  }): Promise<{ hash: string } | { refusal: string }> {
    if (this.#options.sentinel.services.unattended) {
      return { refusal: "Scheduled runs never change your Google Drive files. This waits for the owner's OK." };
    }
    if (!(await this.#writePermitted({ approval: input.approval, toolName: input.toolName }))) {
      return { refusal: NOT_APPROVED };
    }
    const { [REVIEW_HASH_KEY]: hash, ...approvedArgs } = input.context?.approved_params ?? {};
    if (typeof hash !== 'string') {
      return { refusal: NOT_APPROVED };
    }
    const approved = input.schema.safeParse(approvedArgs);
    if (!approved.success || stableStringify(approved.data) !== stableStringify(input.call)) {
      return { refusal: input.changedRefusal };
    }
    return { hash };
  }

  async #createDoc({
    input,
    approval,
    context,
  }: {
    input: CreateDocInput;
    approval: ApprovalDecision | undefined;
    context: ToolInvocationContext | undefined;
  }) {
    const approved = await this.#approvedWrite({
      call: input,
      schema: CreateDocSchema,
      toolName: CREATE_DOC_TOOL_NAME,
      approval,
      context,
      changedRefusal:
        'The Doc details changed after you approved them, so nothing was created. Ask again to review the new details.',
    });
    if ('refusal' in approved) {
      return errorResult(approved.refusal);
    }
    try {
      const created = await this.#options.api.createDocument({ title: input.title });
      if (input.text !== '') {
        try {
          await this.#options.api.insertText({ documentId: created.id, text: input.text });
        } catch (error) {
          if (
            error instanceof GoogleReconnectRequiredError ||
            error instanceof GoogleApiError ||
            error instanceof GoogleOAuthError
          ) {
            return errorResult(`The Doc "${input.title}" was created, but its text was not added. ${error.message}`, {
              untrusted: true,
            });
          }
          throw error;
        }
      }
      return jsonResult({
        account: this.#options.account,
        file_id: created.id,
        name: created.name,
        kind: 'Google Doc',
        status: 'created',
        ...(created.webViewLink === undefined ? {} : { link: created.webViewLink }),
      });
    } catch (error) {
      return failureResult(error);
    }
  }

  async #appendRows({
    input,
    approval,
    context,
  }: {
    input: AppendRowsInput;
    approval: ApprovalDecision | undefined;
    context: ToolInvocationContext | undefined;
  }) {
    const approved = await this.#approvedWrite({
      call: input,
      schema: AppendRowsSchema,
      toolName: APPEND_ROWS_TOOL_NAME,
      approval,
      context,
      changedRefusal:
        'The rows changed after you approved them, so nothing was added. Ask again to review the new rows.',
    });
    if ('refusal' in approved) {
      return errorResult(approved.refusal);
    }
    try {
      // Settled again at dispatch: an approval ends when the sheet changed after the card.
      const settled = await this.#settleAppend(input);
      if ('failure' in settled) {
        return errorResult(settled.failure);
      }
      const hash = hashDriveWrite({
        tool_name: APPEND_ROWS_TOOL_NAME,
        title: undefined,
        text: undefined,
        request: settled.request,
      });
      if (hash !== approved.hash) {
        return errorResult(
          'The Sheet changed after you approved this, so nothing was added. Ask again to see it as it is now.',
        );
      }
      const outcome = await this.#options.api.appendRows({
        spreadsheetId: input.file_id,
        range: sheetRange(settled.request.sheet_title),
        rows: input.rows,
      });
      return jsonResult({
        account: this.#options.account,
        file_id: input.file_id,
        name: settled.file.name,
        kind: 'Google Sheet',
        sheet: settled.request.sheet_title,
        status: 'appended',
        rows_added: outcome.updatedRows ?? input.rows.length,
        ...(outcome.updatedRange === undefined ? {} : { updated_range: outcome.updatedRange }),
      });
    } catch (error) {
      return failureResult(error);
    }
  }

  async #listFiles(input: z.infer<typeof ListFilesSchema>) {
    try {
      const page = await this.#options.api.listFiles({
        query: input.query,
        maxResults: input.max_results,
        pageToken: input.page_token,
      });
      return jsonResult(
        listFilesResult({ context: this.#context, files: page.files, nextPageToken: page.nextPageToken }),
      );
    } catch (error) {
      return failureResult(error);
    }
  }

  async #readFile(input: z.infer<typeof ReadDriveFileSchema>) {
    try {
      const file = await this.#options.api.getFile(input.file_id);
      if (file.mimeType === DOC_MIME_TYPE) {
        if (input.sheet !== undefined) {
          return errorResult('That file is a Google Doc, so it has no tabs. Read it without naming a tab.', {
            untrusted: true,
          });
        }
        const document = await this.#options.api.getDocument(input.file_id);
        return jsonResult(docResult({ context: this.#context, file, text: docTextOf(document) }));
      }
      if (file.mimeType === SHEET_MIME_TYPE) {
        const spreadsheet = await this.#options.api.getSpreadsheet(input.file_id);
        const titles = sheetTitlesOf(spreadsheet);
        const sheet = input.sheet ?? titles[0];
        if (sheet === undefined) {
          return errorResult('That Sheet has no tabs to read.', { untrusted: true });
        }
        if (!titles.includes(sheet)) {
          return errorResult(
            `That Sheet has no tab named "${input.sheet ?? ''}". Its tabs are: ${titles.join(', ')}.`,
            {
              untrusted: true,
            },
          );
        }
        const values = await this.#options.api.getSheetValues({
          spreadsheetId: input.file_id,
          range: sheetRange(sheet),
        });
        return jsonResult(
          sheetResult({ context: this.#context, file, sheet, sheets: titles, rows: values.values ?? [] }),
        );
      }
      return errorResult(
        `Aman can read Google Docs and Sheets. That file is a ${driveKindLabel(file.mimeType)}, so it cannot be read here.`,
        { untrusted: true },
      );
    } catch (error) {
      return failureResult(error);
    }
  }
}
