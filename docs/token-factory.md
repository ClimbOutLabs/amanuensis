# Nemotron on Nebius Token Factory

With `NEBIUS_API_KEY` set, the server connects a read-only `tokenfactory` provider (Nebius Token Factory) at startup. It lists `TOKEN_FACTORY_MODEL` (default `nvidia/nemotron-3-super-120b-a12b`, NVIDIA Nemotron 3 Super) and makes it the chat default. It also lists the other Token Factory models in the model catalog, so a chat can switch between them. The daily token cap counts all of them. The provider is managed by the environment. The models appear in **Settings, Models** and can be assigned to roles. A model an earlier start registered stays listed after the variable changes, so roles, personas and agents that still point at it keep working.

**Which role uses which model.** Every job the server does with a model is a role, and each role can have its own model under **Settings, Roles and Personas**. A role left unset uses the main chat model, and that includes the helper jobs below.

| Role                | What it does                                            | Where the model comes from                                  |
| ------------------- | ------------------------------------------------------- | ----------------------------------------------------------- |
| Main chat           | Answers you, including requests for a briefing          | Main chat model                                             |
| Coding / sub-agent  | Work the assistant hands to sub-agents                  | Coding / subagent model, else the main chat model           |
| Compaction          | Summarizes old context in long conversations            | Compaction model, else the main chat model                  |
| Summarization       | Condenses each turn before it is written to memory      | Summarization model, else the main chat model               |
| Profile learning    | Rewrites the learned profile after a turn, when enabled | `PROFILE_LEARNING_MODEL`, else the main chat model          |
| Knowledge relevance | Checks which library passages help answer a question    | The persona's model                                         |
| Persona             | Answers as that persona                                 | The model bound to the persona under **Roles and Personas** |

**Why tier them.** Helper jobs are short and structured: a few hundred tokens in, a short summary or a yes/no list out. They run on every turn, so their price and latency add up. A small model is cheaper, but it can write poor memories, so pick one under **Settings, Roles and Personas** only if you trust it. A weak compaction summary degrades every later turn of a conversation, so keep that role on a model you trust.

**What it costs.** Prices are USD per million tokens, read on 2026-10-15 from the Token Factory model catalog (`https://tokenfactory.nebius.com/model-catalog.md`) and confirmed against its models endpoint (`https://api.tokenfactory.nebius.com/v1/models?verbose=true`).

| Model                                   | Input | Output |
| --------------------------------------- | ----- | ------ |
| `nvidia/nemotron-3-super-120b-a12b`     | 0.30  | 0.90   |
| `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` | 0.06  | 0.24   |
| `nvidia/Nemotron-3-Ultra-550b-a55b`     | 1.00  | 3.00   |
| `nvidia/Nemotron-3_5-Lightning`         | 0.06  | 0.24   |
| `nvidia/Nemotron-3.5-Super-VL`          | 0.30  | 0.90   |
| `openai/gpt-oss-120b`                   | 0.15  | 0.60   |

These defaults are a snapshot and are meant to be edited. Set `TOKEN_FACTORY_PRICES` to JSON keyed by model id, for example `{"nvidia/nemotron-3-super-120b-a12b":{"input_per_million":0.3,"output_per_million":0.9}}`. Entries add to and win over the defaults, and an entry also gives a model on another provider a cost. A model with no price shows tokens only.

**Where cost shows.**

- With **Show agent details** on for the chat, each answer's details show a quiet line with the model, its provider, and the tokens and cost of the whole turn, for example `Nemotron 3 Super · Token Factory · 2,140 tokens (1,800 in, 340 out) · $0.0011 at list price · + 2 helper calls on Nemotron 3 Super`. Helper calls are included in the total.
- In the same details, each role that ran appears with its model, calls, tokens and cost.
- **Settings, Models** shows today's tokens and cost per Token Factory model and the daily cap remaining.
- **Settings, Themes, Answers** switches the line and the helper rows off for you. This changes only what is shown; usage is still counted.

Token counts are the usage the provider reported for each call and are never estimated: if a provider reports no usage for a call, the line says `usage not reported`. Cost is an estimate from the price table above, labelled "at list price", not your bill. Usage is recorded for completed turns; a turn that errors or is cancelled shows no line, though its tokens still count toward the daily total.

**Daily cap.** Set `TOKEN_FACTORY_DAILY_TOKEN_CAP` to limit Token Factory tokens per UTC day for the whole instance. Input and output tokens from every Token Factory call count, including helper calls and the fallback in `TOKEN_FACTORY_MODE=fallback`. The cap is checked before every model call: once it is reached, a new turn on a Token Factory model is refused with a 429 (`token_factory_daily_cap_reached`) and a turn already running stops before its next model call. It resets at midnight UTC. Without the variable there is no cap, but the daily tokens are still counted per model for the Settings view.
