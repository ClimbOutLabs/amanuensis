# Spec: The model knows when each message was sent

**Status:** draft

## Problem

Each request tells the model today's date. That line is added for one reply and is not saved with the chat. Earlier messages are saved without a date. When a person comes back to a chat days later, the model sees today's date and a list of undated messages, so it treats the earlier messages as if they were just sent. "I fly tomorrow", said ten days ago, is read as tomorrow.

## Solution

When a person's message is saved to the chat, the time it was sent is saved on the message itself, in a new optional field `sent_at`.

When a request is built, each saved message that has a send time gets a short host note just before it with the date it was sent: the UTC date and weekday, and the person's local date when their time zone is known. The note is marked as written by the host, so the model does not read it as the person's words. The note is written from the saved time, so it reads the same on every later request and the earlier part of a request stays the same from one reply to the next. Today's date is still sent with each reply as before.

The note is only in the request. It is not saved in the chat, so the checks that look at what a chat has read from other people see the same chat as before.

Every message a person sends in a main chat gets a send time. A helper agent that is handed a task by the main chat gets none, because that task is not a message from the person.

Messages saved before this change have no send time and are sent as they are. An export from an older version has none either and imports unchanged, so no upgrade step is needed; a newer export keeps the send times.

## Privacy

No new data leaves the device or goes anywhere new. The time a message was sent is saved in the chat, on the message, and is included in an export of that chat. The date is sent to the model the person already chose. The person's time zone is already sent with each reply.

## Testing

Unit tests with made-up chats and a stand-in model, never a person's real data:

- a reply on a later day is sent the earlier message with the day it was sent, and the new message with the new day;
- the earlier part of the later request is the same as what was sent before;
- the saved chat holds the send time on the message and no extra note;
- a message with no send time is sent as it is;
- an import keeps a send time, and takes a message from an older export that has none.

## Out of scope

- Adding dates to messages saved before this change.
- The time of day in the note.
- Dates inside the summary that replaces the older part of a long chat.
