# Spec: Memory Vault

## Problem
Aman already persists memories as Markdown files, but there is no way to inspect, correct, or manage them. Stale or wrong facts linger silently. Memories are global, with no per-persona views. Export and import do not exist, so the user cannot back up or move their memory.

## Solution
A Memory Vault UI and API layer on top of the existing Markdown memory backend. Per-persona views, fact-level view/edit/delete, selective sharing across personas, and export/import.

## Design Decisions

**Build on Markdown memory, not a new backend.** The Markdown files are the source of truth. The vault is a management layer: parsing facts from the files, presenting them, and writing edits back.

**Facts are the unit of management.** A fact is a single atomic claim extracted from the memory files (e.g. "Sidd prefers oat milk"). The vault lists facts with their source file and timestamp.

**Per-persona views.** Each persona gets a filtered view of the vault showing only facts visible to that persona. A global view shows everything.

**Selective sharing.** Facts can be tagged as shared across specific personas or kept private to one. Sharing is explicit: a fact is private to its persona unless the user shares it.

## Scope
- Fact list per persona with source attribution (which file, when recorded)
- Edit a fact (rewrites the underlying Markdown)
- Delete a fact
- Share a fact with another persona
- Export vault to JSON/Markdown archive
- Import from a previously exported archive
- Search across facts

## Privacy
- Vault contents never leave the device except via explicit user-initiated export
- Encrypted per-persona vaults are a separate feature (see private-by-architecture spec)

## Testing
- Synthetic facts only, never Sidd's real memories
- Verify: create fact in chat, see it in vault, edit it, confirm the edit is reflected in a new chat
- Verify: delete a fact, confirm the persona no longer recalls it
- Verify: share a fact between two personas, confirm isolation of unshared facts
- Verify: export and re-import round-trips without loss

## Out of Scope
- Encryption at rest (see private-by-architecture)
- Automatic fact deduplication or merging
- Memory backend migration (Hindsight stays cold-archived)
