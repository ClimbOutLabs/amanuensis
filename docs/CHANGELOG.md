# Changelog

## 2026-09 initial public release

Amanuensis is a local-first AI workbench built on TrueForge, the open-source agent harness from TrueFoundry. It provides a browser-based chat interface with configurable models, MCP tools for external services, reusable agent workflows called skills, sandboxed code execution, persistent sessions, and personalized memory features that remain under the user's control.

This release brings hardened sandbox tooling with multiple validation and recovery paths, expanded memory capabilities with layered recall and curated context, improved chat UI behavior and error reporting, stronger model compatibility across providers, comprehensive autonomous workflow support through the Chief-of-Staff shell, and systematic safety guards that warn the model before stopping a turn.

## Sandbox and tools

- Structured edits now normalize arguments through a single layer before validation, handling markdown fences, CRLF line endings, BOM stripping, blank-line trimming, absolute-path rewriting, and Unicode hyphen normalization across apply_patch, replace_text, and write_file; a rejection contract gives every tool a consistent error format so the model always knows what to correct (#128)
- Every model tool call produces a compatibility assessment: real output shapes from gpt-oss-120b and qwen3-coder-next are replayed through normalizers and validators to ensure both models' structured-edit output is handled correctly (#128)
- replace_text now requires an exact, unique match of old_text in the file after normalization; when exact matching fails it tries with line-number gutters stripped (e.g., "212 | "), and rejects ambiguous or missing matches with concrete feedback instead of silently picking one (#134)
- apply_patch accepts OpenAI's envelope format (*** Begin Patch / *** Update File: / *** End Patch) by converting it to git diff before validation runs, so gpt-oss and other models that emit this format no longer fail and fall back to unstructured shell edits (#123)
- Sandbox coding guidance now tells the model to confirm a file path exists with a listing or search before opening it instead of guessing from a component name, and to write one short sentence before each tool call stating what is about to happen and why (#124)
- A chat without a bound repository can write files into the sandbox provider's workspace as scratch space; skills that create reference files and research tasks that save notes no longer fail with "requires a host-bound workspace" (#95)
- Sandbox execution allows file descriptor duplication in exec commands for advanced use cases like tee and process substitution (#108)
- Git commands against github.com now tell the model when the failure is because the GitHub connector is missing or unconfigured, instead of leaving it to guess and probe for credentials (#107)
- An identical tool call that failed can now be retried once the user approves it, instead of being rejected as an unknown prior outcome (#106)
- Scratch-space writes do not run git, so writing temporary reference files does not trigger version-control operations (#105)
- Verify and commit sandbox operations now work on chats without a bound repository, using the provider workspace if one is available (#100)
- File-editing attempts now detect absolute paths inside the workspace and rewrite them to be relative to the workspace root, so code using absolute workspace paths is handled correctly (#120)
- Web search result egress from exec commands routes through a configured web connector instead of curl, so the model uses the connector's fetch/extract tool rather than shell commands (#125)
- Repository inspection activities now track a per-session budget so repeated inspection does not consume unbounded resources (#84)
- Model tool invocations now enforce tool-call ID uniqueness and never apply the same approval twice, keeping approvals and their results permanently attached to their specific invocation (#70)
- Record tools used by autonomous workflows report their invocation limits plainly in error messages when the budget is reached (#74)
- Exec commands can now perform deterministic decimal arithmetic via a specialized built-in tool, so financial and scientific calculations do not suffer from floating-point error (#71)
- Git tree paths are checked for duplicates during addition, preventing malformed or corrupted repository state from reaching the model (#60)
- Exec commands that attempt network operations are flagged when a web connector is configured, with remediation suggesting the connector's fetch tool instead of shell alternatives (#38)
- Claims about current state (what exists, what is latest, what is installed) now require source discovery: ground-truth checks or tool calls that retrieve facts, not assumptions or training data (#48)
- Tool annotations from the implementation plan are preserved when the model retries a call after an edit or approval, so tool context does not reset across sandbox interactions (#54)
- Verification commands can now run after an edit or commit in an otherwise unchanged workspace, while identical retries in a workspace that has not changed remain blocked (#11, #9)
- Supervised coding execution now carries repository bindings, implementation-plan grants, verification commands, task checklists, and tool-result dispositions across approvals and continuations without losing state (#26, #7)
- Cancelled turns now finish cleanly even when a model provider stops responding, and stream cleanup errors do not leave the turn stuck (#9)
- FFmpeg is included in the sandbox image for audio and video processing (#163)
- Sandbox image includes fifteen Tesseract OCR language packs; OCR defaults to English, Hindi, and Marathi (#167)
- Tesseract language packs are configurable in the sandbox image at build time; OCR commands can specify language packs per call (#162)
- File artifacts render download links for every markdown block shape the model writes: lists, colon format, bare paths, or bracketed links (#182)
- Meta-tools (list_tools, get_tool_info, get_tool_output_schema) routed through call_tool now dispatch directly instead of failing; greeterless messages do not trigger tool use (#183)

## Context and compaction

- Compaction instructions now go to the model as a system message instead of user content, so the model summarizes the conversation itself rather than the summarization request; a deterministic guard rejects self-referential summaries (#136)
- Context compaction picks a template by session mode instead of using a single engineering-handoff template for every chat; plain conversation mode gets a new template focused on establishing facts, answers given, and open questions rather than code and repository state (#130)
- Compaction now frames host-provided context with one sentence stating plainly that it is a host-written summary of earlier conversation and replies should continue in the user's own register, not as a model-role message (#130)
- Memory recall is now relevance-gated after compaction, so summaries from compaction do not bypass the recall filter that other memory sources pass through (#133)
- Compaction no longer fails when the model copies the host's own host_owned_touched_paths notes from a previous summary; the host strips the copied subsection and uses its own authoritative record instead (#116)
- The system prompt now carries today's date in YYYY-MM-DD format, so models do not assume training-era dates and reason years into the past when they need to recall something from "today"; the date changes once per day and provider prefix caching keeps working (#103)
- Freshness questions (what is latest, what is current, what exists now) are grounded with host facts and retrieval checks, so claims about current state do not rely on training data (#104)
- Model stream breaks trigger immediate context compaction and one retry; if a second break occurs, the turn ends with a clear explanation (#187)

## Memory

- Memory settings now expose live tool-output screen status (Recall screen and Live tool-output screen) so users can see whether optional prompt-injection screening is active, and whether a memory provider with optional screening is configured (#86)
- The learned user profile now distills only from what the user themselves typed that turn; the assistant's own reply is no longer sent to the profile-learning model, so a name or fact the assistant asserted can never be learned as true about the user (#114)
- Memory turn context rendering no longer races overlapping polls for recall/profile state; it keeps polling for a grace period after a turn completes so profile writes that land after turn_done are not missed, and surfaces failed reads as an actionable "context unavailable" state instead of silent failure (#86)
- Memory context now walks every page of session events instead of stopping after ten, so recall and profile cards for older turns in long sessions are included (#86)
- Every turn's memory block is now assembled from up to three provider layers read concurrently, each degrading independently: curated context (profile and mental models selected by term overlap), standard recall, and synthesis reflection for analytical asks, with configurable budgets and timeouts (#63, #56)
- Mental models are picked deterministically from the model bank by term overlap with the recall query, ranked by relevance, and capped by count and token limits (#56)
- Synthesis reflection runs only on analytically-shaped requests (summarize, recommend, compare, assess, etc.), not factual lookups, so the model's reflection budget is spent efficiently (#56)
- The recall event now records which memory layers were injected and whether reflection was called, so every memory decision is explainable from the event data (#56)
- Memory recall queries are built from recent user messages rather than only the most recent one, capturing more context for better recall matching (#55)
- Curated memory lines and reflection output are screened like untrusted-origin tool output when optional screening is enabled, so the model does not see withheld content (#56)
- Memory is configured entirely through Settings > Memory, with all memory-related knobs exposed in one place rather than scattered across environment variables and connectors (#69, #32)
- Recalled memory and learned-profile context are rendered durably per turn, so users see exactly what context each turn received (#42)
- Mental models that are still generating are skipped from the recall block rather than blocking the turn while they complete (#68)
- The memory provider shows its server-side defaults in Settings, so users understand what resource limits and timeouts are in effect (#79)
- Recall screening status is surfaced in Settings so users can see whether the optional prompt-injection screen is active (#40)
- Open-world tool output (e.g., web fetch results, external API responses) is screened at the point of use before entering model context, with flagged or unclassifiable output replaced by a withholding marker while the raw result is preserved in durable audit events (#51, #35)
- Host-enforced long-term memory (Hindsight integration) provides hosted recall, learned-profile distillation, and optional recall screening with degrade-not-die semantics: if any memory feature is unavailable, the turn continues with the other layers (#21)
- Hindsight memory uses LKOS protocol for secret references in configuration, so credentials are never stored in plaintext and can be rotated without application changes (#14)
- Memory recall events are streamed to the model without breaking SDK-based clients that do not expect streaming in that context (#22)
- vLLM prompt-cache usage is reported truthfully in the CLI and UI so users see the actual cost and cache behavior of their sessions (#13)
- Settings now include a switch to enable or disable the recall screen per memory bank, giving users explicit control over memory filtering (#179)
- Memory context cards display recalled memory as an injected block with a simpler, more direct label (#177)

## Documents and vision

- Web search results are now rendered compactly as markdown before large-tool-response handling sees them; the real dispatcher response envelope is parsed correctly and results are displayed inline instead of being written to a file for the model to read back (#131)
- Web search result rendering fixes: tool identity is matched against the underlying tool name (not the dispatcher function name), and the result envelope is unwrapped correctly to extract excerpts and metadata (#131)
- Images attached to chat are downscaled before the model sees them, reducing token usage when users include screenshots or large image files (#96)
- The sandbox no longer accepts requests to generate new images; requests are declined plainly (#96)
- Web search results render with up to 10 entries, each showing a title, URL, and up to two lines of excerpt, plus a structural summary showing array lengths and top-level keys for very large JSON results, so the model has a shape to work from (#125)
- Large JSON tool results now carry a structural summary showing top-level keys and array lengths instead of requiring the model to page through raw data (#125)
- Local PDF and OCR ingestion processes searchable PDFs with Poppler and applies Tesseract OCR to image-only PDFs and screenshots, making documents searchable without external services (#34, #10)
- PDFs and DOCX files can be uploaded as chat attachments and processed locally; DOCX reports are created as writable artifacts with approval (#10)
- Document snapshots are bounded, immutable, path-checked, and hash-verified before extraction, preventing malformed or corrupted files from reaching the processing pipeline (#10)

## Chat UI and composer

- Composer draft persistence only writes what the user types; it no longer decides whether a send failed, leaving that to the chat runtime which re-offers the text when the server does not register the message; a sent message can no longer come back into the composer after its reply arrives (#135)
- A draft that was already delivered is dropped instead of restored when the composer remounts or the page reloads, so sending a message and then refreshing no longer brings it back for editing (#135)
- Composer draft reappears when returning to a conversation, preserving unsent text across tab switches (#109)
- The UI now offers only supported effort levels for each session type, and clears stale send errors when opening an unrelated error dialog (#110)
- Typed messages are kept across page reloads and the sign-in round trip, so users do not lose their draft text when the session expires (#93)
- Streamed tool cards settle without requiring a page reload; the UI consolidates the final result as it arrives rather than waiting for a full refresh (#88)
- Continued turns (from resume or retry) render once while streaming instead of appearing twice in the chat panel (#101)
- Failed turns with no assistant message remain visible after page reload and session reconstruction, showing the error that caused the failure (#82)
- The first empty chat now shows a greeting in the assistant's name (if configured), a checklist of what is not yet set up (model and memory), and links to Settings (#77)
- Mobile and reasoning red-team blockers are cleared so the chat works smoothly on mobile devices and on models with extended reasoning capabilities (#52)
- Turns continue running across mobile navigation instead of cancelling when the user switches tabs or backgrounds the app (#46)
- The mobile rail stays out of the chat interface, keeping the composition and message areas undisrupted (#29)
- Chat column uses up to 1240px window width with 1rem side margins, expanding the readable area on wider screens while remaining readable (#191)
- Chat thread width is now 900px instead of 704px, cutting gutters roughly in half while keeping the column readable and centered (#181)
- Tool error messages in the agent steps panel now wrap to multiple lines instead of overflowing horizontally (#180)
- Mascot idle breathing animates visibly at panel size with larger scale, vertical drift, and occasional gentle tilts; listening and busy states animate more prominently (#178)
- Mascot animation styles ship in the package stylesheet instead of being injected at runtime (#169)
- Chat opens in light mode by default; the theme toggle and stored preference still override the default (#168)
- Runtime panel no longer shows a fixed Runtime field; Build, Model, and Memory information remain (#175)

## Spaces

- Spaces are persistent records the model creates and updates during chat, with a dedicated full-page view in the sidebar (#171)
- Spaces render as full pages with layout, typography, images from https or data URLs, and tables, instead of as modals with plain text (#176)
- Spaces can be formatted as HTML pages with style blocks, real typography and layout, images, and tables; markdown is still the default (#186)
- HTML space frames now size to their content and scroll wide tables inside the page instead of overflowing past the frame (#189)
- HTML and markdown spaces are tracked with a format column in the database, backfilled as markdown for existing spaces (#188)
- Space bodies accept markdown as an array of lines, one per element, so the model can format tables and structured content correctly (#172)
- List and read tools for spaces allow the model to discover existing spaces before creating duplicates, and retrieve revisions to update them accurately (#173)

## Personas and profiles

- Model roles allow assignment of separate models to conversation and auxiliary work; roles are durable across sessions and can be switched during a conversation (#5, #3, #4)
- The host can assign per-role models for its own operations independently of user-selected models, so background tasks use appropriate models without affecting what the user sees (#3)
- Personas support natural speaker switching; users can create and switch between personas with distinct profiles and chat histories (#33)
- Active speaker context is isolated so replies do not accidentally speak as the wrong persona (#58)
- Persona selection now accepts articles in evidence so references to "the assistant" or "the model" are understood correctly (#83)
- Model-role selections persist across catalog refresh and provider changes, so switching model providers does not lose role assignments (#43)
- Profile learning is a toggle in Personalization rather than an environment variable, so users can enable or disable it without restarting (#30)
- The learned profile distills into markdown that captures the user's preferences, communication style, and context, building over multiple conversations (#27)

## Bug reporting and diagnostics

- A "Report a bug" control in the sidebar opens a compact modal with an optional description, fetching a redacted diagnostic bundle from the current session (#45)
- The bug report bundle includes what happened: summary lines per turn showing what came in, model steps, which tools ran and their exit codes, and how the turn stopped, plus timing and token usage (#94)
- Bug report summary lines are written by the host from structure only: turn outcomes, pending action counts, and tool dispositions, so every failure is explained (#94)
- Large-output guard events are named in the bundle so the model never saw the result, explaining why the model might have taken unusual steps (#94)
- Session context in bug reports includes connector names, skill names, and sandbox status so troubleshooting is grounded in the actual configuration (#94)
- Reporters can optionally include the chat in the bug bundle, with tool step intent recorded (but not arguments), so troubleshooting has context without exposing sensitive data (#80, #94)
- Build reports from the bug bundle include only fixed host messages, tool names/effects/outcomes, and non-secret config flags; message text, memory content, tool arguments/results, and any credential or token are never included (#45, #94)
- Document report artifacts are recorded in diagnostic evidence, so auditing and troubleshooting include proof of what reports were created (#65)

## Chief-of-Staff and autonomous workflows

- The Chief-of-Staff shell provides Home, Attention, Spaces, and Search surfaces in addition to Chat, keeping the experience intentionally calm and judgment-led (#59)
- Home shows the most important decision and compact secondary decisions, prepared work, and handled work, with the composer subordinated below (#66)
- Attention uses an Eisenhower-style matrix to prioritize decisions and assign explicit delegation or autonomy lanes (#66)
- Spaces directory shows active spaces with nested items and decision status (#66)
- The assistant can read the Chief-of-Staff briefing, create or update spaces, and create or update attention items during normal chat (#67)
- Approved chat tool invocations can update Chief-of-Staff records; once approval completes, the approval boundary is consumed and reuse requires fresh approval (#67)
- Model-readable record tools enforce invocation limits so they stay bounded and never consume unbounded resources (#81)
- Live commitments on Home show real owner-scoped records with deadlines, blockers, source-session links, and honest completion labels (#66)
- Returning to Home refreshes the commitment snapshot; navigation to discuss preserves unsent drafts without submitting messages or executing actions (#66)

## Mobile and connectivity

- Stream deadlines are now a provider-specific setting instead of hard-coded, so providers can configure timeouts appropriate to their response characteristics; empty heartbeats are no longer counted as progress (#113)
- Abort model streams that stop producing content, reasoning, or tool arguments, including streams kept alive by empty heartbeats; timeouts preserve the timeout cause and never admit unfinished tool proposals (#113)

## Tools and connectors

- A side-effecting tool call blocked by authRequired before it dispatched can now be retried once the user authenticates, instead of being rejected as an unknown prior outcome (#111)
- Users can remove a configured skill from the settings interface (#98)
- Users can remove a model provider from the settings interface (#99, #91)
- Connectors report when they are broken with specific diagnostics: memory-provider availability checks, connection tests, and preset configurations like Hindsight (#28)
- MCP connector deletion is now non-blocking and the connection status reporting is honest, showing when a connector is unavailable or failed (#41)
- Remote MCP servers now support pre-registered OAuth client authentication, expanding the connector ecosystem (#164)
- Shipped skill catalog accepts and respects skill prerequisites, allowing connectors to declare their dependencies (#166)
- Connectors picker now includes a toggle to enable or disable sandbox access per connector (#170)

## Rendering and display

- Assistant prose normalizes Unicode hyphens (U+2010), non-breaking hyphens (U+2011), and no-break spaces (U+00A0, U+202F) to plain ASCII at render time so fonts render them correctly and long lines do not overflow; the stored message remains byte-for-byte what the model produced, and normalization is skipped inside code blocks (#121)
- Tool results that exceed the display limit are handled plainly: when a result is too large to see, the UI says so instead of silently truncating or trying to render incomplete content (#102)
- The running build identity (version and source reference) is displayed in the runtime rail so multiple running instances can be distinguished at a glance (#36)

## Providers and models

- When a session has a pinned model that becomes unavailable or stale, the session follows the current model instead of using an outdated version (#122)
- Ollama provider now reads the reasoning field from model responses and handles it correctly (#115)

## Hardening and safety

- Four guard rules (identical-call limit, failed-batch limit, empty-inspection limit, and blocked-before-dispatch limit) now send a host-authored nudge when their counter reaches three, describing what happened and what usually helps, before the unchanged stop at five; guards no longer stop cold with no warning (#127)
- A repeated identical tool call triggers a nudge before the turn stops, explaining what has happened and suggesting the user clarify the intent (#119)
- Compaction ensures structured-edit targets are observed from the same workspace root at both the approval and dispatch stages, preventing path confusion (#117)
- Sandbox execution now reports honest result status: search exit codes match the shell semantics, not flattened to binary pass/fail; memory recall is skipped during coding sessions to avoid confusing code tool output with prior conversation context (#129)
- Bound stalled model streams without admitting unfinished tool proposals, even if a partial tool call arrives in the buffer (#89)
- Turns that keep failing or keep repeating the same call are stopped with a clear explanation rather than spinning indefinitely (#92)
- When a provider's last model is removed, the UI offers to remove the provider itself, preventing orphaned configurations (#91)
- Live tool output cards and terminal errors stay honest without requiring a reload; status updates arrive inline as the turn progresses (#90)
- The turn-error report now names the host cause (e.g., "provider response timeout", "sandbox service unavailable") instead of just reporting failure, so troubleshooting becomes actionable (#97)
- Agent definitions are given required configuration keys so they load correctly (#112)
- Personalization UI shows readable save errors and maintains stable input focus during preference editing, so errors are diagnosable and users do not lose text mid-keystroke (#39)
- Hard stop at 30 inspection commands without an edit; no-match results from grep and similar commands now carry explicit feedback (#185)

## Build and release

- Public export is generated as one squashed commit with all private material removed (#161)
- The assistant-ui-runtime pnpm patch is expressed without file renames, making it portable across development environments (#137)

---
