---
title: "Aman's browser"
description: "Aman's own web browser, and the live browser for steps only you can do."
---

Aman has a web browser of its own, separate from yours. It runs next to Aman on your computer, in its own walled-off box, and keeps one browser profile for you, so sites stay signed in between chats. Each chat gets its own tab. Installing or upgrading Aman turns it on; there is nothing to set up. The browser is off in an [incognito chat](/privacy#incognito-chats), because its profile keeps history and sign-ins between chats.

Ask Aman to look something up on a site, or to open a page, and it reads the page for you. It can scroll, go back, click links and buttons, type into fields and pick from dropdowns. Before a click that would send something, such as a form, a payment or a delete, Aman shows you a card and waits for your yes. Aman never types into a password, card or one-time-code field. Aman's browser also does not open an address that has a sign-in name or password in front of the site, such as `https://name@site.example`, because the site would receive it. Ask for the address without that part. A screenshot Aman takes shows up in the chat for you. If your model can read images, Aman looks at it too, with each button and field labelled, so it can find things the page text does not describe well. That picture goes to your model provider, like the page text. Password, card and one-time-code fields are covered in it, and so is anything a page embeds from elsewhere, such as a hosted card form. If Aman's page has closed, for example after a restart, Aman opens it again by itself; you stay signed in.

## Doing a step yourself: the live browser

Some steps only you can do: signing in, typing a code sent to your phone, a picture check, or a cookie banner Aman cannot clear. For those, open Aman's live browser:

1. Go to `/browser-live` on the address you use for Aman. For example, if Aman is at `https://aman.local`, open `https://aman.local/browser-live`. Aman gives you this link when a page needs you.
2. Pick the tab. Each button is one of Aman's open pages.
3. Use the picture of the page like the page itself. Click it, scroll over it, and type. To type a code or longer text, put it in the box under the picture and press **Type it**. To upload a file, pick it under **Upload a file into the page**, then press the page's own upload or send button.
4. Press **Done**, then go back to the chat and tell Aman you are finished. Aman carries on from where you left the page, and a sign-in you finished stays signed in.

Some human checks still refuse the live browser's ordinary clicks, because an ordinary click arrives all at once, with no hand behind it. For those, press **Take over** above the picture. While takeover is on, the picture follows your own hand: your pointer moves across the page, presses and lets go exactly as you do them, and Aman sends nothing to that tab until you press **Hand back**. The tab stays in Aman's browser the whole time, so a check you pass or a step you finish is still there when Aman carries on. The live browser spots many human checks, and says so while you hold the tab, rather than leaving you clicking at a check that keeps coming back. It cannot spot every check there is, so no message does not always mean there is no check.

Only you see your own tabs, and only while you are signed in to Aman. If Aman asks you to sign in first, you come back to the live browser afterwards. The live browser keeps the same rules as Aman's own clicks: the page cannot leave the site it was opened on. If the page says Aman has no page open, ask Aman to open the page first. The live browser only asks for new pictures while you are looking at it.
