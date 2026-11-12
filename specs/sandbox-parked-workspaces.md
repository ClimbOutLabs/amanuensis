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
2. The holders become visible. A read-only settings route asks every slot
   for its sessions and joins each one to the chat whose last turn used
   it, answering per workspace the chat and its title, the slot, the size,
   the entry count and the last use, plus one summary per slot with its
   free room. The Settings sandbox page gains a read-only "Chat
   workspaces" card with the same list, and the doctor gains one line per
   slot: how many workspaces it holds and how much room is left. A
   workspace no chat holds is listed honestly, with no chat attached.
   Nothing is created, moved or removed.
3. Workspace creation becomes a question the agent answers. The server
   no longer counts how many chats would fit on a slot's disk; it asks
   the slot agent to create the workspace, and the agent answers from
   the real free space on its storage, refusing only when the new
   workspace's size limit plus the free-space reserve does not fit. The
   refusal reaches the person as one plain sentence: the storage is
   almost full, free some disk space, then try again. A slot whose
   storage is full never blocks a chat another slot has room for, and
   whether the sandbox reports ready no longer depends on how many
   chats exist, so chats that already hold a workspace keep working
   whatever happens to new ones.
4. Later stages move the trees into the store.

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
- Creation asks the agent that will hold the tree, because only the agent
  sees its storage's real free space; the server counts nothing. Creating
  a workspace that already exists is a success, so a retried request is
  never refused for room the workspace already holds.
- The agent version and the server's pin for it move together whenever the
  agent's answers change shape.

## Privacy

A session listing carries session ids, sizes, entry counts and last-used
times, and travels only over the slot's Unix socket between the app and the
agent on the same machine, like every other slot answer. It names no chats
and carries no file names or contents. The free-space fact is a number
about the machine's disk. Nothing leaves the device.

From stage 2, the server joins that listing to chat titles to show who
holds each workspace. The join happens on the server, and the joined list
is served only on the instance's own admin settings surface, to the
signed-in owner of the same instance. Another person's chat is shown only
as theirs, without its title, and an incognito (private) chat is shown to
its owner as "Incognito chat", without its title, so the card never
becomes a list of incognito chats. No title or workspace detail leaves the device.

## Testing

Tests use synthetic data only: agent tests build throwaway session trees in
temporary folders and read the listing back; contract and client tests run
against a fake agent on a local socket. Stage 1 is proved by the agent's Go
tests and the core contract and client tests, with a live health read on a
running slot as a manual check at the gate.

Stage 2 is proved by server tests with a stubbed slot listing and a fake
session store (sessions joined to the right chat titles, a session with no
matching chat shown with no chat attached, several slots, and the empty
case), by doctor tests for the new per-slot line, and by Settings page
tests for the card: the holders list, an untitled chat, an incognito chat, the orphan, the
empty state, and the card staying hidden on the Docker backend.

Stage 3 is proved by provider tests against fake slot agents (slots
holding more chats than the old per-disk count still create, a full slot
passes the chat to a slot with room, every slot full refuses with the
plain sentence while the sandbox still reports ready, and creation waits
out a busy slot), by contract and client tests for the create call, and
by agent tests: a tree is created, creation is refused with no tree left
behind when the storage cannot fit the quota plus the reserve, an
existing tree needs no new room, and bad requests are refused. A live
check on an instance holding more chats than the old capacity is a
manual check at the gate.

## Out of scope so far

Any change to where the trees live, to deletion, or to the idle sweep.
Those arrive in later stages against this same spec.
