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
 * The live view, the person's own look at their browser (see apis/browserLive.ts), reaches the same
 * sidecar through the callers below, so the shared secret stays on this server either way.
 */
import type {
  AgentCapability,
  AgentTracing,
  PreLLMEphemeralAgentContextProcessor,
} from '@truefoundry/trueforge-core/core';
import { defineTool, LocalToolMCP, toolResultResponse, type ToolDefinition } from '@truefoundry/trueforge-core/core';
import type { ToolBundleName } from '@truefoundry/trueforge-core/core/runtime/toolBundleCatalog';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'winston';
import { z } from 'zod';
import configuration from '../config';

export const BROWSER_SERVER_ID = 'browser';

/** Browser tools read a page and move around it; nothing here submits anything. */
const BROWSER_TOOL_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;

const OPEN_INPUT_SCHEMA = z.object({ url: z.string().min(1).max(2048) }).strict();
const SCROLL_INPUT_SCHEMA = z.object({ direction: z.enum(['up', 'down']) }).strict();
const EMPTY_INPUT_SCHEMA = z.object({}).strict();
const CLICK_INPUT_SCHEMA = z.object({ ref: z.string().min(1).max(32) }).strict();
const TYPE_INPUT_SCHEMA = z
  .object({ ref: z.string().min(1).max(32), text: z.string().max(2000), submit: z.boolean().optional() })
  .strict();

const SELECT_INPUT_SCHEMA = z.object({ ref: z.string().min(1).max(32), option: z.string().min(1).max(500) }).strict();

type BrowserClickInput = z.infer<typeof CLICK_INPUT_SCHEMA>;
type BrowserSelectInput = z.infer<typeof SELECT_INPUT_SCHEMA>;
type BrowserTypeInput = z.infer<typeof TYPE_INPUT_SCHEMA>;

/** The sidecar found no element for the ref: the page changed since it was read, or the field is a password. */
const ActReplySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), text: z.string() }),
  z.object({ status: z.literal('no_element') }),
  z.object({ status: z.literal('moved'), url: z.string() }),
  z.object({ status: z.literal('closed') }),
]);

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

/** One open tab of the person's browser, as the live view lists it: the chat it belongs to, its title and address. */
export const LiveTabSchema = z.object({ tab: z.string(), title: z.string(), url: z.string() });
export const LiveTabsReplySchema = z.object({ status: z.literal('ok'), tabs: z.array(LiveTabSchema) });
export const LiveFrameReplySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    jpeg_base64: z.string().min(1),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
  ClosedReplySchema,
]);
export const LiveInputReplySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('bad_input') }),
  ClosedReplySchema,
]);

export type LiveTabsReply = z.infer<typeof LiveTabsReplySchema>;
export type LiveFrameReply = z.infer<typeof LiveFrameReplySchema>;
export type LiveInputReply = z.infer<typeof LiveInputReplySchema>;

/** What the sidecar answered to a request, or why there is no usable answer. */
export type SidecarResult<T> = { ok: true; body: T } | { ok: false; message: string };

/** Whose browser: one profile per person. */
export interface BrowserProfileRef {
  tenant_id: string;
  created_by: string;
}

/** Whose browser and which tab: one profile per person, one tab per chat inside it. */
export interface BrowserTabRef extends BrowserProfileRef {
  chat_id: string;
}

/** The sidecar's profile key: the same person in another tenant is a different person. */
function profileOwner(profile: BrowserProfileRef): string {
  return `${profile.tenant_id}:${profile.created_by}`;
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

/** Posts one call to the browser sidecar, with the shared secret and the configured navigation timeout. */
async function postSidecar<Schema extends z.ZodType>(input: {
  path: string;
  schema: Schema;
  payload: Record<string, unknown>;
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
      body: JSON.stringify(input.payload),
      signal: controller.signal,
    });
    const json: unknown = await response.json();
    const parsed = input.schema.safeParse(json);
    if (!response.ok || !parsed.success) {
      const detail =
        typeof json === 'object' && json !== null && 'message' in json && typeof json.message === 'string'
          ? ` (${json.message.slice(0, 300)})`
          : '';
      return { ok: false, message: `Aman's browser could not do that${detail}. Try again in a moment.` };
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

/** Calls one route of the browser sidecar for one chat's tab. */
export async function callBrowserSidecar<Schema extends z.ZodType>(input: {
  path: string;
  tab: BrowserTabRef;
  schema: Schema;
  body?: Record<string, unknown>;
}): Promise<SidecarResult<z.infer<Schema>>> {
  return postSidecar({
    path: input.path,
    schema: input.schema,
    payload: { ...input.body, owner: profileOwner(input.tab), tab: input.tab.chat_id },
  });
}

/** Calls one route of the browser sidecar for a person's whole profile, naming no tab (the live view's tab list). */
export async function callBrowserSidecarForOwner<Schema extends z.ZodType>(input: {
  path: string;
  profile: BrowserProfileRef;
  schema: Schema;
  body?: Record<string, unknown>;
}): Promise<SidecarResult<z.infer<Schema>>> {
  return postSidecar({
    path: input.path,
    schema: input.schema,
    payload: { ...input.body, owner: profileOwner(input.profile) },
  });
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
    private readonly screenshots: Map<string, string>,
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
      name: 'browser_click',
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        'Click a link, button or other control on the open page by its ref from the last read (like e14), then read the page. The page stays on the site that was opened.',
      schema: CLICK_INPUT_SCHEMA,
      handler: async (input: BrowserClickInput) => this.act('/click', input),
    }),
    defineTool({
      name: 'browser_select',
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        'Pick a choice in a dropdown (combobox) on the open page by its ref and the choice text shown in the last read, then read the page. For checkboxes, radio buttons and custom dropdowns, use browser_click.',
      schema: SELECT_INPUT_SCHEMA,
      handler: async (input: BrowserSelectInput) => this.act('/select', input),
    }),
    defineTool({
      name: 'browser_type',
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        'Type text into a field on the open page by its ref from the last read, replacing what is there. Set submit to press Enter afterwards. Never for passwords: use browser_sign_in.',
      schema: TYPE_INPUT_SCHEMA,
      handler: async (input: BrowserTypeInput) => this.act('/type', input),
    }),
    defineTool({
      name: 'browser_sign_in',
      annotations: { readOnlyHint: false, openWorldHint: true },
      description:
        "Sign in to the site open in the browser with the person's saved login for that site, then read the page. Use when a page asks to sign in or a session has expired. You never see the password. If signing in then asks for a step only the person can do, like a code sent to their phone or a picture check, ask them to open Aman's live browser at /browser-live and finish there; what they do stays in the browser for your next read.",
      schema: EMPTY_INPUT_SCHEMA,
      handler: async () => this.signIn(),
    }),
    defineTool({
      name: 'browser_screenshot',
      annotations: BROWSER_TOOL_ANNOTATIONS,
      description:
        'Take a picture of the open page, show it to the person in the chat, and look at it yourself. Use it when the page text is not enough, for example for a layout, a chart or a picture check.',
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
        // The image block goes to the chat for the person; the picture also reaches the model through
        // the screenshot viewer below, as an image right after this result.
        const picture = randomUUID();
        this.screenshots.set(picture, result.body.png_base64);
        const response = toolResultResponse({
          text: JSON.stringify({
            status: 'ok',
            shown_to_person: true,
            picture,
            note: 'The picture follows as an image.',
          }),
        });
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

  private async act(path: string, body: Record<string, unknown>): Promise<ReturnType<typeof toolResultResponse>> {
    const result = await callBrowserSidecar({ path, tab: this.tab, schema: ActReplySchema, body });
    if (!result.ok) {
      this.logger.warn('browser sidecar call failed', { message: result.message });
      return errorResponse(result.message);
    }
    switch (result.body.status) {
      case 'no_element':
        return errorResponse(
          'That ref is not on the page any more, the choice is not in that dropdown, or it is a password field. Read the page again with browser_read and use a ref from that read. Use browser_sign_in for passwords.',
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
type LlmMessages = Parameters<PreLLMEphemeralAgentContextProcessor['processPreLLMEphemeral']>[0];

/**
 * Shows this reply's screenshots to the model: each one goes in as an image right after the tool
 * results it came with. Only pictures taken in this reply are kept, so older ones never come back.
 */
class ScreenshotViewer implements PreLLMEphemeralAgentContextProcessor {
  constructor(private readonly screenshots: Map<string, string>) {}

  processPreLLMEphemeral(input: LlmMessages): LlmMessages | undefined {
    if (this.screenshots.size === 0) {
      return undefined;
    }
    const messages = [...input];
    for (const [picture, png] of this.screenshots) {
      const at = messages.findIndex(
        message => message.role === 'tool' && typeof message.content === 'string' && message.content.includes(picture),
      );
      if (at < 0) {
        continue;
      }
      let after = at + 1;
      while (after < messages.length && messages[after]?.role === 'tool') {
        after += 1;
      }
      messages.splice(after, 0, {
        role: 'user',
        content: [
          { type: 'text', text: 'The browser screenshot you just took:' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
        ],
      });
    }
    return messages;
  }
}

export function browserCapability(options: BrowserCapabilityOptions): AgentCapability {
  const screenshots = new Map<string, string>();
  return {
    systemToolSets: [new BrowserTool(options.tab, options.logger, options.tracing, screenshots)],
    preLLMEphemeralProcessors: [new ScreenshotViewer(screenshots)],
  };
}
