# Spec: Send the model less, and less often

**Status:** draft

## Problem

Every reply sends the model a system prompt, the tool list and the chat so far, once per step. Some of what is sent is not needed, some of it is sent in a way that stops the model service from reusing work it already did, and some model calls happen that add nothing. On a hosted model this costs money. On a local model it costs time before the reply starts.

## Solution

Each item is a small change of its own. None of them removes a tool or changes what a person can ask for.

1. **Shorter tool text.** Tool schemas leave out the largest-safe-integer bound that the schema library adds to every whole number, and tool descriptions do not repeat what another tool's description already says. The prompt budget baseline is not raised.
2. **Shorten long chats sooner.** A chat is shortened at 80% of the model's window or at a fixed size, whichever is smaller, so a model with a large window does not carry a very long chat on every step.
3. **Keep the start of the request the same.** Text the host adds for one reply (today's date, the person's name, recalled memories) goes after the chat so far, not in the middle of it, so the earlier part of the request is the same as last time. The recalled memories still reach the model on that reply and are still marked as written by the host, not by the person. The last step of a reply keeps its tool list and is told not to call tools.
4. **No second call for a year.** A message that only contains a year, or a word such as "currently", is no longer treated as a question about recent events.
5. **Count everything that is sent.** The size check before a request counts pictures and the text added for that reply.
6. **Keep a usable summary.** When the summary that shortens a chat is missing a part, the parts that are there are kept, and the missing part is marked, instead of throwing the whole summary away.
7. **Small helper calls on models that always think.** A short helper call gets enough room for a model that thinks before it answers, so the call is not spent on thinking alone.
8. **Topic guidance once.** Guidance that is already in the chat is not added a second time.
9. **Screenshots.** The pictures of a browser page are attached in a way that does not change the earlier part of the request on every step.
10. **No memory lookup for a greeting.** A greeting or a bare "ok" does not look up memories.

## Privacy

No new data is sent anywhere. Each item sends the same or less to the model the person already chose. Nothing new is stored.

## Testing

Unit tests with made-up chats and a stand-in model, never a person's real data:

- tool schemas keep real bounds and drop only the largest-safe-integer bound;
- the prompt budget test still passes without a higher baseline;
- the request for a second reply starts with the same messages as the request for the first, and the recalled memories are in the request for the reply they were recalled for;
- a message with only a year gets one model call;
- the size check counts a picture and the added text;
- a summary missing one part is kept with that part marked;
- reading the same guidance twice adds it once.

## Out of scope

- The helper calls made after a reply for memory and the learned profile.
- Removing tools from the default set.
