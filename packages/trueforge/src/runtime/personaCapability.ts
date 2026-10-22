import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type {
  AgentCapability,
  AgentTracing,
  InstructionBuilder,
  SentinelHostContext,
} from '@truefoundry/trueforge-core/core';
import {
  classifyHostToolCall,
  defineTool,
  LocalToolMCP,
  toolResultResponse,
  type ToolDefinition,
} from '@truefoundry/trueforge-core/core';
import type { ApprovalDecision } from '@truefoundry/trueforge-core/core/events/schema';
import { stampSentinelDecision } from '@truefoundry/trueforge-core/core/mcp/ToolSet';
import {
  CREATE_PERSONA_TOOL_NAME,
  isPersonaWriteToolName,
  LIST_PERSONAS_TOOL_NAME,
  PERSONA_SERVER_ID,
  USE_PERSONA_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/personas/toolContract';
import type { Logger } from 'winston';
import { z } from 'zod';
import type { IModelProviderStore } from '../db/modelProviderStore';
import type { IPersonaStore } from '../db/personaStore';
import { PersonaNameConflictError } from '../db/personaStore';
import { createPersonaForOwner } from '../personas/createPersona';
import { personaMatchKey, personaNameKeys, type Persona, type PersonaContent } from '../personas/persona';
import { activateSessionPersona } from '../personas/sessionPersona';
import { PersonaContentSchema, PersonaNameSchema } from '../schemas/persona';

/** A description is one line in the card and in the persona list. */
const PERSONA_DESCRIPTION_MAX_LENGTH = 160;

export const CreatePersonaToolSchema = z
  .object({
    name: PersonaNameSchema.describe('Short name for the specialist, such as "Travel planner".'),
    description: z
      .string()
      .trim()
      .min(1)
      .max(PERSONA_DESCRIPTION_MAX_LENGTH)
      .refine(value => !/[\r\n]/.test(value), 'The description must be one line.')
      .describe('One line on what the specialist is for.'),
    instructions: z
      .string()
      .trim()
      .min(1)
      .describe('What the specialist focuses on and how it talks. Written in plain words.'),
  })
  .strict();

export type CreatePersonaToolInput = z.infer<typeof CreatePersonaToolSchema>;

export const UsePersonaToolSchema = z
  .object({
    name: PersonaNameSchema.describe("The name of one of the user's existing specialists."),
  })
  .strict();

export type UsePersonaToolInput = z.infer<typeof UsePersonaToolSchema>;

/** The stored instructions lead with the description, so the persona keeps its one-line purpose. */
export function personaContentFor(input: {
  name: string;
  description: string;
  instructions: string;
  model_name: string;
}): PersonaContent {
  return {
    display_name: input.name,
    aliases: [],
    instructions: `${input.description}\n\n${input.instructions}`,
    model_name: input.model_name,
  };
}

/** What a persona tool needs from the host for one chat turn. */
export interface PersonaTurnContext {
  store: IPersonaStore;
  modelProviderStore: IModelProviderStore;
  tenant_id: string;
  /** The person in the chat; a specialist is created for them alone. */
  owner_id: string;
  /** The model the chat runs on; a new specialist answers with it. */
  model_name: string;
  /** The chat the specialist takes over; the switch is recorded on it. */
  session_id: string;
  logger: Logger;
}

interface PersonaToolSetOptions extends PersonaTurnContext {
  tracing: AgentTracing;
  sentinel: SentinelHostContext;
}

type Prepared<T> = { ok: true; value: T } | { ok: false; message: string };

interface PreparedCreate {
  approved: Record<string, unknown>;
  content: PersonaContent;
  description: string;
}

const NOT_APPROVED = 'Nothing was added because the user has not approved it. Ask again if they still want it.';

/** Plain words for the model: the specialist was added and now answers this chat from the next message on. */
function createdMessage(name: string): string {
  return `The specialist ${name} is ready and now answers this chat from the next message on. Tell the user in one plain line: "Now talking with ${name}." Do not say the current request was handed to them.`;
}

/** Reusing a specialist says so plainly, then switches the chat to it the same way. */
function reusedMessage(name: string): string {
  return `Tell the user in one plain line: "Using your existing ${name}." Then tell them in one more plain line: "Now talking with ${name}." Do not say the current request was handed to them.`;
}

/** A specialist's first line is its one-line description: the description leads the stored instructions. */
function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? '';
}

function jsonResult(value: unknown) {
  return toolResultResponse({ text: JSON.stringify(value) });
}

function errorResult(message: string) {
  return toolResultResponse({ text: JSON.stringify({ error: message }), isError: true });
}

/** Each problem with the call, by field, in one line. */
function plainIssues(error: z.ZodError): string {
  const issues = error.issues.map(issue =>
    issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`,
  );
  return `These details were not valid: ${issues.join('; ')}.`;
}

/**
 * Adds one specialist for the person in this chat. It can only create: existing personas are never edited or
 * deleted here. Creating always shows a card first.
 */
export class PersonaToolSet extends LocalToolMCP {
  readonly name = PERSONA_SERVER_ID;
  readonly displayName = 'Specialists';
  readonly #options: PersonaToolSetOptions;
  readonly #tools: ToolDefinition[];

  constructor(options: PersonaToolSetOptions) {
    super({ tracing: options.tracing });
    this.#options = options;
    this.#tools = [
      defineTool({
        name: CREATE_PERSONA_TOOL_NAME,
        description:
          'Add a lasting specialist for the user: a short name, a one-line description, and instructions for what it focuses on and how it talks. Call list_personas first, and use use_persona instead when a specialist already fits. The user approves a card before anything is saved. On success this chat switches to the specialist. It cannot change or delete an existing specialist.',
        schema: CreatePersonaToolSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: (input, approval) => this.#create({ input, approval }),
      }),
      defineTool({
        name: LIST_PERSONAS_TOOL_NAME,
        description:
          "List the user's specialists: each name, its aliases, and its one-line description. Call this before create_persona to see whether one already fits.",
        schema: z.object({}).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        handler: () => this.#list(),
      }),
      defineTool({
        name: USE_PERSONA_TOOL_NAME,
        description:
          "Switch this chat to one of the user's existing specialists by name. Use it instead of create_persona when a specialist already fits. Nothing is saved or changed.",
        schema: UsePersonaToolSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        handler: input => this.#use(input),
      }),
    ];
  }

  protected getTools(): ToolDefinition[] {
    return this.#tools;
  }

  /**
   * The host classifies every create. The card is built from the exact content that would be saved, and the
   * approved call carries the model it was settled on, so a change of model needs a new approval.
   */
  override async toolCallInfo(
    params: CallToolRequest['params'],
    resolveUnderlyingTool?: boolean,
  ): Promise<Awaited<ReturnType<LocalToolMCP['toolCallInfo']>>> {
    const info = await super.toolCallInfo(params, resolveUnderlyingTool);
    // A preview while the call streams in has no arguments yet: classifying it would only repeat side effects (an audit row, a live read).
    if (resolveUnderlyingTool === false || !isPersonaWriteToolName(params.name)) {
      return info;
    }
    const prepared = await this.#prepareCreate(params.arguments ?? {});
    if (!prepared.ok) {
      // Not a permission wall: the model can fix the call or ask the user.
      return { ...info, pre_dispatch_failure: { kind: 'pre_dispatch_failed', message: prepared.message } };
    }
    const { approved, content, description } = prepared.value;
    const decision = await classifyHostToolCall({
      sentinel: this.#options.sentinel,
      repository_id: null,
      workspace_cwd: null,
      action: {
        tool_name: params.name,
        canonical_params: approved,
        tool_type: 'truefoundry-system',
        mcp_server_name: PERSONA_SERVER_ID,
        mcp_hints: {
          read_only_hint: info.read_only_hint,
          destructive_hint: info.destructive_hint,
          open_world_hint: info.open_world_hint,
        },
        persona_write: {
          name: content.display_name,
          description,
          instructions: content.instructions,
          model_name: content.model_name,
        },
      },
    });
    return {
      ...info,
      ...stampSentinelDecision({ decision }),
      mint_canonical_params: approved,
    };
  }

  /** Re-settles a create at dispatch, so an approval ends when what it covered changed. */
  async liveMintParams(params: CallToolRequest['params']): Promise<Record<string, unknown> | undefined> {
    if (!isPersonaWriteToolName(params.name)) {
      return undefined;
    }
    const prepared = await this.#prepareCreate(params.arguments ?? {});
    if (!prepared.ok) {
      throw new Error(prepared.message);
    }
    return prepared.value.approved;
  }

  /**
   * Validates with the same persona content schema the API uses, then refuses a name that already invokes one
   * of this person's personas. The store repeats that check on write, so a race still cannot duplicate.
   */
  async #prepareCreate(args: Record<string, unknown>): Promise<Prepared<PreparedCreate>> {
    const parsed = CreatePersonaToolSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, message: `Nothing was added. ${plainIssues(parsed.error)} Fix this and try again.` };
    }
    const input = parsed.data;
    const content = personaContentFor({ ...input, model_name: this.#options.model_name });
    const valid = PersonaContentSchema.safeParse(content);
    if (!valid.success) {
      return { ok: false, message: `Nothing was added. ${plainIssues(valid.error)} Fix this and try again.` };
    }
    const taken = await this.#takenNameKeys();
    if (taken.has(personaMatchKey(content.display_name))) {
      return { ok: false, message: this.#duplicateMessage(input.name) };
    }
    return {
      ok: true,
      value: {
        approved: { ...args, resolved_model_name: this.#options.model_name },
        content: valid.data,
        description: input.description,
      },
    };
  }

  /** Every name and alias the owner's personas already answer to, in match form. */
  async #takenNameKeys(): Promise<Set<string>> {
    const personas = await this.#ownerPersonas();
    const keys = new Set<string>();
    for (const persona of personas) {
      keys.add(personaMatchKey(persona.display_name));
      for (const alias of persona.aliases) {
        keys.add(personaMatchKey(alias));
      }
    }
    return keys;
  }

  #ownerPersonas(): Promise<Persona[]> {
    return this.#options.store.listPersonas({
      tenant_id: this.#options.tenant_id,
      created_by: this.#options.owner_id,
    });
  }

  async #list() {
    const personas = await this.#ownerPersonas();
    return jsonResult({
      specialists: personas.map(persona => ({
        name: persona.display_name,
        aliases: persona.aliases,
        description: firstLine(persona.instructions),
      })),
    });
  }

  /** Switches this chat to an existing specialist. Nothing is saved, so no card is shown. */
  async #use(input: UsePersonaToolInput) {
    const key = personaMatchKey(input.name);
    const persona = (await this.#ownerPersonas()).find(candidate => personaNameKeys(candidate).includes(key));
    if (persona === undefined) {
      return errorResult(
        `Nothing was changed because the user has no specialist named "${input.name}". Call list_personas to see the names, or create_persona to add one.`,
      );
    }
    await this.#switchChat(persona);
    return jsonResult({ using: { name: persona.display_name }, next: reusedMessage(persona.display_name) });
  }

  #switchChat(persona: Persona) {
    return activateSessionPersona({
      store: this.#options.store,
      tenant_id: this.#options.tenant_id,
      session_id: this.#options.session_id,
      persona,
    });
  }

  #duplicateMessage(name: string): string {
    return `Nothing was added because the user already has a specialist named "${name}". Try again with another name.`;
  }

  async #create(input: { input: CreatePersonaToolInput; approval: ApprovalDecision | undefined }) {
    if (input.approval?.status !== 'allow') {
      return errorResult(NOT_APPROVED);
    }
    const prepared = await this.#prepareCreate(input.input);
    if (!prepared.ok) {
      return errorResult(prepared.message);
    }
    const { content, description } = prepared.value;
    let created: Persona;
    try {
      created = await createPersonaForOwner({
        tenant_id: this.#options.tenant_id,
        owner_id: this.#options.owner_id,
        content,
        personaStore: this.#options.store,
        modelProviderStore: this.#options.modelProviderStore,
      });
    } catch (error) {
      if (error instanceof PersonaNameConflictError) {
        return errorResult(this.#duplicateMessage(content.display_name));
      }
      throw error;
    }
    await this.#switchChat(created);
    return jsonResult({
      created: { name: content.display_name, description },
      next: createdMessage(content.display_name),
    });
  }
}

const PERSONA_INSTRUCTION_SECTION = 'specialists';
const PERSONA_INSTRUCTION =
  'Before adding a specialist, call list_personas. If one already fits, switch to it with use_persona instead. Specialists are added only with create_persona, which asks the user first. Say one was added only when create_persona succeeded. Never change or delete a specialist from chat.';

function buildPersonaInstruction(builder: InstructionBuilder): void {
  builder.addSection(PERSONA_INSTRUCTION_SECTION, PERSONA_INSTRUCTION);
}

/** Attaches the specialist tool to one chat turn's root thread. */
export function personaCapability(options: PersonaToolSetOptions): AgentCapability {
  return { systemToolSets: [new PersonaToolSet(options)], instructionBuilders: [buildPersonaInstruction] };
}
