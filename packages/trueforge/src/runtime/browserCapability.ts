/**
 * Aman's own browser: `browser_open`, `browser_read`, `browser_scroll`, `browser_back` and
 * `browser_screenshot`. Nothing here types into a field or clicks anything that could submit. Opening
 * an address sends it to a site, so `browser_open` gets the same outbound checks as a page lookup;
 * the other tools only look at the open page (see browserTier.ts in trueforge-core). A page the
 * browser reads comes from the person's signed-in browser, so it is recorded like their mail (see
 * provenance.ts). The model never sees a screenshot: it goes to the chat for the person.
 *
 * The browser itself runs in a private sidecar (ops/browser-sidecar): a real, headed Chromium with
 * one persistent profile per person and one tab per chat. This capability only calls its HTTP API.
 */
import type { AgentCapability, AgentTracing } from '@truefoundry/trueforge-core/core';
import { defineTool, LocalToolMCP, toolResultResponse, type ToolDefinition } from '@truefoundry/trueforge-core/core';
import type { ToolBundleName } from '@truefoundry/trueforge-core/core/runtime/toolBundleCatalog';
import type { Logger } from 'winston';
import { z } from 'zod';
import configuration from '../config';

export const BROWSER_SERVER_ID = 'browser';

/** Browser tools read a page and move around it; nothing here submits anything. */
const BROWSER_TOOL_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;

const OPEN_INPUT_SCHEMA = z.object({ url: z.string().min(1).max(2048) }).strict();
const SCROLL_INPUT_SCHEMA = z.object({ direction: z.enum(['up', 'down']) }).strict();
const EMPTY_INPUT_SCHEMA = z.object({}).strict();

export type BrowserOpenInput = z.infer<typeof OPEN_INPUT_SCHEMA>;
export type BrowserScrollInput = z.infer<typeof SCROLL_INPUT_SCHEMA>;

/** The sidecar refused the address before opening anything. */
const RefusedReplySchema = z.object({ status: z.literal('refused'), reason: z.string() });
/** The tab is on a site other than the one opened, so the sidecar returned nothing of it. */
const MovedReplySchema = z.object({ status: z.literal('moved'), url: z.string() });
/** This chat has no page open: it never opened one, or its tab closed to make room for other chats. */
const ClosedReplySchema = z.object({ status: z.literal('closed') });
const PageReplySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), text: z.string() }),
  MovedReplySchema,
  ClosedReplySchema,
  RefusedReplySchema,
]);
const ScreenshotReplySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), png_base64: z.string().min(1) }),
  MovedReplySchema,
  ClosedReplySchema,
]);

const WhereReplySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), url: z.string() }),
  MovedReplySchema,
  ClosedReplySchema,
]);
const SignInReplySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), text: z.string() }),
  z.object({ status: z.literal('no_form') }),
  MovedReplySchema,
  ClosedReplySchema,
]);

type BrowserPageReply = z.infer<typeof PageReplySchema>;

/** What the sidecar answered to a request, or why there is no usable answer. */
export type SidecarResult<T> = { ok: true; body: T } | { ok: false; message: string };

/** Whose browser and which tab: one profile per person, one tab per chat inside it. */
export interface BrowserTabRef {
  tenant_id: string;
  created_by: string;
  chat_id: string;
}

/** The sidecar's profile key: the same person in another tenant is a different person. */
function profileOwner(tab: BrowserTabRef): string {
  return `${tab.tenant_id}:${tab.created_by}`;
}

const REFUSAL_MESSAGES: Record<string, string> = {
  scheme: 'Aman can only open http and https addresses, never a file or app address.',
  private_network: "That address is on this computer or a private network, so Aman's browser will not open it.",
  unresolved: "That address could not be found, so Aman's browser will not open it. Check the address and try again.",
  not_a_url: 'That is not a web address Aman can open. Check the address and try again.',
};

function refusalMessage(reason: string): string {
  return REFUSAL_MESSAGES[reason] ?? 'Aman will not open that address. Try a different address.';
}

/** Calls one route of the browser sidecar, with the shared secret and the configured navigation timeout. */
export async function callBrowserSidecar<Schema extends z.ZodType>(input: {
  path: string;
  tab: BrowserTabRef;
  schema: Schema;
  body?: Record<string, unknown>;
}): Promise<SidecarResult<z.infer<Schema>>> {
  const baseUrl = configuration.BROWSER_URL;
  const secret = configuration.BROWSER_SECRET;
  if (baseUrl === undefined || secret === undefined) {
    return { ok: false, message: "Aman's browser is not set up on this server. Ask whoever runs Aman to turn it on." };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, configuration.BROWSER_NAV_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${input.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-browser-secret': secret },
      body: JSON.stringify({ ...input.body, owner: profileOwner(input.tab), tab: input.tab.chat_id }),
      signal: controller.signal,
    });
    const json: unknown = await response.json();
    const parsed = input.schema.safeParse(json);
    if (!response.ok || !parsed.success) {
      return { ok: false, message: "Aman's browser could not do that. Try again in a moment." };
    }
    return { ok: true, body: parsed.data };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === 'AbortError'
          ? 'The page took too long to open. Try again, or try a different page.'
          : "Aman's browser could not be reached. Try again in a moment.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The page left the site that was opened (a redirect, or going back). Its content is not shown: reading
 * it is a new `browser_open` of that address, which is classified like any other open.
 */
function movedMessage(url: string): string {
  const shown = url === '' ? 'another site' : url;
  return `The page went to ${shown}, a different site from the one that was opened, so it was not read. To read it, open that address with browser_open.`;
}

const CLOSED_MESSAGE =
  "This chat has no page open in Aman's browser. Pages close to make room for other chats. Open the page with browser_open.";

function errorResponse(message: string): ReturnType<typeof toolResultResponse> {
  return toolResultResponse({ text: JSON.stringify({ status: 'error', message }), isError: true });
}

function pageResult({
  result,
  logger,
}: {
  result: SidecarResult<BrowserPageReply>;
  logger: Logger;
}): ReturnType<typeof toolResultResponse> {
  if (!result.ok) {
    logger.warn('browser sidecar call failed', { message: result.message });
    return errorResponse(result.message);
  }
  switch (result.body.status) {
    case 'refused':
      return errorResponse(refusalMessage(result.body.reason));
    case 'moved':
      return errorResponse(movedMessage(result.body.url));
    case 'closed':
      return errorResponse(CLOSED_MESSAGE);
    case 'ok':
      return toolResultResponse({ text: result.body.text });
  }
}

class BrowserTool extends LocalToolMCP {
  readonly name = BROWSER_SERVER_ID;
  readonly displayName = 'Browser';
  protected override readonly bundle: ToolBundleName = 'browser';

  constructor(
    private readonly tab: BrowserTabRef,
    private readonly logger: Logger,
    tracing: AgentTracing,
  ) {
    super({ tracing });
  }

  private async page(path: string, body?: Record<string, unknown>): Promise<ReturnType<typeof toolResultResponse>> {
    return pageResult({
      result: await callBrowserSidecar({ path, tab: this.tab, schema: PageReplySchema, ...(body && { body }) }),
      logger: this.logger,
    });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: 'browser_open',
      annotations: BROWSER_TOOL_ANNOTATIONS,
      description:
        "Open a web page in Aman's own browser (not the user's browser) and read it back as text. Only http and https addresses; never a file, app or local-network address. Use when the user asks to find something on a site or open a specific page.",
      schema: OPEN_INPUT_SCHEMA,
      handler: async (input: BrowserOpenInput) => this.page('/open', { url: input.url }),
    }),
    defineTool({
      name: 'browser_read',
      annotations: BROWSER_TOOL_ANNOTATIONS,
      description:
        'Read the page currently open in the browser: its title, address, headings, links, buttons and fields, each actionable one with a short ref. A password or payment field never shows its value.',
      schema: EMPTY_INPUT_SCHEMA,
      handler: async () => this.page('/read'),
    }),
    defineTool({
      name: 'browser_scroll',
      annotations: BROWSER_TOOL_ANNOTATIONS,
      description: 'Scroll the open page up or down, then read it again.',
      schema: SCROLL_INPUT_SCHEMA,
      handler: async (input: BrowserScrollInput) => this.page('/scroll', input),
    }),
    defineTool({
      name: 'browser_back',
      annotations: BROWSER_TOOL_ANNOTATIONS,
      description: 'Go back to the previous page in the browser, then read it.',
      schema: EMPTY_INPUT_SCHEMA,
      handler: async () => this.page('/back'),
    }),
    defineTool({
      name: 'browser_sign_in',
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        "Sign in to the site open in the browser with the person's saved login for that site, then read the page. Use when a page asks to sign in or a session has expired. You never see the password.",
      schema: EMPTY_INPUT_SCHEMA,
      handler: async () => this.signIn(),
    }),
    defineTool({
      name: 'browser_screenshot',
      annotations: BROWSER_TOOL_ANNOTATIONS,
      description:
        'Take a picture of the open page and show it to the person in the chat. The model does not see the picture.',
      schema: EMPTY_INPUT_SCHEMA,
      handler: async () => {
        const result = await callBrowserSidecar({ path: '/screenshot', tab: this.tab, schema: ScreenshotReplySchema });
        if (!result.ok) {
          this.logger.warn('browser sidecar call failed', { message: result.message });
          return errorResponse(result.message);
        }
        if (result.body.status === 'moved') {
          return errorResponse(movedMessage(result.body.url));
        }
        if (result.body.status === 'closed') {
          return errorResponse(CLOSED_MESSAGE);
        }
        // The image block goes to the chat for the person; the model reads only the text beside it.
        const response = toolResultResponse({ text: JSON.stringify({ status: 'ok', shown_to_person: true }) });
        return {
          ...response,
          result: {
            ...response.result,
            content: [
              ...response.result.content,
              { type: 'image', data: result.body.png_base64, mimeType: 'image/png' },
            ],
          },
        };
      },
    }),
  ];

  /** Signs in with the saved login for the open page's site. The password goes to the browser and never to the model. */
  private async signIn(): Promise<ReturnType<typeof toolResultResponse>> {
    const where = await callBrowserSidecar({ path: '/where', tab: this.tab, schema: WhereReplySchema });
    if (!where.ok) {
      return errorResponse(where.message);
    }
    if (where.body.status === 'moved') {
      return errorResponse(movedMessage(where.body.url));
    }
    if (where.body.status === 'closed') {
      return errorResponse(CLOSED_MESSAGE);
    }
    let origin: string;
    try {
      origin = new URL(where.body.url).origin;
    } catch {
      return errorResponse('The open page has no web address to sign in to.');
    }
    const login = configuration.BROWSER_LOGINS.find(saved => saved.origin === origin);
    if (login === undefined) {
      return errorResponse(`There is no saved sign-in for ${origin}. Ask the person to add one.`);
    }
    const result = await callBrowserSidecar({
      path: '/sign_in',
      tab: this.tab,
      schema: SignInReplySchema,
      body: { origin, username: login.username, password: login.password },
    });
    if (!result.ok) {
      this.logger.warn('browser sign-in failed', { message: result.message });
      return errorResponse(result.message);
    }
    switch (result.body.status) {
      case 'no_form':
        return errorResponse(
          "No sign-in form was found on the open page. Open the site's sign-in page, then try again.",
        );
      case 'moved':
        return errorResponse(movedMessage(result.body.url));
      case 'closed':
        return errorResponse(CLOSED_MESSAGE);
      case 'ok':
        return toolResultResponse({ text: result.body.text });
    }
  }

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }
}

export interface BrowserCapabilityOptions {
  tracing: AgentTracing;
  logger: Logger;
  /** The person's browser profile (logins persist across their chats) and this chat's own tab in it. */
  tab: BrowserTabRef;
}

/** Build the browser capability. Callers only add this when `configuration.BROWSER_ENABLED` is true. */
export function browserCapability(options: BrowserCapabilityOptions): AgentCapability {
  return { systemToolSets: [new BrowserTool(options.tab, options.logger, options.tracing)] };
}
