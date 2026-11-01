import { z } from 'zod';

import type { CreateTrueForgeClientOptions } from '../client.js';

/** Why an image is not shown; the UI words each one. */
export const ChatImageRefusalSchema = z.enum([
  'unsupported_type',
  'too_large',
  'undecodable',
  'fetch_failed',
  'offline',
  'blocked',
  'sandbox_unavailable',
]);
export type ChatImageRefusal = z.infer<typeof ChatImageRefusalSchema>;

/** Where an image comes from. The server reads the bytes or the link from the turn itself. */
export type ChatImageSource =
  | { kind: 'upload'; index: number }
  | { kind: 'artifact'; path: string }
  | { kind: 'email'; tool_call_id: string }
  | { kind: 'reply'; url: string };

const ChatImageOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('shown'),
    image_id: z.string().regex(/^[0-9a-f]{32}$/),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.object({ status: z.literal('refused'), reason: ChatImageRefusalSchema }),
]);
export type ChatImageOutcome = z.infer<typeof ChatImageOutcomeSchema>;

const TurnImagesResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done'), images: z.array(ChatImageOutcomeSchema) }),
  z.object({ status: z.literal('ask'), count: z.number().int().positive(), host: z.string().nullable() }),
]);
export type TurnImagesResult = z.infer<typeof TurnImagesResultSchema>;

const TurnImageListSchema = z.object({
  artifacts: z.array(z.object({ path: z.string(), name: z.string() })),
  tool_images: z.array(z.object({ path: z.string(), name: z.string() })),
  emails: z.array(z.object({ tool_call_id: z.string(), count: z.number().int().positive() })),
});
export type TurnImageList = z.infer<typeof TurnImageListSchema>;

export interface ChatImagesCatalog {
  listTurnImages(input: { sessionId: string; turnId: string }): Promise<TurnImageList>;
  showTurnImages(input: {
    sessionId: string;
    turnId: string;
    source: ChatImageSource;
    approved: boolean;
  }): Promise<TurnImagesResult>;
  /** Same-origin address of a re-encoded image; the only image address chat renders. */
  imageUrl(input: { sessionId: string; imageId: string }): string;
}

/**
 * Calls the browser-only `/api/chat-images` routes. They accept the browser session cookie and refuse
 * any bearer token, so no Authorization header is sent even when the client has one.
 */
export function createChatImagesCatalog(options: CreateTrueForgeClientOptions = {}): ChatImagesCatalog {
  const base = (options.baseUrl ?? '/').replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const turnPath = (input: { sessionId: string; turnId: string }) =>
    `${base}/api/chat-images/sessions/${encodeURIComponent(input.sessionId)}/turns/${encodeURIComponent(input.turnId)}`;

  async function request<T>(input: { url: string; body: unknown; schema: z.ZodType<T> }): Promise<T> {
    const response = await fetchImpl(input.url, {
      method: input.body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: input.body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new Error(`Chat images request failed with HTTP ${String(response.status)}`);
    }
    const parsed = z.object({ data: input.schema }).safeParse(body);
    if (!parsed.success) {
      throw new Error('The server returned an unexpected chat images payload');
    }
    return parsed.data.data;
  }

  return {
    listTurnImages: input => request({ url: turnPath(input), body: undefined, schema: TurnImageListSchema }),
    showTurnImages: ({ source, approved, ...turn }) =>
      request({ url: turnPath(turn), body: { source, approved }, schema: TurnImagesResultSchema }),
    imageUrl: input =>
      `${base}/api/chat-images/sessions/${encodeURIComponent(input.sessionId)}/images/${encodeURIComponent(input.imageId)}`,
  };
}
