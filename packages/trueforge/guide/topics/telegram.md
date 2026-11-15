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
5. Paste the token and click **Connect**. Aman checks the token with Telegram before it saves anything. To leave without connecting, press ++esc++. The Telegram window closes and you stay in Settings.

## Pair it with you

The bot answers only you. Pairing is how it learns who you are.

1. Message your bot and send /start.
2. The bot answers with a six-digit code. The code is shown only in Telegram, never in Aman.
3. Open the Telegram panel in Settings. It shows the name of the person waiting to pair.
4. Check that name is yours. Type the code from Telegram and click **Pair**.

If the name is not yours, do not pair. Someone else messaged your bot first. Click **Cancel pairing**, then send /start yourself.

## Using it

Send the bot a message and it is answered in the Telegram chat, with the same memory and the same care as a chat here. The Telegram chat is listed with your other chats, and you can open it in Aman to change the model or the connectors it uses, as in any chat; the bot answers with them from your next message. With **Learn from conversations** on, Aman also learns about you from what you send the bot. Anything a chat would show you as a card first is asked as a message with **Approve** and **Deny** buttons, and nothing runs until you tap one. On a card for email addresses you have not sent to before, the first button says **Add and send** instead, or **Add and save draft** when the card saves a draft and sends nothing, because approving adds those addresses to your send list. The message shows everything the card in the app shows: the whole email, the whole request, the exact command, and for a new skill where it comes from, its exact version and its instructions. An email shows the account it is sent from, and **Approve** sends it from that account. When you have more than one email account, the message says so. To send from a different account, answer in the app. When Telegram cannot show an action in full, for example a skill whose instructions are too long, the message names the action and asks you to approve or deny it in Aman. It has no buttons, and the action waits for you there. When Aman can be opened from your phone, the message also has a link to the chat.

## Change what the chat uses

Tap the menu button beside the text box in Telegram to see the bot's commands, or send one yourself:

- /new starts a fresh chat. The earlier one stays in Aman.
- /model shows your models as buttons. The one in use is ticked. Tap another to switch.
- /persona shows your personas as buttons. Tap one and it answers from your next message. You can also ask for a persona by name in a message, as in the app.
- /connectors shows the connectors you have set up. Tap one to turn it on or off for this chat. To connect a new one, open Aman.
- /status shows the model, the persona and the connectors this chat uses.
- /help lists these commands.

These change only the Telegram chat, the same settings you see when you open that chat in Aman.

If you delete the Telegram chat in Aman, your next message to the bot starts a new chat, and the bot tells you so first. The new chat does not see what was said in the deleted one. What Aman learned about you from it stays in memory, as it does for any chat you delete.

Reminders and other notices that would show on your devices are sent to Telegram as well. When Aman tries to call you and the phone does not ring, the message comes to Telegram instead. Quiet notes stay under the bell in the app. So when your morning brief is ready, Telegram gets no message: read the brief in its chat in the app.

The bot does not answer anyone else, and it does not work in group chats. Forwarded messages and files are treated as things to read, never as instructions to follow.

To turn it off, open **Settings**, **Connectors**, **Telegram**, click **Manage**, then click **Disconnect**. The saved token is deleted from Aman. One step is left: the token itself still works until you revoke it. Open Telegram, message @BotFather, send /revoke, and pick your bot, so the old token stops working for good.
