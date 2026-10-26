---
id: connect-mail-calendar
title: Connecting your email and calendar
covers:
---

You connect email and calendar in one place, in Settings. You do not need the terminal.

You need a Google account. Aman uses a Google app that you make once in your own Google account. This takes about ten minutes.

If Aman is in offline mode, turn it off first. Click **More**, click **Settings**, click **Permissions**, and turn off **Offline mode**.

## Connect your email

1. Click **More** in the left bar, click **Settings**, then click **Connectors**.
2. Find **Google** in the list and click **Connect**.
3. A panel opens with a list of steps. Do them in order. Each step has a link you can copy.
4. Make a Google Cloud project. Use one you already have if you like.
5. Turn on the Gmail API. On Google's page, click Enable.
6. Set up the consent screen. Choose External, then type an app name and your email address.
7. Add yourself as a test user. On the Audience page, under Test users, click Add users. Add the Gmail address you will connect.
8. Make the client. Choose the app type the panel names. Click Create, then click Download JSON.
9. Back in Aman, type the **Client ID** and **Client secret**. Or drop the file you downloaded into the panel.
10. Click **Check my client**. Fix anything it lists.
11. To let Aman save drafts and send email, tick the box about drafts and sending. Every draft and every send still asks you first.
12. Click **Connect Google**. A Google window opens. If nothing opens, allow pop-ups for this site.
13. Google says it has not checked the app. This is because you made it. Click Advanced, then click the link to your app, then click Continue.
14. If your browser ends on a page that says "This site can't be reached", copy the whole address from the address bar. Paste it into the panel and click **Finish connecting**.

The panel then says it is connected and shows your Google address.

## Connect your calendar

1. Click **More**, click **Settings**, click **Connectors**, find **Google**, and click **Manage**.
2. Open the Calendar API link in the Calendar section. On Google's page, click Enable.
3. Click **Connect Calendar**. On Google's screen, leave the calendar box ticked and continue.
4. To let Aman add events, click the button that starts with "Allow" and ends with "to add events". It shows Aman's name in the middle. You still approve each event first. Aman cannot delete events.

## Later

- Click **Allow drafts and sending** if you skipped drafts at the start.
- Click **Test connection** to check that it still works.
- If Google signs you out, click **Reconnect**. A Google project in Testing mode signs you out every 7 days. To stop this, open Audience in Google Cloud and click Publish app. Then reconnect once.
- Click **Disconnect**, then **Disconnect Google**, to turn off both email and calendar.
