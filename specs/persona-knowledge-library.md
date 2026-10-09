# Spec: Persona Knowledge Library

## Problem

Personas have personalities but no expertise. A relocation-advisor persona should know the visa requirements PDF, the tax notes, and the budget sheet. Today it gives generic advice because it has no access to the user's documents.

## Solution

A Knowledge section per persona (Settings → Personas → pick a persona). The user uploads PDFs, docs, notes, and links. When a question touches the persona's library, the turn retrieves the relevant chunks and the persona answers from them, with source attribution.

## Design Decisions

**Retrieval-based, no fine-tuning.** Documents are chunked, embedded, and retrieved at query time. Works with the models already running, including local models on the Spark. No weight updates.

**Strict persona isolation.** One persona's library is never visible to another persona. Embeddings and chunks are namespaced per persona. This is a hard guarantee, not a filter.

**Source attribution.** Answers drawn from the library carry light attribution (e.g. "from your uploaded notes") so the user knows where the answer came from.

**Storage exists; retrieval and UI are the work.** The storage layer from earlier work is reused. This spec covers: chunking and embedding pipeline, per-persona retrieval, the Knowledge settings UI, and attribution rendering in chat.

## Scope

- Upload PDFs, text docs, notes, and links per persona
- Chunking and embedding pipeline (local embedding model)
- Per-persona retrieval at query time
- Source attribution in responses
- Knowledge section UI in persona settings
- Delete documents and re-index

## Privacy

- Library contents never leave the device
- Embeddings are stored locally alongside the documents
- Persona isolation is enforced at the storage layer

## Testing

- Synthetic documents only, never the user's real files
- Verify: upload a synthetic PDF, ask a question it answers, confirm the answer cites the document
- Verify: persona A cannot retrieve persona B's documents (adversarial test)
- Verify: deleting a document removes it from retrieval

## Out of Scope

- Fine-tuning on the library
- Shared libraries across personas
- Web crawling (links are fetched once at upload time, not continuously)
- OCR for scanned PDFs (future)
