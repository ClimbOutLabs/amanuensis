---
id: telegram
title: Using Aman from Telegram
covers: route:telegram
---

You can talk to Aman from Telegram. You make a small bot of your own, connect it once in Settings, and pair it with you. After that, messages you send the bot are answered in a chat called Telegram, and replies, reminders and things that need your ok are sent back to Telegram.

## Connect your bot

1. Open Telegram and message @BotFather.
2. Send /newbot and follow his steps. He gives you a token.
3. In Aman, click **More** in the left bar, click **Settings**, then click **Connectors**.
4. Find **Telegram** and click **Connect**.
5. Paste the token and click **Connect**. Aman checks the token with Telegram before it saves anything.

## Pair it with you

The bot answers only you. Pairing is how it learns who you are.

1. Message your bot and send /start.
2. The bot answers with a six-digit code. The same code shows in Settings, under **Telegram**.
3. Open the Telegram panel in Settings and check the two codes match.
4. Type the code and click **Pair**.

If the codes do not match, do not pair. Someone else may have messaged your bot first. Wait 15 minutes for the code to expire, then send /start yourself.

## Using it

Send the bot a message and it is answered in the Telegram chat, with the same memory and the same care as a chat here. Anything a chat would show you as a card first is asked as a message with **Approve** and **Deny** buttons, and nothing runs until you tap one.

Reminders and brief summaries are sent to Telegram as well. The whole brief always stays in the app, in its chat.

The bot does not answer anyone else, and it does not work in group chats. Forwarded messages and files are treated as things to read, never as instructions to follow.

To turn it off, open **Settings**, **Connectors**, **Telegram**, click **Manage**, then click **Disconnect**. The saved token is deleted for good.
