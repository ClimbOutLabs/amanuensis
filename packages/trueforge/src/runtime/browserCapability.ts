/**
 * Aman's own browser: `browser_open`, `browser_read`, `browser_scroll`, `browser_back`,
 * `browser_screenshot`, `browser_type`, `browser_select` and `browser_click`. Opening, reading,
 * scrolling, going back, a screenshot, typing and selecting are Tier 1 (see browserTier.ts in
 * trueforge-core): nothing has left the computer yet. A click may or may not need the person's OK,
 * decided server-side from what the live page says about the clicked element, never from model
 * text. A page the browser reads is untrusted content, exactly like an email (see provenance.ts);
 * the model never sees the browser's own screenshot (`browser_screenshot` saves it for the receipt
 * and for the person to look at).
 *
 * The browser itself runs in a private sidecar (ops/browser-sidecar): a real, headed Chromium with
 * one persistent profile per person. This capability only calls its HTTP API.
 */
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type {
  AgentCapability,
  AgentTracing,
  ApprovalDecision,
  SentinelHostContext,
} from '@truefoundry/trueforge-core/core';
import {
  BROWSER_CLICK_TOOL_NAME,
  defineTool,
  LocalToolMCP,
  toolResultResponse,
  type ToolDefinition,
} from '@truefoundry/trueforge-core/core';
import type { BrowserClickReview, InternalToolCallInfo } from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import type { ToolBundleName } from '@truefoundry/trueforge-core/core/runtime/toolBundleCatalog';
import type { Logger } from 'winston';
import { z } from 'zod';
import configuration from '../config';

export const BROWSER_SERVER_ID = 'browser';

/** Browser tools read a page and move around it; nothing here submits anything. */
const BROWSER_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;
/** Typing and selecting change a field on the page, but nothing has left the computer yet. */
const BROWSER_PREPARE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false } as const;
/** A click may submit something; the real tier comes from browserTier.ts, never from these hints. */
const BROWSER_CLICK_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true } as const;

const OPEN_INPUT_SCHEMA = z.object({ url: z.string().min(1).max(2048) }).strict();
const SCROLL_INPUT_SCHEMA = z.object({ direction: z.enum(['up', 'down']) }).strict();
const EMPTY_INPUT_SCHEMA = z.object({}).strict();
const REF_SCHEMA = z.string().min(1).max(32);
const TYPE_INPUT_SCHEMA = z.object({ ref: REF_SCHEMA, text: z.string().max(4000) }).strict();
const SELECT_INPUT_SCHEMA = z.object({ ref: REF_SCHEMA, option: z.string().min(1).max(200) }).strict();
const CLICK_INPUT_SCHEMA = z.object({ ref: REF_SCHEMA }).strict();

export type BrowserOpenInput = z.infer<typeof OPEN_INPUT_SCHEMA>;
export type BrowserScrollInput = z.infer<typeof SCROLL_INPUT_SCHEMA>;
export type BrowserTypeInput = z.infer<typeof TYPE_INPUT_SCHEMA>;
export type BrowserSelectInput = z.infer<typeof SELECT_INPUT_SCHEMA>;
export type BrowserClickInput = z.infer<typeof CLICK_INPUT_SCHEMA>;

/** What the sidecar answered to a request, or that the sidecar itself could not be reached. */
export type SidecarResult<T> = { ok: true; body: T } | { ok: false; message: string };

const REFUSAL_MESSAGES: Record<string, string> = {
  scheme: 'Aman can only open http and https addresses, never a file or app address.',
  private_network: "That address is on this computer or a private network, so Aman's browser will not open it.",
  unresolved: "That address could not be found, so Aman's browser will not open it.",
  not_a_url: 'That is not a web address Aman can open.',
  sensitive_field: 'This field is for a password or payment detail. Ask the person to type it themselves.',
  unknown_ref: 'That part of the page is gone. Read the page again to get a fresh ref, then try again.',
  stale_ref: 'That part of the page is gone. Read the page again to get a fresh ref, then try again.',
  no_such_option: 'That option is not on the list. Read the page again to see the choices, then try again.',
};

function refusalMessage(reason: unknown): string {
  const text = typeof reason === 'string' ? REFUSAL_MESSAGES[reason] : undefined;
  return text ?? 'Aman will not do that.';
}

/** The `ref` argument of a browser_click call, or undefined when it is missing or not a string. */
function clickRef(params: CallToolRequest['params']): string | undefined {
  const ref = params.arguments?.['ref'];
  return typeof ref === 'string' && ref !== '' ? ref : undefined;
}

/** Calls one route of the browser sidecar, with the shared secret and the configured navigation timeout. */
export async function callBrowserSidecar<T>(input: {
  path: string;
  owner: string;
  body?: Record<string, unknown>;
}): Promise<SidecarResult<T>> {
  const baseUrl = configuration.BROWSER_URL;
  const secret = configuration.BROWSER_SECRET;
  if (baseUrl === undefined || secret === undefined) {
    return { ok: false, message: 'The browser is not set up on this server.' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, configuration.BROWSER_NAV_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${input.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-browser-secret': secret },
      body: JSON.stringify({ owner: input.owner, ...input.body }),
      signal: controller.signal,
    });
    const json: unknown = await response.json();
    if (!response.ok || typeof json !== 'object' || json === null) {
      return { ok: false, message: 'The browser could not do that.' };
    }
    return { ok: true, body: json as T };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === 'AbortError'
          ? 'The page took too long to open.'
          : 'The browser could not be reached.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

interface ReadBody {
  status: 'ok';
  text: string;
}

/** The tab is on a site other than the one opened, so the sidecar returned nothing of it. */
interface MovedBody {
  status: 'moved';
  url: string;
}

/** A call that may be refused by the sidecar (open, type, select, click) instead of acting. */
interface RefusableReadBody {
  status: 'ok' | 'refused';
  text?: string;
  reason?: string;
}

type ScreenshotBody = { status: 'ok'; png_base64: string } | MovedBody;

/**
 * The page left the site that was opened (a redirect, or going back). Its content is not shown: reading
 * it is a new `browser_open` of that address, which is classified like any other open.
 */
function movedMessage(url: unknown): string {
  const shown = typeof url === 'string' && url !== '' ? url : 'another site';
  return `The page went to ${shown}, a different site from the one that was opened, so it was not read. To read it, open that address with browser_open.`;
}

interface ClickInfoBody {
  status: 'ok' | 'refused';
  site?: string;
  accessible_name?: string;
  is_form_submit?: boolean;
  form_values?: Record<string, string>;
  png_base64?: string | null;
  reason?: string;
}

/** A read of the live page before a click: what it is for the classifier, plus a picture for the card. */
interface ClickReview {
  review: BrowserClickReview;
  /** A data URL, for the approval card only; never part of what the approval token binds. */
  screenshot: string | undefined;
}

/** The sidecar's answer to a click: `ok`, a plain refusal, caught by the request gate, or the page moved sites. */
interface ClickBody {
  status: 'ok' | 'refused' | 'needs_approval' | 'moved';
  text?: string;
  reason?: string;
  url?: string;
  site?: string;
  accessible_name?: string;
  form_values?: Record<string, string>;
}

function needsApprovalResult(body: ClickBody): ReturnType<typeof toolResultResponse> {
  const label = body.accessible_name === undefined || body.accessible_name === '' ? '(no label)' : body.accessible_name;
  const values = Object.entries(body.form_values ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ');
  return toolResultResponse({
    text: JSON.stringify({
      status: 'needs_approval',
      message:
        `Stop. Clicking "${label}" on ${body.site ?? 'this site'} tried to send something, and Aman stopped it ` +
        'because the person had not said OK. Nothing was sent. Tell the person plainly: this needs their OK, ' +
        `name the button and the site, and do not click it again without asking them first.` +
        (values === '' ? '' : ` The form held: ${values}.`),
    }),
    isError: true,
  });
}

function readResult({
  result,
  logger,
}: {
  result: SidecarResult<ReadBody | RefusableReadBody | MovedBody>;
  logger: Logger;
}): ReturnType<typeof toolResultResponse> {
  if (!result.ok) {
    logger.warn('browser sidecar call failed', { message: result.message });
    return toolResultResponse({ text: JSON.stringify({ status: 'error', message: result.message }), isError: true });
  }
  if (result.body.status === 'refused') {
    return toolResultResponse({
      text: JSON.stringify({ status: 'error', message: refusalMessage(result.body.reason) }),
      isError: true,
    });
  }
  if (result.body.status === 'moved') {
    return toolResultResponse({
      text: JSON.stringify({ status: 'error', message: movedMessage(result.body.url) }),
      isError: true,
    });
  }
  return toolResultResponse({ text: result.body.text ?? '' });
}

class BrowserTool extends LocalToolMCP {
  readonly name = BROWSER_SERVER_ID;
  readonly displayName = 'Browser';
  protected override readonly bundle: ToolBundleName = 'browser';

  constructor(
    private readonly owner: string,
    private readonly logger: Logger,
    private readonly sentinel: SentinelHostContext,
    tracing: AgentTracing,
  ) {
    super({ tracing });
  }

  /**
   * A click the Tier classifier waved through, but that the sidecar's own gate then caught trying
   * to send something, is a stopped attempt like any other: recorded even though it never had a
   * card or a token of its own.
   */
  private async recordCaughtClick(body: ClickBody): Promise<void> {
    const writer = this.sentinel.services.audit;
    if (writer === null) {
      return;
    }
    const label =
      body.accessible_name === undefined || body.accessible_name === '' ? '(no label)' : body.accessible_name;
    await writer.record({
      tenant_id: this.sentinel.tenant_id,
      created_by: this.sentinel.created_by,
      conversation_id: this.sentinel.conversation_id,
      tier: 3,
      tool_name: BROWSER_CLICK_TOOL_NAME,
      description: `Held: clicking "${label}" on ${body.site ?? 'the page'} tried to send something without asking first.`,
      outcome: 'auto_denied',
      auto_deny_reason: 'outbound_guard',
    });
  }

  /** What the live page says about a clicked ref right now, or undefined when it cannot be read. */
  private async readClickReview(ref: string): Promise<ClickReview | undefined> {
    const result = await callBrowserSidecar<ClickInfoBody>({ path: '/click-info', owner: this.owner, body: { ref } });
    if (!result.ok || result.body.status !== 'ok') {
      return undefined;
    }
    const body = result.body;
    return {
      review: {
        site: body.site ?? '',
        accessible_name: body.accessible_name ?? '',
        is_form_submit: body.is_form_submit === true,
        form_values: body.form_values ?? {},
      },
      screenshot:
        body.png_base64 === null || body.png_base64 === undefined
          ? undefined
          : `data:image/png;base64,${body.png_base64}`,
    };
  }

  /**
   * Stamps `browser_click` with what the live page says about the clicked element, read without
   * clicking it, so the classifier decides the tier from the page itself, never from model text.
   * Left unset (and so classified fail-closed) when the sidecar cannot be reached or the ref is gone.
   */
  override async toolCallInfo(
    params: Parameters<LocalToolMCP['toolCallInfo']>[0],
    resolveUnderlyingTool?: boolean,
  ): Promise<InternalToolCallInfo> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    if (params.name !== BROWSER_CLICK_TOOL_NAME || resolveUnderlyingTool === false) {
      return info;
    }
    const ref = clickRef(params);
    if (ref === undefined) {
      return info;
    }
    const found = await this.readClickReview(ref);
    if (found === undefined) {
      return info;
    }
    return {
      ...info,
      browser_click: found.review,
      ...(found.screenshot === undefined ? {} : { browser_click_screenshot: found.screenshot }),
    };
  }

  /**
   * Re-reads the click's context right before dispatch, so an approval given for one page cannot
   * click a different one: the generic "parameters changed since approval" check then compares this
   * fresh read against what the token was minted over (see browserTier.ts). A ref dispatch cannot
   * read throws, which the dispatch path turns into its own "could not be re-checked" refusal.
   */
  async liveMintParams(
    params: Parameters<LocalToolMCP['toolCallInfo']>[0],
  ): Promise<Record<string, unknown> | undefined> {
    if (params.name !== BROWSER_CLICK_TOOL_NAME) {
      return undefined;
    }
    const ref = clickRef(params);
    if (ref === undefined) {
      throw new Error('browser_click is missing its ref');
    }
    const found = await this.readClickReview(ref);
    if (found === undefined) {
      throw new Error('could not re-read the clicked element');
    }
    // Only the review binds the approval: the screenshot never does (see ClickReview).
    return { ref, review: found.review };
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: 'browser_open',
      annotations: BROWSER_READ_ANNOTATIONS,
      description:
        "Open a web page in Aman's own browser (not the user's browser) and read it back as text. Only http and https addresses; never a file, app or local-network address. Use when the user asks to find something on a site or open a specific page.",
      schema: OPEN_INPUT_SCHEMA,
      handler: async (input: BrowserOpenInput) =>
        readResult({
          result: await callBrowserSidecar<RefusableReadBody | MovedBody>({
            path: '/open',
            owner: this.owner,
            body: { url: input.url },
          }),
          logger: this.logger,
        }),
    }),
    defineTool({
      name: 'browser_read',
      annotations: BROWSER_READ_ANNOTATIONS,
      description:
        'Read the page currently open in the browser: its title, address, headings, links, buttons and fields, each actionable one with a short ref. A password or payment field never shows its value.',
      schema: EMPTY_INPUT_SCHEMA,
      handler: async () =>
        readResult({
          result: await callBrowserSidecar<ReadBody | MovedBody>({ path: '/read', owner: this.owner }),
          logger: this.logger,
        }),
    }),
    defineTool({
      name: 'browser_scroll',
      annotations: BROWSER_READ_ANNOTATIONS,
      description: 'Scroll the open page up or down, then read it again.',
      schema: SCROLL_INPUT_SCHEMA,
      handler: async (input: BrowserScrollInput) =>
        readResult({
          result: await callBrowserSidecar<ReadBody | MovedBody>({ path: '/scroll', owner: this.owner, body: input }),
          logger: this.logger,
        }),
    }),
    defineTool({
      name: 'browser_back',
      annotations: BROWSER_READ_ANNOTATIONS,
      description: 'Go back to the previous page in the browser, then read it.',
      schema: EMPTY_INPUT_SCHEMA,
      handler: async () =>
        readResult({
          result: await callBrowserSidecar<ReadBody | MovedBody>({ path: '/back', owner: this.owner }),
          logger: this.logger,
        }),
    }),
    defineTool({
      name: 'browser_screenshot',
      annotations: BROWSER_READ_ANNOTATIONS,
      description:
        'Take a picture of the open page, for the person to look at. The picture is saved to the chat; it is not read by the model.',
      schema: EMPTY_INPUT_SCHEMA,
      handler: async () => {
        const result = await callBrowserSidecar<ScreenshotBody>({ path: '/screenshot', owner: this.owner });
        if (!result.ok) {
          this.logger.warn('browser sidecar call failed', { message: result.message });
          return toolResultResponse({
            text: JSON.stringify({ status: 'error', message: result.message }),
            isError: true,
          });
        }
        if (result.body.status === 'moved') {
          return toolResultResponse({
            text: JSON.stringify({ status: 'error', message: movedMessage(result.body.url) }),
            isError: true,
          });
        }
        // The image itself never reaches the model: only a confirmation that one was saved.
        return toolResultResponse({ text: JSON.stringify({ status: 'ok', saved: true }) });
      },
    }),
    defineTool({
      name: 'browser_type',
      annotations: BROWSER_PREPARE_ANNOTATIONS,
      description:
        'Type text into a field on the open page, by its ref from browser_read. Refused for a password, card or one-time-code field: ask the person to type those themselves. Nothing is submitted; read the page again to see what was typed.',
      schema: TYPE_INPUT_SCHEMA,
      handler: async (input: BrowserTypeInput) =>
        readResult({
          result: await callBrowserSidecar<RefusableReadBody | MovedBody>({
            path: '/type',
            owner: this.owner,
            body: input,
          }),
          logger: this.logger,
        }),
    }),
    defineTool({
      name: 'browser_select',
      annotations: BROWSER_PREPARE_ANNOTATIONS,
      description: 'Pick an option on a dropdown field, by its ref from browser_read and the option text.',
      schema: SELECT_INPUT_SCHEMA,
      handler: async (input: BrowserSelectInput) =>
        readResult({
          result: await callBrowserSidecar<RefusableReadBody | MovedBody>({
            path: '/select',
            owner: this.owner,
            body: input,
          }),
          logger: this.logger,
        }),
    }),
    defineTool({
      name: BROWSER_CLICK_TOOL_NAME,
      annotations: BROWSER_CLICK_ANNOTATIONS,
      description:
        'Click a link, button, tab or other element on the open page, by its ref from browser_read. A click that submits a form, or whose label is a word like pay, buy, send, delete, cancel a membership and similar, shows the person an approval card first; everything else runs right away.',
      schema: CLICK_INPUT_SCHEMA,
      handler: async (input: BrowserClickInput, approvalDecision?: ApprovalDecision) => {
        const result = await callBrowserSidecar<ClickBody>({
          path: '/click',
          owner: this.owner,
          body: { ref: input.ref, approved: approvalDecision?.status === 'allow' },
        });
        if (!result.ok) {
          this.logger.warn('browser sidecar call failed', { message: result.message });
          return toolResultResponse({
            text: JSON.stringify({ status: 'error', message: result.message }),
            isError: true,
          });
        }
        const body = result.body;
        if (body.status === 'needs_approval') {
          this.logger.warn('browser click gate caught an unapproved write', {
            site: body.site,
            accessible_name: body.accessible_name,
          });
          await this.recordCaughtClick(body);
          return needsApprovalResult(body);
        }
        if (body.status === 'refused') {
          return toolResultResponse({
            text: JSON.stringify({ status: 'error', message: refusalMessage(body.reason) }),
            isError: true,
          });
        }
        if (body.status === 'moved') {
          return toolResultResponse({
            text: JSON.stringify({ status: 'error', message: movedMessage(body.url) }),
            isError: true,
          });
        }
        return toolResultResponse({ text: body.text ?? '' });
      },
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }
}

export interface BrowserCapabilityOptions {
  tracing: AgentTracing;
  logger: Logger;
  /** The person the browser profile belongs to; logins persist across chats for the same person. */
  owner: string;
  /** For the receipt a click the sidecar's gate caught writes, even though it never had its own card. */
  sentinel: SentinelHostContext;
}

/** Build the browser capability. Callers only add this when `configuration.BROWSER_ENABLED` is true. */
export function browserCapability(options: BrowserCapabilityOptions): AgentCapability {
  return {
    systemToolSets: [new BrowserTool(options.owner, options.logger, options.sentinel, options.tracing)],
  };
}
