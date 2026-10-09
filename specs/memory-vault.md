# Spec: Memory Vault

**Status:** draft

## Problem

Aman already persists memories as Markdown files, but there is no way to inspect, correct, or manage them. Stale or wrong facts linger silently. Every fact lands in one pool that all personas read, so a persona cannot keep facts to itself. Export and import do not exist, so the user cannot back up or move their memory.

## Solution

A Memory Vault UI and API layer on top of the existing Markdown memory backend. Per-persona vaults that scope what a persona remembers and recalls, fact-level view/edit/delete, selective sharing across personas, and export/import.

## Design Decisions

**Build on Markdown memory, not a new backend.** The Markdown files are the source of truth. The vault is a management layer: parsing facts from the files, presenting them, and writing edits back.

**Facts are the unit of management.** A fact is a single atomic claim extracted from the memory files (e.g. "the user prefers oat milk"). The vault lists facts with their source file and timestamp.

**Vault scopes.** Memory is stored in vaults. The shared vault belongs to the user and is a scope readable by every persona and by the default assistant. Each persona has its own vault (`persona:<name>`) that only chats with that persona write to. The vault is the unit of scoping for both writing and recall. Distinct persona names always map to distinct vaults, even when they differ only in punctuation, accents, or script.

**Write rule.** A fact learned in a chat is retained into exactly one vault. With a persona active it goes to that persona's vault. With no persona active it goes to the shared vault. Facts are never copied between vaults.

**Recall rule.** A persona recalls from its own vault, the shared vault, and any vault the user has shared with it. With no persona active, recall reads the shared vault only. A persona never recalls from another persona's vault unless that vault is shared with it.

**Selective sharing.** Sharing is explicit and read-only. The user grants a persona read access to another vault; the grant never lets it write there. A fact in a persona vault is private to that persona until the user shares the vault.

**Delete and edit.** Deleting a fact removes it from the vault view and from recall for every persona that could read that vault. Editing replaces the fact text everywhere it is recalled. The history stays in the append-only logs; only the effective view changes.

**Derived state is per vault.** Search indexes, retain bookkeeping, and caches are kept inside each vault, so nothing derived from one vault can surface in another.

**Persona rename and delete.** A persona's vault is addressed by its name. Renaming a persona never moves or deletes facts: the old vault stays intact on disk and is reachable through the vault API by its old name, while the renamed persona starts with an empty vault. The vault list shows only current personas, so an orphaned vault is not listed, and sharing grants that refer to it are not shown in Sharing. Export from the old vault and import into the new one to carry facts over. Deleting a persona leaves its vault untouched; no persona recalls it until a persona with the same name exists again.

**Views.** The shared vault is not a global view of all facts. Any "all vaults" view in the UI is a union for the signed-in user only and never widens what a persona recalls.

**Markdown backend only.** The vault and persona scoping need the Markdown backend. Hindsight stays cold-archived and has no vaults.

## Scope

- Fact list per vault with source attribution (which file, when recorded)
- Edit a fact (the edited text replaces the original in the vault and in recall)
- Delete a fact
- Share a vault with another persona (read access)
- Export vault to JSON/Markdown archive
- Import from a previously exported archive
- Search across facts

## Privacy

- Vault contents never leave the device except via explicit user-initiated export
- Encrypted per-persona vaults are a separate feature (see private-by-architecture spec)

## Testing

- Synthetic facts only, never the user's real memories
- Verify: create fact in chat as a persona, see it in that persona's vault, edit it, confirm the edit is reflected in a new chat with the same persona
- Verify: delete a fact, confirm no persona that could read that vault recalls it
- Verify: a fact retained by persona A is not recalled by persona B
- Verify: a fact retained with no persona active lands in the shared vault and is recalled by every persona
- Verify: sharing A's vault with B lets B recall A's facts, and an unshared vault stays isolated
- Verify: search indexes and retain bookkeeping do not leak between vaults
- Verify: export and re-import round-trips without loss

## Out of Scope

- Encryption at rest (see private-by-architecture)
- Automatic fact deduplication or merging
- Memory backend migration (Hindsight stays cold-archived)
