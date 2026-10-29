import { createAlibaba } from '@ai-sdk/alibaba';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import type { MoonshotAIProviderOptions } from '@ai-sdk/moonshotai';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import type { OpenAIResponsesProviderOptions } from '@ai-sdk/openai';
import { createOpenAI } from '@ai-sdk/openai';
import type { OpenAICompatibleProviderOptions } from '@ai-sdk/openai-compatible';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { JSONObject, LanguageModelV4 } from '@ai-sdk/provider';
import type { ProviderOptions, ReasoningPart } from '@ai-sdk/provider-utils';
import type {
  AssistantContent,
  CallWarning,
  FilePart,
  FinishReason,
  JSONValue,
  LanguageModel,
  LanguageModelCallOptions,
  ModelMessage,
  ProviderMetadata,
  TextPart,
  TextStreamPart,
  ToolCallPart,
  ToolContent,
  ToolSet,
  UserContent,
} from 'ai';
import { APICallError, jsonSchema, Output, streamText, wrapLanguageModel } from 'ai';
import type {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat';
import type { Logger } from 'winston';
import { personMessageIndex } from '../runtime/contextUtils';
import { MAX_TOOL_CALLS_PER_REPLY } from '../runtime/modelReplyGuard';
import { describeUnknownError, extractErrorLogFields } from '../util/errorLogFields';
import { withFailover } from './failoverLanguageModel';
import type { ILLM, LLMCreateParams, LLMCreateParamsStreaming } from './ILLM';
import {
  type CompletionUsage,
  type ExtendedChatCompletionChunk,
  getEmptyUsage,
  type RawAssistantMessage,
  type RawAssistantMessageWithUsage,
  type RepetitionStop,
  type ThinkingBlock,
} from './LLMTypes';
import { resolveMaxOutputTokens } from './maxOutputTokens';
import { reasoningTagMiddleware } from './reasoningTags';
import { RepeatedUnitGuard } from './repeatedUnitGuard';
import { noticeAfter, REPEAT_STOP_NOTE } from './replyNotices';
import {
  DEFAULT_MODEL_TOOL_CALL_IDLE_TIMEOUT_MS,
  recordStreamDeadlineDetails,
  type StreamDeadlineDetails,
  streamDeadlineDetailsOf,
} from './streamDeadline';
import { ToolMarkupGuard } from './toolMarkup';

// ---------------------------------------------------------------------------
// Public config
// ---------------------------------------------------------------------------

/**
 * Providers with a case in {@link buildLanguageModel}. Canonical: the server derives the provider
 * types it will configure from this, so anything it accepts has an adapter behind it.
 */
export const VERCEL_AI_PROVIDER_NAMES = [
  'openai',
  'anthropic',
  'google-gemini',
  'fireworks',
  'zai',
  'moonshot',
  'alibaba',
  'together',
  'custom',
  'truefoundry',
  'tokenfactory',
] as const;

export type VercelAIProviderName = (typeof VERCEL_AI_PROVIDER_NAMES)[number];

/**
 * Adapter-facing config, camelCase throughout. Callers translate from the snake_case wire and
 * storage shapes, which stay as they are because they are the published contract.
 */
export interface VercelAIProviderConfig {
  /** Adapter discriminator plus configured resource name (source `type/name/...`). */
  provider: {
    type: VercelAIProviderName;
    name: string;
  };
  /** Provider-facing model identifier and configured model name. */
  model: {
    id: string;
    name: string;
  };
  /** Display name / alias, used for logs and chunk labels. */
  name: string;
  /** Optional base URL override. Explicitly includes `undefined` for Zod-derived type compat. */
  baseUrl?: string | undefined;
  apiKey: string;
  headers: Record<string, string>;
}

/**
 * Canonical camelCase shape for a provider's stream progress deadlines. Every layer that has
 * already converted from the wire's snake_case (`ModelProviderStreamTimeoutSchema` in
 * `packages/trueforge/src/schemas/modelProvider.ts`) reuses this instead of redeclaring the shape:
 * the trueforge runtime (`sessionResources.ts`), this config, and the trueforge-ui Settings adapter.
 */
export interface StreamTimeout {
  firstChunkMs?: number;
  chunkMs?: number;
}

export interface VercelAILLMConfig {
  providerConfig: VercelAIProviderConfig;
  logger: Logger;
  signal?: AbortSignal;
  /** Host-owned deadlines, fully resolved (no field left to default); never supplied by model-generated request parameters. */
  streamTimeout?: Required<StreamTimeout> | undefined;
  /**
   * Host-owned bound on silence between pieces while a tool call is open. Never shorter than the
   * ordinary per-chunk deadline. Undefined falls back to DEFAULT_MODEL_TOOL_CALL_IDLE_TIMEOUT_MS.
   */
  toolCallChunkMs?: number | undefined;
  /**
   * Host-owned per-tool limits on streamed argument characters, keyed by tool name. A call
   * whose arguments run past its limit is stopped mid-stream and named on the result's
   * size_cut_tool_calls, so the reply guard can refuse it with a plain message instead of
   * the turn buffering a call the tool layer would refuse anyway. Tools absent from the
   * map have no limit. Undefined means no tool has one.
   */
  toolArgumentLimits?: ReadonlyMap<string, number> | undefined;
  /**
   * Optional secondary provider config. When set, a request that fails on the primary
   * before producing output is retried once on this provider (see `withFailover`).
   */
  fallbackProviderConfig?: VercelAIProviderConfig | undefined;
  /** Called, before any output, each time a request actually fell over to the fallback provider. */
  onFallback?: (() => void) | undefined;
}

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

/** Narrows to an indexable record. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** OpenAI SDK v7 unions function + custom tools; harness only emits function tools. */
function isFunctionTool(tool: ChatCompletionTool): tool is Extract<ChatCompletionTool, { type: 'function' }> {
  return tool.type === 'function';
}

/** OpenAI SDK v7 unions function + custom tool calls; harness only consumes function calls. */
function isFunctionToolCall<T extends { type: string }>(toolCall: T): toolCall is Extract<T, { type: 'function' }> {
  return toolCall.type === 'function';
}

// ---------------------------------------------------------------------------
// Model construction
// ---------------------------------------------------------------------------

/**
 * Shared by every OpenAI-compatible provider, which differ only by endpoint. The provider type
 * doubles as the `providerOptions` key. Fireworks, Together and Z AI stay here rather than on their
 * own packages: those drop `json_schema`, and Fireworks also clamps efforts its models do accept.
 * TODO: move Z AI to @ai-sdk/zai once https://github.com/vercel/ai/pull/17340 ships.
 */
/**
 * Default Nebius Token Factory endpoint, used when a `tokenfactory` provider record does
 * not set its own base URL. Token Factory is OpenAI-compatible.
 */
export const TOKEN_FACTORY_DEFAULT_BASE_URL = 'https://api.tokenfactory.nebius.com/v1';

function compatibleModel(config: VercelAIProviderConfig): LanguageModelV4 {
  const { provider, model, apiKey, headers, baseUrl } = config;
  if (baseUrl === undefined) {
    throw new Error(`Provider "${provider.type}" requires a baseUrl`);
  }
  const client = createOpenAICompatible({
    name: provider.type,
    baseURL: baseUrl,
    apiKey,
    // Without this the adapter silently downgrades json_schema to a schema-less json_object.
    supportsStructuredOutputs: true,
    // These endpoints omit token counts from streamed responses unless asked.
    includeUsage: true,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
  return client(model.id);
}

/**
 * `reasoningRequested` is set when the request asks for reasoning. Only then can a reply start with
 * reasoning that ends at a bare `</think>` (the opening tag sat in the prompt), and that case holds
 * the answer text until the reply shows which it is.
 */
export function buildLanguageModel(
  config: VercelAIProviderConfig,
  { reasoningRequested = false }: { reasoningRequested?: boolean } = {},
): LanguageModelV4 {
  const { provider, model, baseUrl, apiKey, headers } = config;
  const extraHeaders = Object.keys(headers).length > 0 ? headers : undefined;

  switch (provider.type) {
    case 'openai': {
      const client = createOpenAI({
        apiKey,
        ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
        ...(extraHeaders !== undefined ? { headers: extraHeaders } : {}),
      });
      return client.responses(model.id);
    }
    case 'anthropic': {
      const client = createAnthropic({
        apiKey,
        ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
        ...(extraHeaders !== undefined ? { headers: extraHeaders } : {}),
      });
      return client(model.id);
    }
    case 'google-gemini': {
      const client = createGoogle({
        apiKey,
        ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
        ...(extraHeaders !== undefined ? { headers: extraHeaders } : {}),
      });
      return client(model.id);
    }
    case 'moonshot': {
      const client = createMoonshotAI({
        apiKey,
        ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
        ...(extraHeaders !== undefined ? { headers: extraHeaders } : {}),
      });
      return client(model.id);
    }
    case 'alibaba': {
      // Endpoints are workspace-scoped, so the package default would address the wrong tenant.
      if (baseUrl === undefined) {
        throw new Error(`Provider "alibaba" requires a baseUrl`);
      }
      const client = createAlibaba({
        apiKey,
        baseURL: baseUrl,
        ...(extraHeaders !== undefined ? { headers: extraHeaders } : {}),
      });
      return client(model.id);
    }
    case 'fireworks':
    case 'zai':
    case 'together':
    case 'custom':
    case 'truefoundry': {
      return compatibleModel(config);
    }
    case 'tokenfactory': {
      // Token Factory is OpenAI-compatible. A provider record may override the base
      // URL (for example the regional endpoint); otherwise the default applies.
      const baseUrl = config.baseUrl ?? TOKEN_FACTORY_DEFAULT_BASE_URL;
      // Some served models write their reasoning into the answer text between think tags.
      return wrapLanguageModel({
        model: compatibleModel({ ...config, baseUrl }),
        middleware: reasoningTagMiddleware({ bareClose: reasoningRequested }),
      });
    }
    default: {
      const _exhaustive: never = provider.type;
      throw new Error(`Unknown provider "${String(_exhaustive)}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------

/**
 * The cross-provider `streamText({ reasoning })` setting, distinct from `providerOptions`. Derived
 * from the SDK's own type rather than mirrored by hand.
 */
type ReasoningLevel = NonNullable<LanguageModelCallOptions['reasoning']>;

const COMMON_REASONING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly ReasoningLevel[];

const VERCEL_AI_REASONING_LEVELS = [
  'provider-default',
  ...COMMON_REASONING_LEVELS,
] as const satisfies readonly ReasoningLevel[];

// Fails if any union member is missing.
true satisfies Exclude<ReasoningLevel, (typeof VERCEL_AI_REASONING_LEVELS)[number]> extends never ? true : never;

function isReasoningLevel(v: string): v is ReasoningLevel {
  return VERCEL_AI_REASONING_LEVELS.some(level => level === v);
}

/**
 * Efforts the SDK's union cannot express. `xhigh` is its ceiling, so `max` rides in as `xhigh`;
 * Anthropic's adapter raises that back, and {@link maxEffortOption} covers the rest.
 * Keys here must also appear in {@link SUPPORTED_REASONING_EFFORTS}.
 */
const EFFORT_ALIASES: Readonly<Record<string, ReasoningLevel>> = { max: 'xhigh' };

/** What a model may advertise in `reasoning_efforts`; anything else resolves to the provider default. */
export const SUPPORTED_REASONING_EFFORTS = [...COMMON_REASONING_LEVELS, 'max'] as const;

/**
 * The effort travels on the top-level `reasoning` setting, which each adapter translates per model:
 * an effort string for OpenAI-shaped APIs, a thinking shape for Anthropic, a level or budget for
 * Gemini. A reasoning `providerOptions` entry replaces that path rather than merging with it.
 */
export function toReasoningLevel(reasoningEffort: string | undefined): ReasoningLevel | undefined {
  if (reasoningEffort === undefined) {
    return undefined;
  }
  const aliased = EFFORT_ALIASES[reasoningEffort];
  if (aliased !== undefined) {
    return aliased;
  }
  return isReasoningLevel(reasoningEffort) ? reasoningEffort : undefined;
}

/**
 * `max` needs each adapter's own option, which wins over the top-level setting; the callers below
 * say why. The intersection resolves to `'max'`, so a package dropping it breaks the build.
 */
type MaxEffortOption = Pick<OpenAIResponsesProviderOptions, 'reasoningEffort'> &
  Pick<OpenAICompatibleProviderOptions, 'reasoningEffort'> &
  Pick<MoonshotAIProviderOptions, 'reasoningEffort'>;

function maxEffortOption(reasoningEffort: string | undefined): MaxEffortOption {
  return reasoningEffort === 'max' ? { reasoningEffort: 'max' } : {};
}

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

/**
 * Kept as plain data rather than an SDK `Output` instance, since `Output` isn't a nameable
 * exported type from `ai` — see `buildOutput`.
 */
export type StructuredOutputSpec =
  | { mode: 'text' }
  | { mode: 'json' }
  | {
      mode: 'json_schema';
      schema: Record<string, unknown>;
      name: string;
      description: string | undefined;
      /** Mirrors `response_format.json_schema.strict`; consumed by `buildProviderOptions`. */
      strict: boolean | undefined;
    };

/** Converts an OpenAI-format `response_format` into a normalized `StructuredOutputSpec`. */
export function toStructuredOutputSpec(
  responseFormat: ChatCompletionCreateParamsStreaming['response_format'],
): StructuredOutputSpec {
  if (responseFormat === undefined || responseFormat.type === 'text') {
    return { mode: 'text' };
  }
  if (responseFormat.type === 'json_object') {
    return { mode: 'json' };
  }
  const { json_schema } = responseFormat;
  return {
    mode: 'json_schema',
    schema: json_schema.schema ?? { type: 'object', properties: {} },
    name: json_schema.name,
    description: json_schema.description,
    strict: json_schema.strict ?? undefined,
  };
}

/** Not exported: `Output`'s type isn't nameable outside `ai`, so a return type can't be declared. */
function buildOutput(spec: StructuredOutputSpec) {
  switch (spec.mode) {
    case 'text':
      return undefined;
    case 'json':
      return Output.json();
    case 'json_schema':
      return Output.object({
        schema: jsonSchema(spec.schema),
        name: spec.name,
        ...(spec.description !== undefined ? { description: spec.description } : {}),
      });
    default: {
      const _exhaustive: never = spec;
      throw new Error(`Unknown structured output mode: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider options
// ---------------------------------------------------------------------------

/** `rawBody` is a parsed JSON request body, so any value present is a valid JSONValue. */
function readBodyField({ rawBody, key }: { rawBody: unknown; key: string }): JSONValue | undefined {
  const val: unknown = Reflect.get(Object(rawBody), key);
  return val !== undefined ? (val as JSONValue) : undefined;
}

function openaiProviderOptions({
  rawBody,
  strictJsonSchema,
  reasoningEffort,
}: {
  rawBody: unknown;
  strictJsonSchema: boolean | undefined;
  reasoningEffort: string | undefined;
}): JSONObject {
  const serviceTier = readBodyField({ rawBody, key: 'service_tier' });
  const user = readBodyField({ rawBody, key: 'user' });
  const promptCacheKey = readBodyField({ rawBody, key: 'prompt_cache_key' });
  const parallelToolCalls = readBodyField({ rawBody, key: 'parallel_tool_calls' });
  const reasoningSummary = readBodyField({ rawBody, key: 'reasoning_summary' });
  // No server-side storage, and request the encrypted reasoning token so replay stays stateless.
  return {
    store: false,
    include: ['reasoning.encrypted_content'],
    reasoningSummary: 'auto',
    // gpt-5.6 serves both xhigh and max, so the aliased top-level level asks for one rung less.
    ...maxEffortOption(reasoningEffort),
    ...(reasoningSummary !== undefined ? { reasoningSummary } : {}),
    ...(strictJsonSchema !== undefined ? { strictJsonSchema } : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
    ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
  };
}

/**
 * Forwards but never pins `thinking` and `effort`: both replace the adapter's per-model resolution
 * and no single value fits every model. This is the caller's only route to disabling thinking, or to
 * the `display: 'summarized'` that makes Claude 5 return reasoning text instead of an empty block.
 *
 * Prompt caching defaults on: Anthropic bills a write once, then cheaper reads on stable prefixes
 * (system / tools / early messages). Callers can override via `cache_control` in the request body.
 */
function anthropicProviderOptions(rawBody: unknown): JSONObject | undefined {
  const cacheControl = readBodyField({ rawBody, key: 'cache_control' }) ?? { type: 'ephemeral' };
  const disableParallelToolUse = readBodyField({ rawBody, key: 'disable_parallel_tool_use' });
  const thinking = readBodyField({ rawBody, key: 'thinking' });
  const effort = readBodyField({ rawBody, key: 'effort' });
  const opts: JSONObject = {
    cacheControl,
    ...(disableParallelToolUse !== undefined ? { disableParallelToolUse } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
  return opts;
}

/**
 * Gemini returns thought summaries only when `includeThoughts` is set, and `@ai-sdk/google` omits it
 * — without this the model bills reasoning tokens and returns none. The effort itself rides in the
 * top-level `reasoning` setting. An explicit `thinking_config` in the request body wins.
 */
function googleGeminiThinkingConfig({
  rawBody,
  reasoningRequested,
}: {
  rawBody: unknown;
  reasoningRequested: boolean;
}): JSONValue | undefined {
  const fromBody = readBodyField({ rawBody, key: 'thinking_config' });
  if (!reasoningRequested) {
    return fromBody;
  }
  if (typeof fromBody === 'object' && fromBody !== null && !Array.isArray(fromBody)) {
    return { includeThoughts: true, ...fromBody };
  }
  return { includeThoughts: true };
}

function googleGeminiProviderOptions({
  rawBody,
  reasoningRequested,
}: {
  rawBody: unknown;
  reasoningRequested: boolean;
}): JSONObject | undefined {
  const safetySettings = readBodyField({ rawBody, key: 'safety_settings' });
  const thinkingConfig = googleGeminiThinkingConfig({ rawBody, reasoningRequested });
  const cachedContent = readBodyField({ rawBody, key: 'cached_content' });
  const opts: JSONObject = {
    ...(safetySettings !== undefined ? { safetySettings } : {}),
    ...(thinkingConfig !== undefined ? { thinkingConfig } : {}),
    ...(cachedContent !== undefined ? { cachedContent } : {}),
  };
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * `thinking` and `reasoning_history` are forwarded but never pinned: they are the caller's route to
 * turning thinking off, or to replaying it verbatim.
 */
function moonshotProviderOptions({
  rawBody,
  reasoningEffort,
}: {
  rawBody: unknown;
  reasoningEffort: string | undefined;
}): JSONObject | undefined {
  const thinking = readBodyField({ rawBody, key: 'thinking' });
  const reasoningHistory = readBodyField({ rawBody, key: 'reasoning_history' });
  const opts: JSONObject = {
    // Moonshot's own ceiling is `max`; the aliased `xhigh` is not one of its levels.
    ...maxEffortOption(reasoningEffort),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(reasoningHistory !== undefined ? { reasoningHistory } : {}),
  };
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/** Qwen resolves the top-level effort into a thinking budget; these override that resolution. */
function alibabaProviderOptions(rawBody: unknown): JSONObject | undefined {
  const enableThinking = readBodyField({ rawBody, key: 'enable_thinking' });
  const thinkingBudget = readBodyField({ rawBody, key: 'thinking_budget' });
  const parallelToolCalls = readBodyField({ rawBody, key: 'parallel_tool_calls' });
  const opts: JSONObject = {
    ...(enableThinking !== undefined ? { enableThinking } : {}),
    ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
    ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
  };
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * The adapter copies options outside its own schema into the body under the same key, so these are
 * wire names, not camelCase. Unvalidated: a field the endpoint rejects fails loudly.
 */
const COMPATIBLE_BODY_FIELDS = [
  'service_tier',
  'user',
  'prompt_cache_key',
  'parallel_tool_calls',
  'thinking',
  'thinking_budget',
  'reasoning_history',
] as const;

function compatibleProviderOptions({
  strictJsonSchema,
  reasoningEffort,
  rawBody,
}: {
  strictJsonSchema: boolean | undefined;
  reasoningEffort: string | undefined;
  rawBody: unknown;
}): JSONObject | undefined {
  const chatTemplateKwargs = readBodyField({ rawBody, key: 'chat_template_kwargs' });
  const enableThinking = readBodyField({ rawBody, key: 'enable_thinking' });
  const forwardedChatTemplateKwargs =
    enableThinking === undefined
      ? chatTemplateKwargs
      : {
          ...(isPlainObject(chatTemplateKwargs) ? chatTemplateKwargs : {}),
          enable_thinking: enableThinking,
        };
  const forwarded: JSONObject = Object.fromEntries(
    COMPATIBLE_BODY_FIELDS.flatMap(key => {
      const value = readBodyField({ rawBody, key });
      return value === undefined ? [] : [[key, value] as const];
    }),
  );
  const opts: JSONObject = {
    // These endpoints discard an effort they do not recognise, and `xhigh` is one of those.
    ...maxEffortOption(reasoningEffort),
    ...forwarded,
    ...(forwardedChatTemplateKwargs !== undefined
      ? {
          chat_template_kwargs: forwardedChatTemplateKwargs,
        }
      : {}),
    ...(strictJsonSchema !== undefined ? { strictJsonSchema } : {}),
  };
  return Object.keys(opts).length > 0 ? opts : undefined;
}

/**
 * Provider-specific fields in `rawBody` (`cache_control`, `service_tier`, `safety_settings`, …)
 * are forwarded by snake_case key with no validation.
 */
export function buildProviderOptions({
  config,
  reasoningEffort,
  structuredOutputSpec,
  rawBody,
}: {
  config: VercelAIProviderConfig;
  /** The requested effort, which rides in the top-level `reasoning` setting for every provider. */
  reasoningEffort: string | undefined;
  structuredOutputSpec: StructuredOutputSpec;
  rawBody: unknown;
}): ProviderOptions {
  const strictJsonSchema = structuredOutputSpec.mode === 'json_schema' ? structuredOutputSpec.strict : undefined;
  if (config.provider.type === 'openai') {
    return { openai: openaiProviderOptions({ rawBody, strictJsonSchema, reasoningEffort }) };
  } else if (config.provider.type === 'anthropic') {
    const anthropic = anthropicProviderOptions(rawBody);
    return anthropic !== undefined ? { anthropic } : {};
  } else if (config.provider.type === 'google-gemini') {
    const google = googleGeminiProviderOptions({ rawBody, reasoningRequested: reasoningEffort !== undefined });
    return google !== undefined ? { google } : {};
  } else if (config.provider.type === 'moonshot') {
    // The package names its options key after itself, not after the provider.
    const moonshotai = moonshotProviderOptions({ rawBody, reasoningEffort });
    return moonshotai !== undefined ? { moonshotai } : {};
  } else if (config.provider.type === 'alibaba') {
    const alibaba = alibabaProviderOptions(rawBody);
    return alibaba !== undefined ? { alibaba } : {};
  } else if (config.provider.type === 'truefoundry') {
    // Prompt caching defaults on for the TFY gateway. Callers can override.
    const cache_control = readBodyField({ rawBody, key: 'cache_control' }) ?? { type: 'ephemeral' };
    const compatible = compatibleProviderOptions({ strictJsonSchema, reasoningEffort, rawBody }) ?? {};
    return { truefoundry: { ...compatible, cache_control } };
  } else {
    // The remaining providers all share the compatible adapter, which reads its options from a key
    // matching the `name` it was built with — the provider type itself.
    const compatible = compatibleProviderOptions({ strictJsonSchema, reasoningEffort, rawBody });
    return compatible !== undefined ? { [config.provider.type]: compatible } : {};
  }
}

// ---------------------------------------------------------------------------
// Request conversion (OpenAI → SDK)
// ---------------------------------------------------------------------------

/** Parses the MIME type from a data URI (`data:<mime>;base64,...`). */
export function parseMimeFromDataUri(uri: string): string | undefined {
  const match = /^data:([^;,]+)/.exec(uri);
  return match?.[1];
}

/** Returns `undefined` for parts with no inline data, e.g. `file_id` only. */
export function toFilePart(file: {
  file_data?: string | undefined;
  filename?: string | undefined;
}): FilePart | undefined {
  const { file_data, filename } = file;
  if (!file_data) {
    return undefined;
  }
  const mediaType = parseMimeFromDataUri(file_data) ?? 'application/octet-stream';
  return {
    type: 'file',
    data: file_data,
    mediaType,
    ...(filename !== undefined ? { filename } : {}),
  };
}

/** Converts a user content array from OpenAI format to Vercel AI SDK UserContent. */
export function toUserContent(content: string | ChatCompletionContentPart[]): UserContent {
  if (typeof content === 'string') {
    return content;
  }
  const parts: UserContent = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url') {
      // ImagePart is deprecated in favour of FilePart.
      const url = part.image_url.url;
      const mediaType = parseMimeFromDataUri(url) ?? 'image/*';
      parts.push({ type: 'file', data: url, mediaType });
      continue;
    }
    if (part.type === 'file') {
      const filePart = toFilePart(part.file);
      if (filePart !== undefined) {
        parts.push(filePart);
      }
      // file_id-only parts are unsupported (require server-side lookup); skip.
      continue;
    }
    // input_audio — not universally supported across providers; omit.
  }
  return parts;
}

/**
 * Converts an assistant message to the SDK shape for multi-turn replay.
 *
 * Each adapter reads its reasoning-replay token from a different key, and a mismatch fails
 * silently: the adapter drops the reasoning part and the model loses its chain.
 * - `'openai'`        → `openai.reasoningEncryptedContent`
 * - `'anthropic'`     → `anthropic.signature`
 * - `'google-gemini'` → per-tool-call `google.thoughtSignature`, no standalone reasoning block
 * - `'custom'`        → OpenAI-compatible ignores providerOptions, so the token has nowhere to go
 *
 * Signatures attach when `source` (`type/name/model`) matches both provider type and
 * provider name. Missing/foreign source → reasoning text only.
 */
export function toAssistantModelMessage({
  msg,
  provider,
  providerName,
  logger,
}: {
  msg: Extract<ChatCompletionMessageParam, { role: 'assistant' }>;
  provider: VercelAIProviderName;
  /** Configured provider resource name. */
  providerName: string;
  logger?: Logger | undefined;
}): ModelMessage {
  const parts: AssistantContent = [];

  // `thinking_blocks` / `source` are attached at runtime by AgentThread and absent from the OpenAI SDK type.
  const rawThinking: unknown = Reflect.get(msg, 'thinking_blocks');
  const attachSignature = shouldAttachReasoningSignature({
    source: Reflect.get(msg, 'source'),
    provider,
    providerName,
    logger,
  });
  // Alibaba appends replayed thinking to the visible answer, and Qwen signs nothing to preserve.
  if (Array.isArray(rawThinking) && provider !== 'alibaba') {
    // Widen any[] → unknown[] so the in-guards below narrow safely.
    const blocks: unknown[] = rawThinking;
    for (const tb of blocks) {
      if (
        typeof tb === 'object' &&
        tb !== null &&
        'type' in tb &&
        'thinking' in tb &&
        tb.type === 'thinking' &&
        typeof tb.thinking === 'string'
      ) {
        const signature = 'signature' in tb && typeof tb.signature === 'string' ? tb.signature : undefined;
        let reasoningProviderOptions: ProviderOptions | undefined;
        if (signature !== undefined && attachSignature) {
          if (provider === 'openai') {
            reasoningProviderOptions = { openai: { reasoningEncryptedContent: signature } };
          } else if (provider === 'anthropic') {
            reasoningProviderOptions = { anthropic: { signature } };
          }
        }
        const reasoningPart: ReasoningPart = {
          type: 'reasoning',
          text: tb.thinking,
          ...(reasoningProviderOptions !== undefined ? { providerOptions: reasoningProviderOptions } : {}),
        };
        parts.push(reasoningPart);
      }
    }
  }

  const rawContent = msg.content;
  if (rawContent) {
    const text =
      typeof rawContent === 'string'
        ? rawContent
        : rawContent
            .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
            .map(p => p.text)
            .join('');
    if (text) {
      const textPart: TextPart = { type: 'text', text };
      parts.push(textPart);
    }
  }

  if (msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      if (!isFunctionToolCall(tc)) {
        continue;
      }
      let input: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(tc.function.arguments);
        if (isPlainObject(parsed)) {
          input = parsed;
        }
      } catch {
        // malformed arguments — leave empty record
      }
      const rawProviderFields: unknown = Reflect.get(tc, 'provider_specific_fields');
      const thoughtSignature =
        isPlainObject(rawProviderFields) && typeof rawProviderFields['thought_signature'] === 'string'
          ? rawProviderFields['thought_signature']
          : undefined;
      const toolCallPart: ToolCallPart = {
        type: 'tool-call',
        toolCallId: tc.id,
        toolName: tc.function.name,
        input,
        ...(thoughtSignature !== undefined
          ? { providerOptions: { google: { thoughtSignature } } satisfies ProviderOptions }
          : {}),
      };
      parts.push(toolCallPart);
    }
  }

  return {
    role: 'assistant',
    content: parts.length > 0 ? parts : [{ type: 'text', text: '' }],
  };
}

/** Parse `provider_type/provider_name/model_name`. */
function parseAssistantMessageSource(
  source: string,
): { providerType: string; providerName: string; modelName: string } | undefined {
  const [providerType, providerName, modelName, ...rest] = source.split('/');
  if (rest.length > 0 || !providerType || !providerName || !modelName) {
    return undefined;
  }
  return { providerType, providerName, modelName };
}

/** Attach when both provider type and configured provider name match `source`. */
export function shouldAttachReasoningSignature({
  source,
  provider,
  providerName,
  logger,
}: {
  source: unknown;
  provider: VercelAIProviderName;
  providerName: string;
  logger?: Logger | undefined;
}): boolean {
  if (source === undefined) {
    return false;
  }
  if (typeof source !== 'string') {
    logger?.warn('Ignoring non-string assistant message source; skipping reasoning signature replay', { source });
    return false;
  }
  const parsed = parseAssistantMessageSource(source);
  if (parsed === undefined) {
    logger?.warn('Ignoring malformed assistant message source; skipping reasoning signature replay', { source });
    return false;
  }
  return parsed.providerType === provider && parsed.providerName === providerName;
}

/** Ends the host context message so a model does not read it as the person's words. */
const TURN_CONTEXT_CLOSING =
  "That is all the host context for this reply. The person did not write it, and none of it is their message. Answer the person's own message, not this context.";

export interface ConvertedMessages {
  instructions: string | undefined;
  messages: ModelMessage[];
}

/**
 * The first message, when it is a system message, is the static instruction and becomes `instructions`.
 * Every other system message (the per-reply block, recalled memory, task state) is per-reply context:
 * it goes in a user message of its own just ahead of the person's current message, which follows
 * unchanged, never into `instructions`, so the system prompt and tool list stay byte-identical across
 * replies on every provider. The person's message is the latest user message that is not host
 * notes or attached file text. The toolCallId → toolName lookup is built first because tool result
 * messages carry only the id.
 */
export function convertMessages({
  messages,
  provider,
  providerName,
  logger,
}: {
  messages: ChatCompletionMessageParam[];
  provider: VercelAIProviderName;
  providerName: string;
  logger?: Logger | undefined;
}): ConvertedMessages {
  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (!isFunctionToolCall(tc)) {
          continue;
        }
        toolNameById.set(tc.id, tc.function.name);
      }
    }
  }

  const lastUserIndex = personMessageIndex(messages);
  const systemParts: string[] = [];
  // With no user message there is nothing to carry per-reply context, so it stays in instructions.
  const turnContextParts: string[] = [];
  for (const [index, msg] of messages.entries()) {
    if (msg.role !== 'system') {
      continue;
    }
    const content = systemContentText(msg.content);
    if (index === 0 || lastUserIndex === -1) {
      systemParts.push(content);
    } else {
      turnContextParts.push(content);
    }
  }

  const result: ModelMessage[] = [];
  for (const [index, msg] of messages.entries()) {
    if (msg.role === 'system') {
      continue;
    }
    if (msg.role === 'user') {
      if (index === lastUserIndex && turnContextParts.length > 0) {
        const contextParts: UserContent = [...turnContextParts, TURN_CONTEXT_CLOSING].map(text => ({
          type: 'text',
          text,
        }));
        result.push({ role: 'user', content: contextParts });
      }
      // The person's message goes through untouched and last, never mixed with host context.
      result.push({ role: 'user', content: toUserContent(msg.content) });
      continue;
    }
    if (msg.role === 'assistant') {
      result.push(toAssistantModelMessage({ msg, provider, providerName, logger }));
      continue;
    }
    if (msg.role === 'tool') {
      const toolName = toolNameById.get(msg.tool_call_id) ?? '';
      const toolContent: ToolContent = [
        {
          type: 'tool-result',
          toolCallId: msg.tool_call_id,
          toolName,
          output: {
            type: 'text',
            value: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          },
        },
      ];
      result.push({ role: 'tool', content: toolContent });
      continue;
    }
    // 'developer' / 'function' roles — not used in the harness pipeline; skip.
  }
  return { instructions: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: result };
}

function systemContentText(content: ChatCompletionSystemMessageParam['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content.map(p => p.text).join('');
}

/** Converts OpenAI tool definitions to the Vercel AI SDK ToolSet. */
export function convertTools(tools: ChatCompletionTool[] | undefined): ToolSet | undefined {
  if (!tools?.length) {
    return undefined;
  }
  const toolSet: ToolSet = {};
  for (const t of tools) {
    if (!isFunctionTool(t)) {
      continue;
    }
    toolSet[t.function.name] = {
      inputSchema: jsonSchema(t.function.parameters ?? { type: 'object', properties: {} }),
      ...(t.function.description !== undefined ? { description: t.function.description } : {}),
      ...(t.function.strict === true ? { strict: true } : {}),
    };
  }
  return Object.keys(toolSet).length > 0 ? toolSet : undefined;
}

// ---------------------------------------------------------------------------
// streamText args
// ---------------------------------------------------------------------------

/**
 * Pure-data subset of `streamText(...)`'s call args. Uses `?` rather than this file's usual
 * explicit `| undefined`, to match `streamText`'s own signature under `exactOptionalPropertyTypes`.
 */
export type StreamTextArgs = LanguageModelCallOptions & {
  model: LanguageModel;
  instructions?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  providerOptions?: ProviderOptions;
  abortSignal?: AbortSignal;
  /** Always on: the deadline counts progress from raw provider chunks the parser drops or holds back. */
  includeRawChunks: boolean;
  maxRetries: number;
};

/**
 * Exported so the final wiring is unit-testable: a value computed correctly but never spread into
 * this object would pass every sub-function test. `output` is excluded and spread by the caller,
 * since its unnameable type would make this function's return type unnameable too.
 */
export function buildStreamTextArgs(input: {
  model: LanguageModel;
  instructions: string | undefined;
  messages: ModelMessage[];
  tools: ToolSet | undefined;
  reasoning: ReasoningLevel | undefined;
  providerOptions: ProviderOptions;
  maxOutputTokens: number | undefined;
  temperature: number | null | undefined;
  topP: number | null | undefined;
  topK: number | null | undefined;
  presencePenalty: number | null | undefined;
  frequencyPenalty: number | null | undefined;
  stopSequences: string[] | null | undefined;
  seed: number | null | undefined;
  abortSignal: AbortSignal | undefined;
}): StreamTextArgs {
  const {
    model,
    instructions,
    messages,
    tools,
    reasoning,
    providerOptions,
    maxOutputTokens,
    temperature,
    topP,
    topK,
    presencePenalty,
    frequencyPenalty,
    stopSequences,
    seed,
    abortSignal,
  } = input;
  return {
    model,
    ...(instructions !== undefined ? { instructions } : {}),
    messages,
    ...(tools !== undefined ? { tools } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(temperature != null ? { temperature } : {}),
    ...(topP != null ? { topP } : {}),
    ...(topK != null ? { topK } : {}),
    ...(presencePenalty != null ? { presencePenalty } : {}),
    ...(frequencyPenalty != null ? { frequencyPenalty } : {}),
    ...(stopSequences != null ? { stopSequences } : {}),
    ...(seed != null ? { seed } : {}),
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    ...(abortSignal !== undefined ? { abortSignal } : {}),
    // Raw provider chunks ride along so the deadline can count progress the SDK's parser drops
    // or holds back (see scanRawChunk); without them that progress is invisible and reads as silence.
    includeRawChunks: true,
    maxRetries: 0,
  };
}

// ---------------------------------------------------------------------------
// Stream mapping (SDK → harness chunks)
// ---------------------------------------------------------------------------

function cacheReadTokens(usage: {
  inputTokenDetails: { cacheReadTokens: number | undefined };
  raw: JSONObject | undefined;
}): number | undefined {
  const normalizedCacheReadTokens = usage.inputTokenDetails.cacheReadTokens;
  if (normalizedCacheReadTokens !== undefined && normalizedCacheReadTokens > 0) {
    return normalizedCacheReadTokens;
  }

  const raw = usage.raw;
  if (raw === undefined || !Object.hasOwn(raw, 'prompt_tokens')) {
    return normalizedCacheReadTokens;
  }

  // OpenAI-compatible adapters currently normalize missing details to zero. Consult the raw
  // response only for that ambiguous zero or absence, without discarding provider-reported usage.
  const promptTokenDetails = raw['prompt_tokens_details'];
  if (!isPlainObject(promptTokenDetails)) {
    return undefined;
  }
  const cachedTokens = promptTokenDetails['cached_tokens'];
  return typeof cachedTokens === 'number' && Number.isInteger(cachedTokens) && cachedTokens >= 0
    ? cachedTokens
    : undefined;
}

/** Maps Vercel AI SDK LanguageModelUsage → harness CompletionUsage. */
export function normalizeUsage(usage: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  inputTokenDetails: {
    cacheReadTokens: number | undefined;
    cacheWriteTokens: number | undefined;
    noCacheTokens: number | undefined;
  };
  outputTokenDetails: {
    reasoningTokens: number | undefined;
    textTokens: number | undefined;
  };
  // LanguageModelUsage.raw: AI SDK has no cost field; extras like gateway costInUSD live here.
  raw?: JSONObject;
}): CompletionUsage {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const costInUsd = usage.raw?.['costInUSD'];
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    cache_read_tokens: cacheReadTokens({
      inputTokenDetails: usage.inputTokenDetails,
      raw: usage.raw,
    }),
    cache_write_tokens: usage.inputTokenDetails.cacheWriteTokens ?? undefined,
    reasoning_tokens: usage.outputTokenDetails.reasoningTokens ?? undefined,
    cost_in_usd: typeof costInUsd === 'number' && costInUsd >= 0 ? costInUsd : undefined,
  };
}

/**
 * Prefer AI SDK `APICallError` (`message` / `statusCode`):
 * https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error#properties
 * Fallback is required because stream `error` parts are typed `unknown` (not only
 * `APICallError`) — plain objects would otherwise stringify to "[object Object]".
 */
export function describeStreamError(raw: unknown): string {
  if (APICallError.isInstance(raw)) {
    if (raw.statusCode != null) {
      return `Request failed (${String(raw.statusCode)}): ${raw.message}`;
    }
    return raw.message;
  }
  return describeUnknownError(raw);
}

/**
 * Definite provider status carried by a stream error part, when the provider answered with a
 * real HTTP status rather than the stream itself breaking. Covers APICallError (statusCode)
 * and the AI SDK's provider error shape (data.code), so a provider-side 500 from a request
 * the provider rejects is not mistaken for a broken stream that compaction could fix.
 */
export function providerStatusCode(raw: unknown): number | undefined {
  if (APICallError.isInstance(raw) && typeof raw.statusCode === 'number') {
    return raw.statusCode;
  }
  if (typeof raw === 'object' && raw !== null && 'data' in raw) {
    const data: unknown = raw.data;
    if (typeof data === 'object' && data !== null && 'code' in data && typeof data.code === 'number') {
      return data.code;
    }
  }
  return undefined;
}

// Wording providers use when a request does not fit the model's context window
// (OpenAI-compatible servers such as vLLM, Anthropic, Bedrock, Gemini, Ollama, llama.cpp).
const CONTEXT_LENGTH_ERROR_PATTERN =
  /context[ _-]?(?:length|window|limit)|available context size|maximum model length|prompt is too long|input is too long|input token count/i;

/**
 * True when a model error says the request did not fit the model's context window. Checks the
 * message, the provider's response body, and the cause chain, since the wording can sit at any level.
 */
export function isContextLengthError(raw: unknown): boolean {
  let current: unknown = raw;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    const texts: unknown[] = [];
    if (typeof current === 'string') {
      texts.push(current);
    } else if (typeof current === 'object') {
      if ('message' in current) {
        texts.push(current.message);
      }
      if (APICallError.isInstance(current)) {
        texts.push(current.responseBody);
      }
      if ('data' in current && typeof current.data === 'object' && current.data !== null) {
        const data: object = current.data;
        if ('message' in data) {
          texts.push(data.message);
        }
        if ('code' in data) {
          texts.push(data.code);
        }
      }
    }
    if (texts.some(text => typeof text === 'string' && CONTEXT_LENGTH_ERROR_PATTERN.test(text))) {
      return true;
    }
    current = typeof current === 'object' && 'cause' in current ? current.cause : undefined;
  }
  return false;
}

export function toStreamError(raw: unknown): Error {
  if (raw instanceof Error) {
    return raw;
  }
  return new Error(describeStreamError(raw), { cause: raw });
}

export function mapFinishReason(reason: FinishReason): RawAssistantMessageWithUsage['finish_reason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool-calls':
      return 'tool_calls';
    case 'content-filter':
      return 'content_filter';
    // No harness equivalent for these — fall back to 'stop'.
    case 'error':
    case 'other':
      return 'stop';
    default: {
      const _exhaustive: never = reason;
      throw new Error(`Unknown finish reason: ${String(_exhaustive)}`);
    }
  }
}

interface ToolCallState {
  index: number;
  id: string;
  name: string;
  arguments: string;
  /** The host's streamed-argument limit for this call's tool, when it set one. */
  argumentLimit: number | undefined;
  /** Gemini `thoughtSignature` from `providerMetadata.google` on the `tool-input-start` part. */
  thoughtSignature: string | undefined;
}

/**
 * Copies the reasoning-replay token onto the block, scanning every provider namespace since only
 * the active one is populated. Providers disagree on where it arrives: OpenAI attaches it to
 * `reasoning-end`, Anthropic to a text-less `reasoning-delta`. Missing either silently loses the
 * chain, since unsigned thinking blocks are dropped on replay.
 */
function applyReasoningSignature({
  block,
  providerMetadata,
}: {
  block: ThinkingBlock;
  providerMetadata: ProviderMetadata | undefined;
}): void {
  if (providerMetadata === undefined) {
    return;
  }
  for (const meta of Object.values(providerMetadata)) {
    if ('reasoningEncryptedContent' in meta && typeof meta['reasoningEncryptedContent'] === 'string') {
      block.signature = meta['reasoningEncryptedContent'];
      return;
    }
    if ('signature' in meta && typeof meta['signature'] === 'string') {
      block.signature = meta['signature'];
      return;
    }
  }
}

/**
 * Which reasoning item a stream part belongs to. OpenAI is alone in splitting one item across
 * several parts, so elsewhere this is absent and every part stands on its own.
 */
function reasoningItemId(providerMetadata: ProviderMetadata | undefined): string | undefined {
  if (providerMetadata === undefined) {
    return undefined;
  }
  for (const meta of Object.values(providerMetadata)) {
    if ('itemId' in meta && typeof meta['itemId'] === 'string') {
      return meta['itemId'];
    }
  }
  return undefined;
}

/**
 * Where the SDK reports what it changed about our request: an effort a model cannot honour and so
 * was coerced, a setting the provider ignored. Nothing else surfaces these.
 */
export function describeCallWarning(warning: CallWarning): string {
  switch (warning.type) {
    case 'unsupported':
    case 'compatibility':
      return warning.details !== undefined
        ? `${warning.type}: ${warning.feature} (${warning.details})`
        : `${warning.type}: ${warning.feature}`;
    case 'deprecated':
      return `deprecated: ${warning.setting} - ${warning.message}`;
    case 'other':
      return `other: ${warning.message}`;
    default: {
      const _exhaustive: never = warning;
      throw new Error(`Unknown call warning: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Synthetic chunk fields shared by every chunk emitted for a single stream. */
interface ChunkMeta {
  id: string;
  created: number;
  model: string;
}

const REPETITION_SHINGLE_WORDS = 8;
const REPETITION_MIN_WORDS = 256;
const REPETITION_SAMPLE_SHINGLES = 128;
const REPETITION_MATCH_THRESHOLD = 0.8;
const REPETITION_MIN_DISTANCE = 32;
const REPETITION_MAX_SHINGLES = 8192;
/**
 * Words of sustained channel repetition tolerated after the last output
 * progress before the guard trips. A turn that acts every few hundred words
 * is doing long methodical work, not stuck; a turn that churns four full
 * repetition samples with zero output is.
 */
const REPETITION_PROGRESS_WINDOW_WORDS = REPETITION_SAMPLE_SHINGLES * 4;

/**
 * Raised when a provider stream itself breaks: the connection drops, the provider closes the
 * stream mid-response without a finish signal, or the stream reports a transport-level failure
 * rather than a definite provider response (an `APICallError` carrying a status code, such as an
 * auth or rate-limit failure, is never wrapped as this: that is a real provider answer, not a
 * broken stream, and retrying it would not help), except a provider answer that the request is
 * over the context window (see isContextLengthError). This is a model fault, not a host fault:
 * the caller (AgentThread) retries the call once before giving up, shortening history first only
 * for a context-length fault. See mapStreamToChunks for the three places a stream is classified
 * this way.
 */
export class ModelStreamFault extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelStreamFault';
  }
}

/**
 * Raised when streamed reasoning stops making progress. A kind of ModelStreamFault: the model is still
 * responding, just unusably, and the same compact-and-retry recovery applies. Answer text does not
 * raise it; a repeating answer is cut and noted instead (see REPEAT_STOP_NOTE).
 */
export class ModelOutputRepetitionError extends ModelStreamFault {
  /** The guard that stopped the reply, its channel, and the words it had seen when it tripped. */
  readonly stop: RepetitionStop;

  constructor({ words }: { words?: number | undefined } = {}) {
    super("The model's reasoning stopped making progress.");
    this.name = 'ModelOutputRepetitionError';
    this.stop = { guard: 'streaming_shingles', channel: 'reasoning', ...(words !== undefined ? { words } : {}) };
  }
}

/** Bounded lexical detector for sustained repetition within one streamed channel. */
class StreamingRepetitionGuard {
  private pendingWord = '';
  private readonly wordWindow: string[] = [];
  private readonly firstShinglePosition = new Map<string, number>();
  private readonly recentMatches: boolean[] = [];
  private repeatedInSample = 0;
  private wordsSeen = 0;
  /**
   * Channel word count at the last output-progress signal. The guard trips
   * only after REPETITION_PROGRESS_WINDOW_WORDS of sustained channel
   * repetition with no output progress: a turn that acts every few hundred
   * words is doing long methodical work, not stuck in a loop, while a turn
   * that churns the whole window with zero output is.
   */
  private wordsAtLastProgress = 0;

  /**
   * Records real output progress observed on another channel (a tool call,
   * answer text, or a file). Keeps the detector from mistaking long
   * methodical work for a stuck reasoning loop.
   */
  markProgress(): void {
    this.wordsAtLastProgress = this.wordsSeen;
  }

  /** Words fed to the guard so far; reported with the stop when the guard trips. */
  get wordCount(): number {
    return this.wordsSeen;
  }

  push(text: string): boolean {
    const combined = `${this.pendingWord}${text.toLowerCase()}`;
    const trailingWord = /[\p{L}\p{N}']+$/u.exec(combined)?.[0] ?? '';
    const completeText = trailingWord.length > 0 ? combined.slice(0, -trailingWord.length) : combined;
    this.pendingWord = trailingWord;

    for (const word of completeText.match(/[\p{L}\p{N}']+/gu) ?? []) {
      if (this.pushWord(word)) {
        return true;
      }
    }
    return false;
  }

  private pushWord(word: string): boolean {
    this.wordsSeen += 1;
    this.wordWindow.push(word);
    if (this.wordWindow.length > REPETITION_SHINGLE_WORDS) {
      this.wordWindow.shift();
    }
    if (this.wordWindow.length < REPETITION_SHINGLE_WORDS) {
      return false;
    }

    const position = this.wordsSeen - REPETITION_SHINGLE_WORDS;
    const shingle = this.wordWindow.join(' ');
    const firstPosition = this.firstShinglePosition.get(shingle);
    const repeated = firstPosition !== undefined && position - firstPosition >= REPETITION_MIN_DISTANCE;
    if (firstPosition === undefined && this.firstShinglePosition.size < REPETITION_MAX_SHINGLES) {
      this.firstShinglePosition.set(shingle, position);
    }

    this.recentMatches.push(repeated);
    if (repeated) {
      this.repeatedInSample += 1;
    }
    if (this.recentMatches.length > REPETITION_SAMPLE_SHINGLES) {
      if (this.recentMatches.shift() === true) {
        this.repeatedInSample -= 1;
      }
    }

    const sustained =
      this.wordsSeen >= REPETITION_MIN_WORDS &&
      this.recentMatches.length === REPETITION_SAMPLE_SHINGLES &&
      this.repeatedInSample / REPETITION_SAMPLE_SHINGLES >= REPETITION_MATCH_THRESHOLD;
    if (!sustained) {
      return false;
    }
    // The guard trips only after a full progress window of sustained
    // repetition with no output progress: a turn that keeps emitting real
    // output (tool calls, answer text, files) is doing long methodical
    // work, not stuck in a loop.
    return this.wordsSeen - this.wordsAtLastProgress >= REPETITION_PROGRESS_WINDOW_WORDS;
  }
}

/** The field of a provider's raw chunk that carried its progress, named for logs and deadline reports. */
export type RawProgressField =
  'content' | 'reasoning' | 'reasoning_content' | 'reasoning_details' | 'tool_call_arguments';

interface RawChunkScan {
  /** The first field carrying nonempty progress text, when any field does. */
  progressField: RawProgressField | undefined;
  /**
   * Progress the SDK parser also turns into parts of its own (answer text, reasoning under the
   * fields it maps, a tool call whose name has arrived). When true, the mapped parts already
   * reset both deadline layers, so the raw part needs no progress chunk of its own.
   */
  mappedProgress: boolean;
  /** Reasoning under a field the parser maps (`reasoning` / `reasoning_content`) is present in this chunk. */
  mappedReasoning: boolean;
  /** Reasoning text the parser drops (it lives only under `reasoning_details`), when present. */
  droppedReasoningText: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Text carried by a `reasoning_details` entry, across the shapes providers use for it. */
function reasoningDetailText(entry: unknown): string | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  return nonemptyString(entry['text']) ?? nonemptyString(entry['summary']) ?? nonemptyString(entry['content']);
}

/**
 * Reads one raw provider chunk (an OpenAI-shaped chat-completion chunk) for progress the SDK
 * parser may not surface. The parser drops some fields outright (reasoning carried only under
 * `reasoning_details`) and holds others back (tool-call argument deltas are buffered until the
 * call's name arrives, which a provider may send only in its last frame), so a model can be
 * answering while no parsed part exists. A chunk whose delta carries nothing but a role, or no
 * text at all, is a keepalive and scans as no progress. Non-OpenAI-shaped raw chunks (other
 * providers' native events) scan as no progress: their parsers map their own reasoning, so the
 * parsed parts remain the only signal there, exactly as before raw chunks were requested.
 */
export function scanRawChunk(rawValue: unknown): RawChunkScan {
  const none: RawChunkScan = {
    progressField: undefined,
    mappedProgress: false,
    mappedReasoning: false,
    droppedReasoningText: undefined,
  };
  if (!isRecord(rawValue)) {
    return none;
  }
  const choices: unknown = rawValue['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    return none;
  }
  const first: unknown = choices[0];
  if (!isRecord(first)) {
    return none;
  }
  const delta: unknown = first['delta'];
  if (!isRecord(delta)) {
    return none;
  }

  let droppedReasoningText: string | undefined;
  const details: unknown = delta['reasoning_details'];
  if (Array.isArray(details)) {
    const texts = details.map(reasoningDetailText).filter(text => text !== undefined);
    if (texts.length > 0) {
      droppedReasoningText = texts.join('');
    }
  }

  let toolArguments = false;
  let toolNameArrived = false;
  const toolCalls: unknown = delta['tool_calls'];
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!isRecord(call) || !isRecord(call['function'])) {
        continue;
      }
      if (nonemptyString(call['function']['arguments']) !== undefined) {
        toolArguments = true;
      }
      if (nonemptyString(call['function']['name']) !== undefined) {
        toolNameArrived = true;
      }
    }
  }

  const content = nonemptyString(delta['content']) !== undefined;
  const reasoning = nonemptyString(delta['reasoning']) !== undefined;
  const reasoningContent = nonemptyString(delta['reasoning_content']) !== undefined;
  const mappedReasoning = reasoning || reasoningContent;
  const mappedProgress = content || mappedReasoning || toolNameArrived;
  const progressField: RawProgressField | undefined = content
    ? 'content'
    : reasoningContent
      ? 'reasoning_content'
      : reasoning
        ? 'reasoning'
        : droppedReasoningText !== undefined
          ? 'reasoning_details'
          : toolArguments
            ? 'tool_call_arguments'
            : undefined;
  return { progressField, mappedProgress, mappedReasoning, droppedReasoningText };
}

/** The progress field of a raw provider chunk, or undefined when the chunk carries no progress. */
export function rawChunkProgressField(rawValue: unknown): RawProgressField | undefined {
  return scanRawChunk(rawValue).progressField;
}

/**
 * True when a raw SDK stream part carries something a caller would notice: text, reasoning text,
 * a nonempty tool-call delta, a tool call/file/reasoning-file, or a step/turn finish. A raw
 * provider chunk also counts when its delta carries nonempty text in any field, including fields
 * the parser drops or holds back (see scanRawChunk). False for bookkeeping and
 * empty-heartbeat parts (role-only deltas, `start`/`start-step`, zero-length deltas). Only
 * substantive parts may satisfy the first-chunk deadline or reset the per-chunk deadline in
 * VercelAILLM.
 */
export function chunkHasSubstance(part: TextStreamPart<ToolSet>): boolean {
  switch (part.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return part.text.length > 0;
    case 'tool-input-delta':
      return part.delta.length > 0;
    case 'raw':
      return rawChunkProgressField(part.rawValue) !== undefined;
    case 'tool-input-start':
    case 'tool-call':
    case 'file':
    case 'reasoning-file':
    case 'finish-step':
    case 'finish':
      return true;
    case 'reasoning-start':
    case 'reasoning-end':
    case 'start':
    case 'text-start':
    case 'text-end':
    case 'custom':
    case 'tool-input-end':
    case 'source':
    case 'tool-result':
    case 'tool-error':
    case 'tool-output-denied':
    case 'tool-approval-request':
    case 'tool-approval-response':
    case 'start-step':
    case 'error':
    case 'abort':
      return false;
    default: {
      const _exhaustive: never = part;
      return _exhaustive;
    }
  }
}

/**
 * The field that carried a part's progress, for deadline reports: a raw chunk names the delta
 * field its text arrived under; a parsed part names the harness field it feeds. Undefined when
 * the part carries no progress (chunkHasSubstance is false for it).
 */
export function chunkSubstanceField(part: TextStreamPart<ToolSet>): string | undefined {
  if (part.type === 'raw') {
    return rawChunkProgressField(part.rawValue);
  }
  if (!chunkHasSubstance(part)) {
    return undefined;
  }
  switch (part.type) {
    case 'text-delta':
      return 'content';
    case 'reasoning-delta':
      return 'reasoning';
    case 'tool-input-delta':
    case 'tool-input-start':
    case 'tool-call':
      return 'tool_call_arguments';
    default:
      return part.type;
  }
}

/** What a stream part says about a tool call: it opened, it completed, or the step ended. */
export type ToolCallPiece = { kind: 'opened' | 'completed'; id: string } | { kind: 'step_ended' };

/** The tool-call piece a stream part carries, or undefined for any other part. */
export function toolCallPieceOf(part: TextStreamPart<ToolSet>): ToolCallPiece | undefined {
  switch (part.type) {
    case 'tool-input-start':
      return { kind: 'opened', id: part.id };
    case 'tool-input-end':
      return { kind: 'completed', id: part.id };
    case 'tool-call':
      return { kind: 'completed', id: part.toolCallId };
    case 'finish-step':
    case 'finish':
      return { kind: 'step_ended' };
    default:
      return undefined;
  }
}

/**
 * Re-arms the first-chunk and per-chunk deadlines from inside the harness rather than trusting the
 * SDK's own `timeout` option end to end. A chunk only satisfies the first-chunk deadline, and only
 * a chunk resets the per-chunk deadline, when {@link chunkHasSubstance} says it carries something —
 * a provider's role-only or empty-delta heartbeat (a real shape some OpenAI-compatible servers send
 * while prefilling a large prompt) keeps both timers exactly where they were. While a tool call is
 * open (its first piece arrived and it has not completed), the per-chunk deadline is the tool-call
 * allowance instead, because a server may hold a call's arguments back and send them in a few large
 * pieces. On expiry, aborts
 * `deadlineController` with the same `DOMException`/`TimeoutError` shape the SDK's own timeout uses,
 * so downstream error handling is unchanged, and rejects the pending read at once. The firing is
 * recorded as StreamDeadlineDetails (which deadline, and the last progress before it) so the
 * turn's one log line can say what actually happened.
 */
export async function* enforceStreamDeadlines<T>({
  stream,
  timeout,
  hasSubstance,
  substanceField,
  toolCalls,
  deadlineController,
}: {
  stream: AsyncIterable<T>;
  timeout: { firstChunkMs: number; chunkMs: number };
  hasSubstance: (part: T) => boolean;
  /** Names the field that carried a part's progress, for the deadline record; defaults to the part's kind. */
  substanceField?: ((part: T) => string | undefined) | undefined;
  /** The per-chunk allowance while a tool call is open, and how a part opens or completes one. */
  toolCalls?: { chunkMs: number; pieceOf: (part: T) => ToolCallPiece | undefined } | undefined;
  deadlineController: AbortController;
}): AsyncGenerator<T, void, unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const openToolCalls = new Set<string>();
  let lastProgress: { field: string; atMs: number } | undefined;
  let firedDetails: StreamDeadlineDetails | undefined;

  const abortWithTimeout = (label: 'First chunk' | 'Chunk', ms: number) => {
    const now = Date.now();
    const details: StreamDeadlineDetails = {
      deadline: label === 'First chunk' ? 'first_chunk' : 'chunk',
      timeoutMs: ms,
      lastProgressField: lastProgress?.field ?? null,
      msSinceLastProgress: lastProgress === undefined ? null : now - lastProgress.atMs,
    };
    firedDetails = details;
    const progressNote =
      lastProgress === undefined
        ? 'no progress received'
        : `last progress ${(now - lastProgress.atMs).toString()}ms ago via ${lastProgress.field}`;
    const reason = new DOMException(`${label} timeout of ${ms.toString()}ms exceeded; ${progressNote}`, 'TimeoutError');
    recordStreamDeadlineDetails(reason, details);
    deadlineController.abort(reason);
  };

  const armFirstChunkTimer = () => {
    timer = setTimeout(() => {
      abortWithTimeout('First chunk', timeout.firstChunkMs);
    }, timeout.firstChunkMs);
  };
  const armChunkTimer = () => {
    const chunkMs =
      toolCalls !== undefined && openToolCalls.size > 0
        ? Math.max(toolCalls.chunkMs, timeout.chunkMs)
        : timeout.chunkMs;
    timer = setTimeout(() => {
      abortWithTimeout('Chunk', chunkMs);
    }, chunkMs);
  };

  // A provider stream does not always end when its request is aborted, so an expired deadline
  // rejects the pending read itself; the source is asked to close but never awaited.
  const iterator = stream[Symbol.asyncIterator]();
  const expired = new Promise<never>((_, reject) => {
    const onExpired = () => {
      const reason: unknown = deadlineController.signal.reason;
      const expiredError = new Error(describeStreamError(reason), { cause: reason });
      expiredError.name = 'TimeoutError';
      const details = firedDetails ?? streamDeadlineDetailsOf(reason);
      if (details !== undefined) {
        recordStreamDeadlineDetails(expiredError, details);
      }
      reject(expiredError);
    };
    if (deadlineController.signal.aborted) {
      onExpired();
    } else {
      deadlineController.signal.addEventListener('abort', onExpired, { once: true });
    }
  });
  // Observed here so an expiry nobody is reading never surfaces as an unhandled rejection.
  expired.catch(() => undefined);

  armFirstChunkTimer();
  try {
    for (;;) {
      const result = await Promise.race([iterator.next(), expired]);
      if (result.done === true) {
        return;
      }
      const part = result.value;
      const piece = toolCalls?.pieceOf(part);
      if (piece?.kind === 'opened') {
        openToolCalls.add(piece.id);
      } else if (piece?.kind === 'completed') {
        openToolCalls.delete(piece.id);
      } else if (piece?.kind === 'step_ended') {
        openToolCalls.clear();
      }
      const field = substanceField === undefined ? undefined : substanceField(part);
      if (field !== undefined || hasSubstance(part)) {
        lastProgress = { field: field ?? 'chunk', atMs: Date.now() };
        clearTimeout(timer);
        armChunkTimer();
      }
      yield part;
    }
  } finally {
    clearTimeout(timer);
    void Promise.resolve()
      .then(() => iterator.return?.())
      .catch(() => undefined);
  }
}

/**
 * Converts an SDK stream into harness chunks, returning the aggregated assistant message.
 * Takes a plain `AsyncIterable` so hand-built fixtures work in tests.
 */
export async function* mapStreamToChunks({
  stream,
  chunkMeta,
  toolArgumentLimits,
}: {
  stream: AsyncIterable<TextStreamPart<ToolSet>>;
  chunkMeta: ChunkMeta;
  /** Host-owned per-tool limits on streamed argument characters; absent means no tool has one. */
  toolArgumentLimits?: ReadonlyMap<string, number> | undefined;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const makeBase = (): Omit<ExtendedChatCompletionChunk, 'choices' | 'usage'> => ({
    id: chunkMeta.id,
    object: 'chat.completion.chunk' as const,
    created: chunkMeta.created,
    model: chunkMeta.model,
  });

  const toolCallStates = new Map<string, ToolCallState>();
  let nextToolIndex = 0;
  let accumulatedText = '';
  // Leaked tool-call markup in the answer text is held back and never streamed or run; the caller is
  // told it did not run.
  const markupGuard = new ToolMarkupGuard();
  // A reply that repeats one sentence or line three times is stopped before the last copy.
  const answerUnits = new RepeatedUnitGuard();
  const reasoningRepetition = new StreamingRepetitionGuard();
  let repetitionStopped = false;
  // Calls stopped mid-stream for running past their tool's argument size limit. Their partial
  // arguments stay in the reply; the caller refuses them instead of running them.
  const sizeCutToolCalls: string[] = [];
  // Set when the reply started more calls than one reply may make; reading stops there.
  let toolCallCountCut = false;
  const accumulatedThinking: ThinkingBlock[] = [];
  const thinkingByReasoningItem = new Map<string, ThinkingBlock>();
  let currentThinkingBlock: ThinkingBlock | null = null;

  /**
   * The block this reasoning part belongs to: the one already open for its item, or a new one.
   *
   * OpenAI streams a single reasoning item as several summary parts, and hands every part the one
   * token that identifies the item. A block per part would therefore replay that item once per
   * part, every copy presenting the same token with a different piece of the reasoning. Grouping by
   * item keeps one block per token, which is the only shape the provider can be replayed.
   */
  const openThinkingBlock = (providerMetadata: ProviderMetadata | undefined): ThinkingBlock => {
    const itemId = reasoningItemId(providerMetadata);
    const started = itemId !== undefined ? thinkingByReasoningItem.get(itemId) : undefined;
    if (started !== undefined) {
      // Each part is its own titled paragraph, and a part can be empty.
      if (started.thinking.length > 0) {
        started.thinking += '\n\n';
      }
      return started;
    }
    const block: ThinkingBlock = { type: 'thinking', thinking: '' };
    accumulatedThinking.push(block);
    if (itemId !== undefined) {
      thinkingByReasoningItem.set(itemId, block);
    }
    return block;
  };
  let finalUsage: CompletionUsage = getEmptyUsage();
  let finalFinishReason: RawAssistantMessageWithUsage['finish_reason'] = 'stop';
  // Set only by 'finish-step'. A provider that closes the connection mid-response (the shape a
  // cut stream takes: no explicit 'error' part, the underlying transport just ends) leaves this
  // false, which is what the post-loop check below uses to tell a genuinely silent 'stop' apart
  // from a stream that never finished at all.
  let sawFinishStep = false;
  // Set when the parser surfaces reasoning itself; raw-chunk reasoning (a field the parser
  // drops) is only mapped while this stays false, so mirrored reasoning is never shown twice.
  let sawMappedReasoning = false;

  streamLoop: for await (const part of stream) {
    switch (part.type) {
      case 'text-delta': {
        const released = markupGuard.push(part.text);
        if (released === '') {
          break;
        }
        const answer = answerUnits.push(released);
        if (answer.text !== '') {
          // Answer text is real output: the reasoning guard must not mistake
          // long methodical work for a stuck loop while the turn is producing.
          reasoningRepetition.markProgress();
          accumulatedText += answer.text;
          yield {
            ...makeBase(),
            choices: [
              {
                index: 0,
                delta: { content: answer.text, role: 'assistant' },
                finish_reason: null,
                logprobs: null,
              },
            ],
          };
        }
        if (answer.stopped) {
          repetitionStopped = true;
          break streamLoop;
        }
        break;
      }

      case 'reasoning-start': {
        currentThinkingBlock = openThinkingBlock(part.providerMetadata);
        break;
      }

      case 'reasoning-delta': {
        sawMappedReasoning = true;
        // A delta with no preceding `reasoning-start` would otherwise drop the block and its
        // signature, breaking replay while the text still streams out.
        if (reasoningRepetition.push(part.text)) {
          throw new ModelOutputRepetitionError({ words: reasoningRepetition.wordCount });
        }
        currentThinkingBlock ??= openThinkingBlock(part.providerMetadata);
        currentThinkingBlock.thinking += part.text;
        applyReasoningSignature({ block: currentThinkingBlock, providerMetadata: part.providerMetadata });
        yield {
          ...makeBase(),
          choices: [
            {
              index: 0,
              delta: {
                thinking_blocks: [{ type: 'thinking', thinking: part.text }],
                reasoning_content: part.text,
              } satisfies ExtendedChatCompletionChunk['choices'][0]['delta'],
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
        break;
      }

      case 'reasoning-end': {
        if (currentThinkingBlock !== null) {
          applyReasoningSignature({ block: currentThinkingBlock, providerMetadata: part.providerMetadata });
        }
        currentThinkingBlock = null;
        break;
      }

      case 'tool-input-start': {
        if (nextToolIndex >= MAX_TOOL_CALLS_PER_REPLY) {
          // One more call than a reply may make: stop reading here rather than buffering a
          // flood the reply guard would refuse anyway, or waiting on a model that keeps writing
          // calls until the turn's time limit. The reply is marked cut so the turn stops.
          toolCallCountCut = true;
          break streamLoop;
        }
        const idx = nextToolIndex++;
        // A tool call is real output progress: the reasoning guard must not
        // mistake a turn that keeps acting for a stuck reasoning loop.
        reasoningRepetition.markProgress();
        // Gemini's replay token arrives here, and only here, for thinking models.
        const googleMeta = part.providerMetadata?.['google'];
        const thoughtSignature =
          googleMeta !== undefined && typeof googleMeta['thoughtSignature'] === 'string'
            ? googleMeta['thoughtSignature']
            : undefined;
        toolCallStates.set(part.id, {
          index: idx,
          id: part.id,
          name: part.toolName,
          arguments: '',
          argumentLimit: toolArgumentLimits?.get(part.toolName),
          thoughtSignature,
        });
        yield {
          ...makeBase(),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: idx,
                    id: part.id,
                    type: 'function',
                    function: { name: part.toolName, arguments: '' },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
        break;
      }

      case 'tool-input-delta': {
        const state = toolCallStates.get(part.id);
        // With no matching `tool-input-start` there is no index to attribute this to; emitting it
        // anyway would append the arguments to an unrelated tool call.
        if (state === undefined) {
          break;
        }
        // Nonempty argument deltas are real output: the model is constructing
        // a tool call, often row-by-row report content, so the reasoning guard
        // must not mistake the turn for a stuck loop while arguments flow.
        if (part.delta.length > 0) {
          reasoningRepetition.markProgress();
        }
        state.arguments += part.delta;
        yield {
          ...makeBase(),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: state.index, function: { arguments: part.delta } }],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        };
        if (state.argumentLimit !== undefined && state.arguments.length > state.argumentLimit) {
          // The call ran past its size limit: stop reading the stream here rather than
          // buffering a call the tool layer would refuse anyway, or waiting on a server
          // that may never finish it. The partial call stays in the reply and is named
          // on the result, so the reply guard refuses it with a plain message and the
          // model can send the content in smaller parts in the same turn.
          sizeCutToolCalls.push(state.id);
          break streamLoop;
        }
        break;
      }

      case 'finish-step': {
        sawFinishStep = true;
        finalUsage = normalizeUsage(part.usage);
        finalFinishReason = mapFinishReason(part.finishReason);
        yield {
          ...makeBase(),
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finalFinishReason,
              logprobs: null,
            },
          ],
          usage: finalUsage,
        };
        break;
      }

      case 'error': {
        const raw = part.error;
        const message = describeStreamError(raw);
        // Preserve the original stream error as cause; toast/turn use .message only.
        const cause = raw instanceof Error ? raw : new Error(message);
        // A definite provider response (a status code on the error: auth, rate limit, bad
        // request, or a provider-side 500) is a real answer from the provider, not a broken
        // stream: compacting context and retrying would not change it, so it stays a plain
        // Error. Any other error part (no status code: a transport failure or a
        // malformed-response parse failure, the shape a cut/malformed stream like vLLM's
        // mid-response HarmonyError takes) is the stream itself breaking, so it is a
        // ModelStreamFault. A provider answer saying the request is over the context window is
        // the one definite answer a shorter history can fix, so it is a ModelStreamFault too.
        if (providerStatusCode(raw) != null && !isContextLengthError(raw)) {
          throw new Error(message, { cause });
        }
        throw new ModelStreamFault(message, { cause });
      }

      case 'abort': {
        const aborted = new Error(part.reason ?? 'LLM stream aborted');
        aborted.name = 'AbortError';
        throw aborted;
      }

      case 'start':
      case 'text-start':
      case 'text-end':
      case 'custom':
      case 'tool-input-end':
      case 'source':
        // Structural and bookkeeping events: no harness chunk is emitted for these.
        break;

      case 'file':
        // A file emitted mid-stream is real output progress for the
        // reasoning guard.
        reasoningRepetition.markProgress();
        break;

      case 'reasoning-file':
      case 'tool-call':
      case 'tool-result':
      case 'tool-error':
      case 'tool-output-denied':
      case 'tool-approval-request':
      case 'tool-approval-response':
      case 'start-step':
      case 'finish':
        // Structural/bookkeeping events — no harness chunk is emitted for these.
        break;

      case 'raw': {
        const scan = scanRawChunk(part.rawValue);
        if (scan.droppedReasoningText !== undefined && !scan.mappedReasoning && !sawMappedReasoning) {
          // Reasoning the parser dropped: surface it as reasoning, the way a mapped
          // reasoning-delta is surfaced, so the person sees the thinking.
          const text = scan.droppedReasoningText;
          if (reasoningRepetition.push(text)) {
            throw new ModelOutputRepetitionError({ words: reasoningRepetition.wordCount });
          }
          currentThinkingBlock ??= openThinkingBlock(undefined);
          currentThinkingBlock.thinking += text;
          yield {
            ...makeBase(),
            choices: [
              {
                index: 0,
                delta: {
                  thinking_blocks: [{ type: 'thinking', thinking: text }],
                  reasoning_content: text,
                } satisfies ExtendedChatCompletionChunk['choices'][0]['delta'],
                finish_reason: null,
                logprobs: null,
              },
            ],
          };
        } else if (scan.progressField !== undefined && !scan.mappedProgress) {
          // Progress the parser cannot surface (tool-call arguments it is holding back):
          // an empty delta still tells the harness layer the model is answering, the same
          // shape 'finish-step' uses, so its silence clock resets too.
          yield {
            ...makeBase(),
            choices: [{ index: 0, delta: {}, finish_reason: null, logprobs: null }],
          };
        }
        break;
      }

      default: {
        const _exhaustive: never = part;
        throw new Error(`Unknown stream part type: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // The stream's own async iterable ended (no 'error' part, no throw) without ever reaching a
  // finish signal, and produced neither text nor a tool call. A provider that closes the
  // connection mid-response, rather than terminating it cleanly, can end an async iterable this
  // way with no explicit error at all. Treated the same as the explicit-error cases above: a
  // model/provider stream fault, not a host fault.
  if (
    !repetitionStopped &&
    !sawFinishStep &&
    accumulatedText === '' &&
    toolCallStates.size === 0 &&
    !markupGuard.inMarkup
  ) {
    throw new ModelStreamFault('The model stream ended without any text, tool call, or finish signal.');
  }

  // Settle the markup guard. A clean reply releases its held tail, which passes the repetition guard
  // like the rest of the answer; a reply that carried markup releases nothing of it. A reply cut off
  // at the output limit releases nothing either: what the guard still holds then is a tool call the
  // limit cut in two, and releasing it would show the person raw markup as answer text.
  const markupOutcome = markupGuard.finish();
  const cutOffMidCall = finalFinishReason === 'length' && markupGuard.inMarkup;
  let tail = '';
  if (!repetitionStopped) {
    const flushed = answerUnits.push(markupOutcome === 'clean' && !cutOffMidCall ? markupGuard.heldText : '');
    const rest = flushed.stopped ? { text: '', stopped: false } : answerUnits.finish();
    repetitionStopped = flushed.stopped || rest.stopped;
    tail = flushed.text + rest.text;
  }
  if (repetitionStopped) {
    tail += noticeAfter({ text: accumulatedText + tail, notice: REPEAT_STOP_NOTE });
  }
  if (tail !== '') {
    accumulatedText += tail;
    yield {
      ...makeBase(),
      choices: [
        {
          index: 0,
          delta: { content: tail, role: 'assistant' },
          finish_reason: null,
          logprobs: null,
        },
      ],
    };
  }

  const toolCalls = [...toolCallStates.values()]
    .sort((a, b) => a.index - b.index)
    .map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.arguments },
      ...(tc.thoughtSignature !== undefined
        ? { provider_specific_fields: { thought_signature: tc.thoughtSignature } }
        : {}),
    }));

  const output: RawAssistantMessage = {
    role: 'assistant',
    content: accumulatedText || null,
    ...(accumulatedThinking.length > 0 ? { thinking_blocks: accumulatedThinking } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };

  return {
    usage: finalUsage,
    output,
    finish_reason: finalFinishReason,
    ...(markupOutcome === 'leaked' ? { tool_markup: markupOutcome } : {}),
    ...(repetitionStopped
      ? { repetition_stopped: true, repetition_stop: { guard: 'answer_units', channel: 'answer' } }
      : {}),
    ...(sizeCutToolCalls.length > 0 ? { size_cut_tool_calls: sizeCutToolCalls } : {}),
    ...(toolCallCountCut ? { tool_call_count_cut: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// VercelAILLM
// ---------------------------------------------------------------------------

/** ILLM implementation backed by Vercel AI SDK, supporting multiple LLM providers. */
export class VercelAILLM implements ILLM {
  private readonly config: VercelAILLMConfig;
  private readonly logger: Logger;
  private readonly signal: AbortSignal | undefined;
  private readonly streamTimeout: NonNullable<VercelAILLMConfig['streamTimeout']>;

  constructor(config: VercelAILLMConfig) {
    this.config = config;
    this.logger = config.logger;
    this.signal = config.signal;
    // Allow cold local-model loading/prefill, but do not let empty heartbeat
    // chunks hold an unfinished proposal open indefinitely. The SDK counts
    // nonempty text, reasoning and tool-input chunks as progress.
    this.streamTimeout = { ...(config.streamTimeout ?? { firstChunkMs: 300_000, chunkMs: 60_000 }) };
    for (const value of [...Object.values(this.streamTimeout), config.toolCallChunkMs ?? this.streamTimeout.chunkMs]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
        throw new Error('Model stream deadlines must be integer milliseconds between 1 and 2147483647');
      }
    }
    for (const value of config.toolArgumentLimits?.values() ?? []) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error('Tool argument limits must be positive integer character counts');
      }
    }
  }

  async *create(
    body: LLMCreateParamsStreaming,
  ): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
    const { providerConfig, fallbackProviderConfig, onFallback } = this.config;
    // reasoning_effort is injected by AgentThread via Object.assign; not in the SDK type.
    const rawReasoningEffort: unknown = Reflect.get(body, 'reasoning_effort');
    const reasoningEffort = typeof rawReasoningEffort === 'string' ? rawReasoningEffort : undefined;
    const reasoning = toReasoningLevel(reasoningEffort);
    const reasoningRequested = reasoning !== undefined && reasoning !== 'none';
    const primaryModel = buildLanguageModel(providerConfig, { reasoningRequested });
    const languageModel =
      fallbackProviderConfig !== undefined
        ? withFailover({
            primary: primaryModel,
            secondary: buildLanguageModel(fallbackProviderConfig, { reasoningRequested }),
            logger: this.logger,
            onFallback,
          })
        : primaryModel;
    const { provider, model } = providerConfig;

    const { instructions, messages } = convertMessages({
      messages: body.messages,
      provider: provider.type,
      providerName: provider.name,
      logger: this.logger,
    });
    const tools = convertTools(body.tools ?? undefined);
    if (
      this.logger.isDebugEnabled() &&
      body.tools !== undefined &&
      body.messages.some(
        m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url' || p.type === 'file'),
      )
    ) {
      this.logger.debug('Multimodal chat completion request payload', {
        model: model.id,
        tools: body.tools,
        messages: body.messages.map(m => ({
          role: m.role,
          partTypes: Array.isArray(m.content) ? m.content.map(p => p.type) : typeof m.content,
        })),
      });
    }
    const structuredOutputSpec = toStructuredOutputSpec(body.response_format);
    const output = buildOutput(structuredOutputSpec);

    const providerOptions = buildProviderOptions({
      config: providerConfig,
      reasoningEffort,
      structuredOutputSpec,
      rawBody: body,
    });

    // top_k is injected by AgentThread via Object.assign; not in the SDK type.
    const rawTopK: unknown = Reflect.get(body, 'top_k');
    // seed is still accepted by providers but marked @deprecated on the OpenAI request type.
    const rawSeed: unknown = Reflect.get(body, 'seed');

    // Owns the first-chunk/chunk deadlines ourselves (see `enforceStreamDeadlines`) rather than
    // handing `timeout` to the SDK, so a provider's own role-only/empty-delta heartbeats can never
    // satisfy them. Combined with the caller's signal so a deadline abort still tears down the
    // underlying request the same way caller cancellation already does.
    const deadlineController = new AbortController();
    const combinedSignal =
      this.signal !== undefined ? AbortSignal.any([this.signal, deadlineController.signal]) : deadlineController.signal;

    const streamTextArgs = buildStreamTextArgs({
      model: languageModel,
      instructions,
      messages,
      tools,
      reasoning,
      providerOptions,
      maxOutputTokens: resolveMaxOutputTokens(body),
      temperature: body.temperature,
      topP: body.top_p,
      topK: typeof rawTopK === 'number' ? rawTopK : null,
      presencePenalty: body.presence_penalty,
      frequencyPenalty: body.frequency_penalty,
      stopSequences: typeof body.stop === 'string' ? [body.stop] : (body.stop ?? null),
      seed: typeof rawSeed === 'number' ? rawSeed : null,
      abortSignal: combinedSignal,
    });

    let providerAbortReason: unknown;
    let streamResult;
    try {
      streamResult = streamText({
        ...streamTextArgs,
        onAbort: event => {
          if ('reason' in event) {
            providerAbortReason = event.reason;
          }
        },
        ...(output !== undefined ? { output } : {}),
      });
    } catch (error) {
      if (this.signal?.aborted) {
        this.logger.debug('LLM call aborted', extractErrorLogFields(error));
      } else {
        this.logger.error('Error creating streaming chat completion', extractErrorLogFields(error));
      }
      throw toStreamError(error);
    }

    // Detached: warnings resolve at stream start, and a pending or rejected promise must never
    // stall the stream. Stream failures are reported by the error paths below.
    void streamResult.warnings.then(
      warnings => {
        if (warnings !== undefined && warnings.length > 0) {
          this.logger.warn('Provider adjusted the request', {
            model: providerConfig.name,
            warnings: warnings.map(describeCallWarning),
          });
        }
      },
      (reason: unknown) => {
        // Rejects with the same failure the stream throws, which the error paths below already log.
        this.logger.debug('Provider warnings unavailable', extractErrorLogFields(reason));
      },
    );

    // Synthetic chunk fields; id is unique per stream instance.
    // Label chunks with the display name — model.id is the wire id.
    const chunkMeta: ChunkMeta = {
      id: `vc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      created: Math.floor(Date.now() / 1000),
      model: providerConfig.name,
    };

    const deadlineGuardedStream = enforceStreamDeadlines({
      stream: streamResult.stream,
      timeout: this.streamTimeout,
      hasSubstance: chunkHasSubstance,
      substanceField: chunkSubstanceField,
      toolCalls: {
        chunkMs: this.config.toolCallChunkMs ?? DEFAULT_MODEL_TOOL_CALL_IDLE_TIMEOUT_MS,
        pieceOf: toolCallPieceOf,
      },
      deadlineController,
    });

    try {
      const result = yield* mapStreamToChunks({
        stream: deadlineGuardedStream,
        chunkMeta,
        toolArgumentLimits: this.config.toolArgumentLimits,
      });
      result.output.source = `${provider.type}/${provider.name}/${model.name}`;
      return result;
    } catch (error) {
      if (this.signal?.aborted) {
        this.logger.debug('LLM stream aborted', extractErrorLogFields(error));
      } else {
        this.logger.error('Error reading LLM stream', extractErrorLogFields(error));
      }
      // The SDK's serialized abort part can lose a cross-realm DOMException's message, and its
      // own `onAbort` callback races the stream's rejection instead of preceding it. The caller's
      // own signal is authoritative and synchronously known the moment it aborts, so prefer its
      // reason over the callback when the caller (not a host-owned deadline) is what aborted.
      throw toStreamError(this.signal?.aborted ? this.signal.reason : (providerAbortReason ?? error));
    }
  }

  async createNonStream(body: LLMCreateParams): Promise<RawAssistantMessageWithUsage> {
    // Drain the streaming generator — reuses the same accumulation and error handling path.
    const llmStream = this.create({ ...body, stream: true });
    let result = await llmStream.next();
    while (!result.done) {
      result = await llmStream.next();
    }
    return result.value;
  }
}
