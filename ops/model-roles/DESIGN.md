# Model roles and personas

Two increments. V1 is manual auxiliary roles chosen by host call site. V1.1 adds
persona-to-model bindings inside one conversation. Neither increment performs
topic or domain routing. V1.1 does use the main chat model for one bounded,
tool-free classification when the current message names a configured identity
but does not match the deterministic invocation grammar.

## Settled by inventory, not preference

The repository has four model call sites and three provider construction sites:

    AgentThread.ts               modelClient.create()          main + sub-agent turns
    ContextCompaction.ts         modelClient.createNonStream() compaction
    profileLearning.ts           modelClient.createNonStream() learned-profile distillation
    personaIntent.ts             modelClient.createNonStream() explicit speaker preflight
    turns.ts / profileLearning.ts / personaIntent.ts           provider construction

The bounded persona preflight intentionally reuses the main chat model: it is
part of admitting the same user turn, not a separately configurable workload.
Four other proposed roles have no model call and therefore get no setting:

- **Title generation** is deterministic. `deriveSessionTitle` takes the first
  user message, drops file parts, joins the text and slices to 50 characters.
- **Vision and file analysis** have no distinct call. Images become `image_url`
  content parts inlined into the ordinary user message; files get a sandbox path
  in the prompt and are read with normal tool calls.
- **Workflow authoring and execution** do not exist in this repository. No
  definition type, no engine, no scheduler. That concept belongs to the older
  Rust project.
- **Approval and triage** are pure functions and set membership. No model.

Adding settings for these would create controls that change nothing, which is
worse than their absence: a user who sets a cheap model for "vision" and sees no
cost change learns that the settings lie.

## V1: auxiliary roles

Three roles, because three call sites.

**Main chat.** Already `spec.model`. This is the baseline every other role
inherits from, and it is what "default" resolves to.

**Compaction.** A real, separate call with its own summarization prompt, but it
is handed `definition.modelClient`, the thread's own client. Giving it a role
means resolving a second client and threading it into `contextCompaction()`
instead of reusing the thread's.

This is the role most worth having and the easiest to get wrong. Summarizing is
cheaper work than reasoning, so a smaller model is genuinely attractive. But a
bad compaction silently corrupts every later turn in that thread, and the damage
surfaces as the assistant mysteriously forgetting things, far from its cause.
Inherit by default, and record which model compacted.

**Delegation.** Sub-agent threads already resolve independently:
`modelName = agentInfo?.model ?? spec.model.name`. The plumbing is complete and
unreachable, because `DynamicSubAgents` only exposes the parameter when given a
`modelSetConfig` and the sole production call site never supplies one. Wiring
that is most of the work.

### Rules

Absent means inherit the active main model, resolved at use, not copied at save
time. Changing the main model moves every inheriting role with it.

An explicitly selected model that is no longer configured fails visibly. It does
not fall back to main. A silent substitution produces work attributed to a model
that did not do it, which is the failure this whole feature exists to avoid.

Roles resolve through the existing provider records and the existing
`deps.llm(name)` factory. No second provider abstraction, no endpoint
configuration duplicated per role.

## V1.1: personas in one conversation

A persona is identity and instructions. Its model binding is separate structured data
referencing an installed model. The two are never merged, so a persona can be reassigned
to a different model without editing its prompt.

### Why this is cheap, and it is not obvious

A model is bound per thread. `ILLM.create()` omits `model` on purpose, and
`VercelAILLM` is immutable after construction. That reads like switching models
mid-conversation requires threading a model parameter through the LLM layer,
every provider adapter, and `AgentThread`.

It does not, because **`SessionHandle.buildThreads` constructs a fresh
`AgentThread` for every turn**, and `resolveAgentDefinition` resolves the model
at that moment. Conversation history lives in the session store and is loaded
into context; it was never attached to the thread.

So persona switching is a resolution-time decision: at turn start, resolve the
selected persona's bound model instead of `spec.model.name`. Shared history
survives because nothing about it depends on which client ran the previous turn.

### Selection

Explicit speaker selection only. `matchPersonaInvocation` compares the start of the first user message
against the names the user configured — display name plus aliases, case-folded with
internal whitespace collapsed — and accepts two shapes:

- direct address, where punctuation marks it as address: `Zara,` / `Zara:`
- an explicit lead-in: `ask Zara`, `let me talk to Zara`, `talk to Zara`, `@Zara`, and
  the small set of `speak to` / `I want to` / `can I` variants in `INVOCATION_LEAD_INS`

Anywhere else in the message is prose. A bare name with no punctuation and no lead-in is
prose. The longest configured name wins, which only matters when one name is a prefix of
another; names are unique per owner, so the outcome never depends on storage order.

When a message mentions a configured persona or the personalized default-assistant name
but does not match that grammar, one bounded preflight on the main chat model classifies
only whether the user explicitly asked to change speakers. It receives no history, persona
instructions, tools, files, attachments, or memory. The host validates the returned target
and exact unquoted evidence clause, rejects overlapping shorter names, and keeps the current
speaker on malformed, uncertain, quoted, or negated results. This is language understanding
for an explicit control request, not topic-based persona routing.

The chat's last decision is sticky: with nothing named, the active persona remains
selected. With nothing named and nothing active, the main model remains selected.
Returning to the default assistant works through the UI (`PUT .../persona` with
`persona_id: null`) or an explicit natural request naming the personalized assistant
or the generic “default assistant” / “main assistant” labels.

### Storage, and why two tables

`persona` holds the records. `session_persona` is an append-only decision log per chat:
its highest-`seq` row is the active persona, and every row carrying a `turn_id` is that
turn's provenance. One table serves both questions, and the log survives deleting a
persona, so a past turn can still say which persona and model were selected for it.

Ordering is an explicit per-session `seq` assigned inside the insert's transaction, not a
timestamp and not the ulid. Two decisions can land in the same millisecond, and "which
persona is active" must never depend on which of two same-instant rows sorted first.

No row is written for a chat with no personas involved, so an install that has never
configured one pays a single indexed read per turn and behaves exactly as before.

### Provenance

`GET /api/v1/sessions/{id}/persona` reports the persona currently selected for the chat.
`GET /api/v1/sessions/{id}/persona-activations` reports which persona and model were
selected for a turn, and why — `invocation`, `sticky`, `explicit`, or `default`. Each row snapshots the
name and model as of the decision, so a later edit cannot rewrite history.
`GET /api/v1/personas/{id}/context` returns the exact text a root thread receives, the
same transparency `personalization/context` already provides.

### Personas cannot weaken the host

Persona instructions enter through `InstructionBuilder.addSection` with content
escaping, exactly as user instructions and personalization context already do.
They become one section inside the system prompt, not a replacement for it.

The harness sections stay above them and are not persona-editable: the
PermissionGate contract, tool policy, and the instruction that tool output is
data rather than commands. A persona that could rewrite those would be a
prompt-injection vector wearing a friendly name.

### Auxiliary roles stay separate from personas

Compaction uses the compaction role, never the active persona's model. If a user
switches to a small persona for a few turns, summarization for the whole thread
must not quietly move to that model with it. Operation roles are about how the
host does its own work; personas are about the identity and model selected for a chat turn.

This needed explicit work rather than falling out: with no compaction role configured,
`compactionModel` is undefined and the capability inherits `definition.modelClient` — the
very client the persona replaces. `PersonaTurnResourceResolver` therefore pins compaction
to `spec.model` whenever a persona is active and no role is set.

For the same reason there is no `auxiliary.psychology`. Domain specialists are
persona bindings, not auxiliary roles.

## Decisions taken during V1

Recorded rather than escalated, because each had a defensible answer and
stopping would have cost more than being wrong.

**Delegation needs no `modelSetConfig`.** The earlier plan wired a model menu
into `create_sub_agent` so the model could choose. Unnecessary: `agent_info` is
present only for sub-agent threads, so the host applies the role at resolution
and the model is never shown a model list. Four lines instead of threading
config through the capability layer, and model identity stays with the host,
which is what the brief wanted.

**Model params travel with the selected model.** Previously `spec.model.params`
was applied whatever resolved, so a sub-agent override would have inherited the
main model's temperature and reasoning effort. Parameters tuned for one model
can be meaningless or wrong for another.

**Clearing a role removes the key.** Writing the current main model's name in
instead would freeze the role, and it would silently stop following later
main-model changes. Inheritance resolves at use for the same reason.

**Compaction resolves only when the capability is enabled.** A stale override on
a spec with compaction switched off must not fail a turn for a model that will
never be called.

**The original runtime tranche was stacked on `claude/harness-on-main`.** V1 began while
that harness work was still under review. The private publication branch now carries the
complete reviewed stack and targets `main`, so one user-owned merge delivers a coherent
model-role contract rather than leaving V1.1 without its runtime foundation.

**`jq` and a POSIX env prefix removed from the generation path.** Neither runs
on Windows, so local SDK regeneration was impossible there. That matters more
than usual: CI cannot regenerate without a GitHub App this repository does not
have, which makes the local script the only route.

## Decisions taken during V1.1

**Persona models are validated at write time as well as at use.** A persona saved against
a model that does not exist could never run, and finding that out on first invocation
is worse than finding it out on save. The use-time check stays: a model can disappear
after the persona was saved, and that must still fail visibly rather than substitute.

**Personas own their params.** A persona turn takes the persona model's provider defaults
and not `spec.model.params`, the same rule the delegation role already follows: a
temperature or reasoning effort tuned for one model can be meaningless for another.

**A deleted persona resolves to the default assistant.** The sticky pointer may name a
persona that no longer exists. That is not a silent substitution — the user deleted it —
and failing every later turn in that chat would be worse than returning to the default.
The chat's persona endpoint resolves the same way, checking the newest activation against
the personas that still exist for this tenant and owner, so the indicator never names a
persona no turn would route to.

**Alias uniqueness is enforced by transactional name reservations.** The
`persona_name_key` primary key covers display names and aliases together after NFKC,
case-folding, and whitespace collapse. Persona content and its reservations are written in
one transaction, so concurrent creates and edits cannot both claim the same invocation.

**The turn's activation row is written after `createTurn` commits.** A row written first
would claim a persona was selected for a turn that was never created. Writing it second leaves one
window: the turn is durable and `running`, and the generator that writes its terminal state
has not been started. So a failed write ends that turn — abort, close the resolver, freeze —
before the request fails. Freezing is retried once because the operation is idempotent; if
both attempts fail, the request reports the provenance and cleanup failures together rather
than claiming the turn was ended.

**The Unicode name rule stays host-side.** The runtime check needs the JavaScript `u` flag
for `\p{L}` and `\p{N}`. OpenAPI cannot portably express that flag, so the wire schema
publishes the length contract while the host performs the Unicode character validation.

**Name folding is locale-independent.** `toLocaleLowerCase` reads the host's default
locale, and a Turkish one folds "I" to a dotless "ı" — the same configured name would
invoke on one machine and not on another. Keys are NFKC-normalised and folded with
`toLowerCase`, which also makes a full-width or decomposed spelling of a name the same
name.

**The generated SDK carries the persona routes.** `packages/trueforge-sdk` is regenerated
from the OpenAPI document, so `personas` and `sessionPersonas` are typed clients rather
than plain `fetch` alone. The frontend still reaches the routes with `fetch`, as
`personalizationApi.ts` does, and the test over that client still holds wire parity.

## What gets judged

Ordinary behaviour unchanged until a user selects something. Inheritance follows
a changed main model. Independent roles stay independent. An unavailable model
fails visibly at every call site. Resolution records exact identity. Each wired
call site is proven to use the model it was given.
