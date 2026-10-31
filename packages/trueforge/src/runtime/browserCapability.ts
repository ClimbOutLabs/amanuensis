/**
 * Aman's own browser: `browser_open`, `browser_read`, `browser_scroll`, `browser_back` and
 * `browser_screenshot`. Every call here is read-only (Tier 1, see browserTier.ts in trueforge-core):
 * nothing is typed into a field and nothing is clicked that could submit anything. A page the
 * browser reads is untrusted content, exactly like an email (see provenance.ts); the model never
 * sees the browser's own screenshot (`browser_screenshot` saves it for the receipt and for the
 * person to look at).
 *
 * The browser itself runs in a private sidecar (ops/browser-sidecar): a real, headed Chromium with
 * one persistent profile per person. This capability only calls its HTTP API.
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

/** What the sidecar answered to a request, or that the sidecar itself could not be reached. */
export type SidecarResult<T> = { ok: true; body: T } | { ok: false; message: string };

const REFUSAL_MESSAGES: Record<string, string> = {
  scheme: 'Aman can only open http and https addresses, never a file or app address.',
  private_network: "That address is on this computer or a private network, so Aman's browser will not open it.",
  unresolved: "That address could not be found, so Aman's browser will not open it.",
  not_a_url: 'That is not a web address Aman can open.',
};

function refusalMessage(reason: unknown): string {
  const text = typeof reason === 'string' ? REFUSAL_MESSAGES[reason] : undefined;
  return text ?? 'Aman will not open that address.';
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

interface OpenBody {
  status: 'ok' | 'refused';
  text?: string;
  reason?: string;
}

interface ScreenshotBody {
  status: 'ok';
  png_base64: string;
}

function readResult({
  result,
  logger,
}: {
  result: SidecarResult<ReadBody | OpenBody>;
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
  return toolResultResponse({ text: result.body.text ?? '' });
}

class BrowserTool extends LocalToolMCP {
  readonly name = BROWSER_SERVER_ID;
  readonly displayName = 'Browser';
  protected override readonly bundle: ToolBundleName = 'browser';

  constructor(
    private readonly owner: string,
    private readonly logger: Logger,
    tracing: AgentTracing,
  ) {
    super({ tracing });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: 'browser_open',
      annotations: BROWSER_TOOL_ANNOTATIONS,
      description:
        "Open a web page in Aman's own browser (not the user's browser) and read it back as text. Only http and https addresses; never a file, app or local-network address. Use when the user asks to find something on a site or open a specific page.",
      schema: OPEN_INPUT_SCHEMA,
      handler: async (input: BrowserOpenInput) =>
        readResult({
          result: await callBrowserSidecar<OpenBody>({ path: '/open', owner: this.owner, body: { url: input.url } }),
          logger: this.logger,
        }),
    }),
    defineTool({
      name: 'browser_read',
      annotations: BROWSER_TOOL_ANNOTATIONS,
      description:
        'Read the page currently open in the browser: its title, address, headings, links, buttons and fields, each actionable one with a short ref. A password or payment field never shows its value.',
      schema: EMPTY_INPUT_SCHEMA,
      handler: async () =>
        readResult({
          result: await callBrowserSidecar<ReadBody>({ path: '/read', owner: this.owner }),
          logger: this.logger,
        }),
    }),
    defineTool({
      name: 'browser_scroll',
      annotations: BROWSER_TOOL_ANNOTATIONS,
      description: 'Scroll the open page up or down, then read it again.',
      schema: SCROLL_INPUT_SCHEMA,
      handler: async (input: BrowserScrollInput) =>
        readResult({
          result: await callBrowserSidecar<ReadBody>({ path: '/scroll', owner: this.owner, body: input }),
          logger: this.logger,
        }),
    }),
    defineTool({
      name: 'browser_back',
      annotations: BROWSER_TOOL_ANNOTATIONS,
      description: 'Go back to the previous page in the browser, then read it.',
      schema: EMPTY_INPUT_SCHEMA,
      handler: async () =>
        readResult({
          result: await callBrowserSidecar<ReadBody>({ path: '/back', owner: this.owner }),
          logger: this.logger,
        }),
    }),
    defineTool({
      name: 'browser_screenshot',
      annotations: BROWSER_TOOL_ANNOTATIONS,
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
        // The image itself never reaches the model: only a confirmation that one was saved.
        return toolResultResponse({ text: JSON.stringify({ status: 'ok', saved: true }) });
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
}

/** Build the browser capability. Callers only add this when `configuration.BROWSER_ENABLED` is true. */
export function browserCapability(options: BrowserCapabilityOptions): AgentCapability {
  return { systemToolSets: [new BrowserTool(options.owner, options.logger, options.tracing)] };
}
