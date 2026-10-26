---
id: connect-mail-calendar
title: Connecting your email and calendar
covers:
---

You connect email and calendar in one place, in Settings. You do not need the terminal.

Google email and Google Calendar use a Google app that you make once in your own Google account. This takes about ten minutes. A calendar from another provider, such as Fastmail, connects with an app password instead. See "Connect a calendar with an app password" below.

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

## Connect a calendar with an app password

Use this for a calendar that is not Google Calendar. Fastmail, Yahoo, GMX and web.de are on the list. Any other calendar that supports CalDAV works too.

An app password is a separate password for apps like this one. It is not your usual password. You make it at your calendar provider.

1. Click **More** in the left bar, click **Settings**, then click **Connectors**.
2. Find **Calendar** in the list and click **Connect**.
3. Pick your provider in **Calendar provider**. For a provider that is not on the list, pick Other.
4. If you picked Other, type the **Calendar address**. Your provider's help pages give it. It starts with https://.
5. Type your **Email address**. If you sign in to the calendar with a different name, type that name in the login box.
6. Make an app password at your provider. The panel shows a short note for your provider. For some providers it also shows a link, **How to make an app password**.
7. Type it in **App password**, then click **Connect**.

The app signs in to your calendar once before it saves anything. If the sign-in fails, nothing is saved, and the panel says what to fix.

To change the calendar, click **Manage**. To turn it off, click **Manage**, then click **Remove**. This deletes the saved app password for good.

The app stores the app password only on your computer, in the calendar connector. Your assistant never sees it. Never paste the password into a chat. A chat cannot connect a calendar. Use Settings.

## Later

- Click **Allow drafts and sending** if you skipped drafts at the start.
- Click **Test connection** to check that it still works.
- If Google signs you out, click **Reconnect**. A Google project in Testing mode signs you out every 7 days. To stop this, open Audience in Google Cloud and click Publish app. Then reconnect once.
- Click **Disconnect**, then **Disconnect Google**, to turn off both email and calendar.
