---
id: text-messages
title: Text messages from Aman
covers: route:text
---

Aman can send you a text message when something needs you and you are away from the app. Texts are off until the person who runs Aman sets them up and you turn them on. A new install texts no one.

## What a text says

- **Private (recommended)** is the default. A text says only your assistant's name and the kind of thing, such as "a reminder is due". It never holds names, amounts or what a message said.
- **Full** carries a short plain sentence about the item. A locked screen can show it, and the phone company can read it. If that sentence holds a link, a website, a phone number or an email address, Aman sends the Private words instead.

The text with your confirmation code holds only the code.

## Turn texts on

1. Click **Settings**, then click **Reach me**.
2. Type your number with the country code, such as +15550100, and click **Send code**.
3. Type the code from the text and click **Confirm**.
4. Choose **Private (recommended)** or **Full**.
5. Switch on **Send me texts**, then click **Save**.
6. Click **Try it** to get a test text.

To use a new number, click **Change number** and confirm the new one. Texts keep going to your old number until you do. Click **Remove number** to stop texts and forget the number.

## Stop texts

Reply STOP to any text. Aman turns texts off and says so in Activity. Any other reply is ignored. To get texts again, reply START from that phone, then confirm your number again in Reach me.

## Limits

Texts cost money, so Aman limits them:

- At most 30 texts a day for each person. After that, new items wait under the bell, and the item says when texts start again.
- At most 3 test texts an hour from Try it.
- At most 3 codes an hour for each person.

## If texts are not set up

Reach me says texts are not set up on this server. Only the person who runs Aman can set them up. They need a Twilio account, a Twilio phone number, and an https address Twilio can reach. The steps are on the Text messages page of the Aman docs. After they change those settings, they start Aman again. Aman then tells Twilio where to send your replies, so nothing needs to be set in the Twilio console.
