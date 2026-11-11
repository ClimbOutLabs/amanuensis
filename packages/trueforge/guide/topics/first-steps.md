---
id: first-steps
title: First steps
covers: settings:models, settings:personalization, route:firstRunGuide, route:model, route:modelProvider, route:personalization
---

1. Choose a model. Open Settings, then Models. Pick a model you have access to. Aman cannot answer until a model is chosen.
2. Tell Aman your name. Open Settings, then Personalization. Add your name and, if you like, a name for the assistant.
3. Connect your email and calendar. Only if you want Aman to read them. See "Connecting your email and calendar".
4. Try a card. On an empty chat, tap a card such as "Your morning brief". Aman starts a chat with that message.

You can change any of these later in Settings.

## Adding a model provider

When you add a provider in Settings, then Models, or change one and save it, Aman runs one small test call to that provider before the save finishes. The provider card then shows one line under its name, starting "Last check". The line is one of these:

- "The model server answered the test call." The provider is set up and ready to use.
- "The model server refused the API key. Check the key for this provider and save again." The server answered, but it would not accept the key saved for this provider.
- "The model server did not answer. Check the server is running and the address is right, then save again." Nothing answered at the provider's address.
- "The model server took too long to answer. It may still be starting up, or busy loading the model. Wait a moment, then save again." The server did not answer within the time allowed. A model on your own computer can need a while to load the first time.
- "The model server answered with an error. Check the provider settings and save again." The server answered, but the test call failed for another reason.

The save goes through either way. A line that names a problem means chats using this provider will hit the same problem until it is fixed.

## Signing out

Click **More** in the left bar, then click **Sign out**. Aman asks first. Click **Sign out** again to leave, or **Stay** to keep working. Your chats and settings stay on the computer, and they are there when you sign in again.
