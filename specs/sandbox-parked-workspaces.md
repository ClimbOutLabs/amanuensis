# Sandbox parked workspaces

Status: draft

## Problem

On a slots install, each chat's sandbox workspace is a folder on one slot's
fixed-size disk, and it stays there until the chat is deleted. A slot holds
only as many chats as its disk divided by each chat's size limit, so a person
who keeps their chats (a chat is the person's searchable memory) eventually
fills every slot. When that happens the sandbox reports itself unavailable
to the whole app, including chats that already hold a workspace, even though
the disks are nearly empty in real bytes. The count of chats, not the space
they use, is what runs out.

## The change

A chat's workspace stops living on a slot's fixed disk. Workspaces move to a
store on the machine's main storage, one store per slot, in the same folder
layout as today. The slot agent creates a workspace when the server asks,
checks it before use, and reports what it holds. Creating a workspace then
depends only on the machine having room, never on how many chats already
exist. A living chat's workspace is never removed to make room for another
chat; a workspace leaves only when its chat is deleted.

The work lands in stages, each its own pull request against this spec:

1. The slot agent reports its sessions: a sessions listing (session id,
   bytes, entry count, last used) and a health fact for the free space on
   the filesystem the workspaces are on. The server contract and client
   learn the new answers. Nothing reads them yet.
2. Later stages make the holders visible in Settings and the doctor, move
   workspace creation to a question the agent answers from real free
   space, move the trees into the store, and retire the fixed seat count.

## Key design decisions

- The per-chat size limit stays enforced exactly as today, by the agent
  while a call runs and by tidying after it, with a free-space floor before
  any call starts. No bound gets weaker.
- The app never touches workspace files. Only the slot agent reads or
  writes them, and the store is never mounted into the app.
- Sessions stay pinned to their slot, so session ids, stored chat records
  and cross-slot isolation do not change.
- A session listing is served from a cached walk, refreshed at most every
  30 seconds, so asking never walks every tree and never waits behind a
  running call.
- The agent version and the server's pin for it move together whenever the
  agent's answers change shape.

## Privacy

A session listing carries session ids, sizes, entry counts and last-used
times, and travels only over the slot's Unix socket between the app and the
agent on the same machine, like every other slot answer. It names no chats
and carries no file names or contents. The free-space fact is a number
about the machine's disk. Nothing leaves the device.

## Testing

Tests use synthetic data only: agent tests build throwaway session trees in
temporary folders and read the listing back; contract and client tests run
against a fake agent on a local socket. Stage 1 is proved by the agent's Go
tests and the core contract and client tests, with a live health read on a
running slot as a manual check at the gate.

## Out of scope for stage 1

Any change to capacity, creation, deletion, the idle sweep, Settings, the
doctor or the capabilities answers. Those arrive in later stages against
this same spec.
