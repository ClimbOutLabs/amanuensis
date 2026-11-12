---
id: approvals
title: Approval cards and permissions
covers: settings:permissions, approval:plain, approval:email, route:permission, route:sentinelSettings
---

Aman shows an approval card before it does something that matters. Nothing happens until you answer.

Reading is free. Aman does not ask before it reads. It asks before it sends, saves or changes something.

## The buttons on a card

- **Allow** lets this one thing happen.
- **Always allow in this chat** stops the questions for this kind of action to the same place in this chat. Only a card that names who or where the action goes shows it. On a change to your own calendar that has no guests, it covers every later one in this chat. A calendar card shows no other lasting answer, so Aman asks again in a new chat. Saving a mail draft asks every time. So does creating a schedule or a persona.
- **Always allow this site** stops the questions for pages on one site in this chat. Only cards that open a page show it.
- **Always allow everywhere** lets Aman use one tool of a connector without asking, in every chat. Only some cards show it. You confirm once. Aman still asks when a call would send something that looks like a password, a key or a card number, or a lot of text.
- **Change it** asks Aman to change the request first. Nothing runs now.
- **Not now** does not run it.

## Mail cards

A mail card shows who it goes to and the full text. Click **Allow** to send it. Click **Save as draft** to keep it without sending. Click **Edit** to ask Aman to change it first. Click **Not now** to stop it.

If the mail goes to an address that is not on your Email list, the buttons are **Add and send** and **Don't send**. **Add and send** puts those addresses on your list, then sends. Sending always asks. No button on a send card lets you skip the question.

## Cards that open a page

A card that opens a page names the site it will open. The full address is on the card, behind **Details**.

If a page Aman read named the address, the card says which page Aman read the address on. That card has no **Always allow this site**. An address that came from something Aman read always asks, even on a site you have allowed.

If you did not give the address, the card can offer **Always allow this site**. That covers every page on that site for the rest of this chat. A site means the exact name in the address. A page on a longer name, such as shop.example.com when you allowed example.com, asks again. A new chat asks again too.

Each page on an allowed site is still checked on its own. If a later page would carry one of your private details, its link adds details to a site only Aman brought up in a reply, or a page Aman read named its address, that page asks. Those cards have no **Always allow this site**.

If you click **Not now** on one of these cards, that no lasts for the rest of the chat. Aman does not ask again about the same kind of open on that site. It refuses the open instead. A no on a card for a click on a page lasts the same way. A new chat asks again.

## Choose what Aman may do without asking

1. Click **More** in the left bar, click **Settings**, then click **Permissions**.
2. Under **Always allow everywhere**, turn on **Write files** if you want Aman to write files without asking.
3. Turn on **Web searches**, the **Maps** switch or the **Sandbox** switch to stop those questions. Each one has its own switch. With the **Maps** switch off, a scheduled run skips its maps. The **Sandbox** switch covers new files and scripts Aman wrote in the same chat, and only where the sandbox has no network. Where you allowed package downloads, or a skill may reach its own sites, they still ask. Installing a package still asks.
4. Sending email is not on this page. It always asks.

To take back an always allowed tool, click **More**, then **Settings**, then **Connectors**. Open the connector and stop allowing the tool.

Some cards say "Part of this is not shown in full. Check it before you approve." Open the card to read all of it.

In voice mode, Aman reads an email, calendar or schedule card out loud and waits for you to say exactly "yes, send it", "yes, approve" or "yes, delete it", or "no". Say the whole phrase in one go; anything else leaves the card waiting. Aman reads only cards it can say in full: a plain email, a new calendar event with no guests, or deleting a scheduled task. Cards with web links, code, words that are not plain English letters, shell commands, payments, new addresses and similar are always left on the screen, and so is a card Aman could not read all the way through.

## See what Aman did

1. Click **More** in the left bar, click **Settings**, then click **Audit**.
2. The list shows every action Aman took or asked about, newest first, with what you decided.
3. To narrow it, pick what to **Show**, or pick a **From** and **To** day. Days follow your own clock, and both days are included.
4. Click **Clear dates** to see everything again.
