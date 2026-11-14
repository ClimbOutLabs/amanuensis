---
id: live-browser
title: Aman's browser
covers:
---

Aman has a web browser of its own, separate from yours. It can open a site, read it and click through it for you. When a page needs something only you can do, such as signing in, you do that step yourself in the live browser while Aman waits.

How to get there: while Aman has a page open in a chat, **Watch Live or Take Control** shows in the panel on the right with a blinking green dot. Click it to open the live browser on that chat's page, beside your chat. Aman also gives you a link to the live browser in the chat when it needs you. It is your Aman address followed by `/browser-live`. For example, if you open Aman at `https://my-computer:8443`, the live browser is at `https://my-computer:8443/browser-live`.

## What Aman can do on a page

Ask Aman to look something up on a site, or to open a page, and it reads the page for you. It can scroll, go back, click links and buttons, type into fields and pick from lists.

The browser keeps one profile for you, so sites stay signed in between chats. Each chat gets its own tab. Installing or upgrading Aman turns the browser on, so there is nothing to set up.

If a page has closed, for example after a restart, Aman opens it again by itself. You stay signed in.

## What Aman will not do

- Aman follows a plain link to another page without asking. It only opens that page.
- Before anything else that could send something, Aman shows you a card and waits for your OK. That covers clicking a button, a tab or a menu, typing into a field and picking from a list. A page can send what you type the moment it changes, so the card shows the exact text first.
- Aman never presses Enter or Tab when it types, and it acts only on the exact thing it checked. If the page changed in between, it reads the page again instead.
- Aman never types into a password, card or one-time-code field. You do those yourself in the live browser.
- Aman doesn't open an address with a sign-in name or password in front of the site, such as `https://name@site.example`, because the site would receive it. Ask again with the address without that part.

## Screenshots

When Aman takes a screenshot of a page, it shows up in the chat for you.

If your model can read pictures, Aman looks at a copy too, with each button and field labeled. That copy goes to your model provider, just like the page text. Password, card and one-time-code fields are covered in it, and so is anything a page shows from another site, such as a card payment form.

## Do a step yourself

Some steps only you can do: signing in, typing a code sent to your phone, a picture check, or a cookie banner Aman cannot clear.

1. Open the live browser link Aman gives you in the chat.
2. At the top, click the tab you want. Each button is one of Aman's open pages. If a page is missing, click **Refresh tabs**.
3. Use the picture of the page just like the page itself: click it, scroll over it and type. The green dot at the top blinks while the picture is live.
4. To type a code or a longer text, put it in the box under the picture and click **Type it**.
5. To paste, click the picture, then press Ctrl+V (Cmd+V on a Mac). You can also click **Paste into page**.
6. To copy, select text in the page, then press Ctrl+C (Cmd+C on a Mac) or click **Copy from page**. Ctrl+A (Cmd+A) selects everything in the field you clicked. Passwords can't be copied out of the page.
7. To upload a file, click **Upload a file** and pick it, then click the page's own upload or send button. Files up to 10 MB work.
8. When you are finished, click **Done**.
9. Go back to the chat and tell Aman you are done.

Aman carries on from where you left the page. A sign-in you finished stays signed in.

## End the session yourself

To stop Aman using a page, click **End session** at the top, then click it again to confirm. The page closes in Aman's browser. Aman has to open a page again before it can go on in that chat. A sign-in you finished stays signed in.

## Sign in with your password manager

Your password manager can't fill the picture of the page, because the picture has no real boxes. Use the name and password boxes under the picture instead.

1. Under the picture, click **Sign in with your password manager** to open the boxes.
2. In the picture, click the site's name or email box.
3. In **Name or email**, fill your name from your password manager, then click **Put name in page**.
4. In the picture, click the site's password box.
5. In **Password**, fill your password from your password manager, then click **Put password in page**.

Your password manager won't suggest a login in these boxes by itself, because it sees Aman's address, not the site's. Pick the site's login yourself. In Chrome, right-click the box and choose Passwords. In LastPass, click its icon in the box and search for the site. Never pick your Aman login here.

What you put in these boxes goes only into the page. It is not saved, not written to any log, and never shown to Aman. Each box empties once you use it.

## When a human check won't let you through

Some human checks refuse the live browser's ordinary clicks. An ordinary click arrives all at once, with no hand behind it. Take over the page instead, so the page follows your own hand.

1. Click **Take over** above the picture.
2. Move and press on the picture to use the page, just as your hand does. Your pointer moves, presses and lets go exactly as you do.
3. When you are finished, click **Hand back**.

While you hold the tab, Aman sends nothing to it. It starts again once you hand the tab back.

While you hold the tab, a line above the picture tells you when the site is asking for a human check. The live browser spots many checks, but not all of them. No line doesn't always mean there is no check.

If you leave the live browser without clicking **Hand back**, the tab is handed back for you. Aman is never left waiting on a tab nobody is driving.

## Good to know

- Only you see your own tabs, and only while you are signed in to Aman. If Aman asks you to sign in first, you come back to the live browser afterwards.
- The live browser keeps the same rules as Aman's own clicks. A page cannot leave the site it was opened on.
- If the live browser says Aman has no page open, ask Aman to open the page first.
- The live browser only asks for new pictures of the page while you are looking at it.
- The browser is off in an incognito chat, because it keeps history and sign-ins between chats.
- Aman's browser is not your own browser. It has its own sign-ins, kept on your computer.
- For how the browser is walled off and how it is set up, see [Browser setup](../../../../docs/browser.md).

## Related

- [Search the web](web.md)
- [Approval cards](approvals.md)
- [Your privacy](privacy.md)
