# Spec: Local model as a first-class path

**Status:** draft

## Problem

The README leads with Together AI and mentions local models in one closing line. The only Ollama steps live in the developer quickstart, use a tiny model that cannot call Aman's tools well, and leave Ollama at its default context window. That default is smaller than Aman's own system prompt and tool definitions (about 9,000 to 11,000 tokens on every turn), so Ollama silently cuts them and Aman answers badly. The installed app also runs inside Docker, where `localhost` is the container, and on Linux Ollama's default address cannot be reached from a container at all. A person who wants a private, free setup has no path they can follow end to end.

## Solution

Present a local model beside the hosted one, as an equal choice:

- README: the requirements name both choices, and step 1 after the install offers "Hosted: Together AI" and "Local: Qwen3 8B with Ollama" side by side, with the exact settings and a short note on speed and limits.
- A new guide, `docs/local-model.mdx`: what you need, the exact settings, the extra Linux settings, speed per kind of computer, what works less well on a small model, what stays on the computer, and what to do when it does not answer.
- The quickstart, install, models, privacy and first-steps pages point to the guide and use the same model and settings.

## Design decisions

**One provider: Ollama.** Aman's model code already handles Ollama serving Qwen3 over its OpenAI-compatible endpoint, including the `reasoning` field Ollama uses for thinking and the empty-answer case that thinking can produce. It is also the simplest install on a Mac, a Windows PC and Linux.

**One model: Qwen3 8B (`qwen3:8b`).** It calls tools, it thinks before answering, and with a 32K context it needs about 10 GB of memory, which fits a 16 GB Mac. Bigger machines can add bigger models the same way.

**Context length 32K, max output 8K.** Aman's setup takes about 10K tokens of every request. 32K leaves room for the chat and an 8K reply. The guide says to set the same number in Ollama and in Aman.

**Say plainly what is weaker.** Long multi-step jobs, pictures, long chats, background work queuing behind replies, and voice all feel the difference. A computer without a graphics card is called out as not recommended, because the first reply misses Aman's 90-second first-reply wait.

**No new code or defaults.** The custom provider form already has every field this needs. No catalog entry is added, because a local server's address and model differ per computer.

## Privacy

With a local model, chats, memory and what Aman reads go only to Ollama on the same computer. Web search, maps and connectors still reach their own services, as `docs/privacy.md` lists. The Linux setting that lets containers reach Ollama also lets other devices on the network reach it; the guide says so and says how to block it.

## Testing

Synthetic data only, on a fresh standalone instance with Ollama serving Qwen3 8B:

- The provider is added through Settings, Models, Add custom provider with exactly the values in the README.
- A first chat reaches a reply; a second message makes a tool call (a reminder) and answers with its result.
- From a container on a separate Docker network with `host.docker.internal:host-gateway`, Ollama on the Linux host is reachable when it listens on `0.0.0.0` and not when it listens on `127.0.0.1`.
- Release check: a fresh install on a Mac with Ollama reaches the first reply following only the README.

## Out of scope

- Raising or changing the first-reply wait for slow computers.
- A built-in Ollama entry in the provider catalog.
- llama.cpp, LM Studio and vLLM guides.
