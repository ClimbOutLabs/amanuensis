---
id: connect-mail-calendar
title: Connecting your email and calendar
covers: settings:connectors, calendar-preset:google, calendar-preset:fastmail, calendar-preset:yahoo, calendar-preset:gmx, calendar-preset:webde, calendar-preset:other, route:google, route:calendarAccount, route:connectorAccount
---

You connect email and calendar in one place, in Settings. You do not need the terminal.

Google email uses a Google app that you make once in your own Google account. This takes about ten minutes. Google Calendar can use that app, or the simpler Calendar card with an app password. A calendar from another provider, such as Fastmail, also connects with an app password. See "Connect a calendar with an app password" below.

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

## Let Aman watch your mail

Aman can watch your mail for you. It can tell you about bills that are due soon, and about mail from people you mark always important. This is off until you turn it on, in **Settings**, then **Reach me**.

The Google panel and the Email panel both say this. Click **Open Reach me** in the panel to go straight there. Then turn on the switch called "Let Aman watch for things".

## Connect your calendar

1. Click **More**, click **Settings**, click **Connectors**, find **Google**, and click **Manage**.
2. Open the Calendar API link in the Calendar section. On Google's page, click Enable.
3. Click **Connect Calendar**. On Google's screen, leave the calendar box ticked and continue.
4. To let Aman add events, click the button that starts with "Allow" and ends with "to add events". It shows Aman's name in the middle. You still approve each event first. Aman cannot delete events.

## Connect Google Drive

1. Click **More**, click **Settings**, click **Connectors**, find **Google**, and click **Manage**.
2. Open the Drive API, Docs API and Sheets API links in the Drive section. On each Google page, click Enable. All three are needed: the Drive API lists files, the Docs API reads and writes Docs, and the Sheets API reads and adds to Sheets.
3. Click **Connect Google Drive**. On Google's screen, leave the Drive box ticked and continue.

Aman only sees files it created, or files you opened with Aman. It can read a Doc or a Sheet. Creating a Doc or adding rows to a Sheet asks you first, and the card shows the whole text or every row. Aman cannot delete a file, and it cannot change who a file is shared with.

## Connect a calendar with an app password

Use this for Google Calendar or a calendar from another provider. Google, Fastmail, Yahoo, GMX and web.de are on the list. Any other calendar that gives you an https calendar address works too.

An app password is a separate password for apps like this one. It is not your usual password. You make it at your calendar provider.

1. Click **More** in the left bar, click **Settings**, then click **Connectors**.
2. Find **Calendar** in the list and click **Connect**.
3. Pick your provider in **Calendar provider**. For a provider that is not on the list, pick Other.
4. If you picked Other, type the **Calendar address**. Your provider's help pages give it. It starts with https://.
5. Type your **Email address**. If you sign in to the calendar with a different name, type that name in the login box.
6. Make an app password at your provider. The panel shows a short note for your provider. For some providers it also shows a link, **How to make an app password**.
7. Type it in **App password**, then click **Connect**.

The app signs in to your calendar once before it saves anything. If the sign-in fails, nothing is saved, and the panel says what to fix.

To change the calendar, click **Manage**, then click the button that starts with "Change". To turn it off, click **Manage**, then click **Remove**. This deletes the saved app password for good. If the card says the sign-in stopped working, or that the calendar is not working right now, click **Manage**. You can type the details again, click **Cancel**, or click **Remove**.

The app stores the app password only on your computer, in the calendar connector. Your assistant never sees it. Never paste the password into a chat. A chat cannot connect a calendar. Use Settings.

## Later

- Click **Allow drafts and sending** if you skipped drafts at the start.
- Click **Test connection** to check that it still works.
- If Google signs you out, click **Reconnect**. A Google project in Testing mode signs you out every 7 days. To stop this, open Audience in Google Cloud and click Publish app. Then reconnect once.
- Click **Disconnect**, then **Disconnect Google**, to turn off email, calendar and Google Drive.

## Connect Home Assistant

You can connect your Home Assistant, so Aman can see and control the devices you choose to share.

First, in Home Assistant, open your profile and make a long-lived access token (your profile, then Security). Then add the Model Context Protocol Server integration (in Home Assistant's settings, under Devices and services).

To connect it in Aman:

1. Click **More** in the left bar, click **Settings**, then click **Connectors**.
2. Find the home-assistant connector in the list and click **Connect**.
3. Type your Home Assistant address and paste the token, then click **Connect**.
4. Aman says how many tools and exposed entities it found, or the one thing to fix.
5. In Home Assistant, expose each entity Aman may see (its settings, then Voice assistants, then Expose). Only exposed entities are visible to Aman.

Reading the state of your home runs on its own. A change, such as turning off a lamp, asks you first, unless you allow that kind of device for good on the card. You can see what you allowed, and take it back, on the Home Assistant connector's page in Settings. Aman never controls locks, alarms or garage doors.

## Connect Notion

You can connect Notion, so Aman can search and read your pages and databases, and make new ones.

1. Click **More** in the left bar, click **Settings**, then click **Connectors**.
2. Find notion in the list and click **Add**.
3. Open the notion connector and click **Connect**.
4. A Notion window opens. Sign in and pick your workspace.

Signing in gives Aman the same access you have in Notion. Any page or database you can open, Aman can reach. Every Notion tool asks you first before it runs.

## Connect GitHub

You can connect GitHub, so Aman can work with your issues, pull requests, repository files and CI status.

First, make a token in GitHub. Open your GitHub settings, then Developer settings, then Personal access tokens, and make a fine-grained token. Give it only the repositories and permissions Aman needs.

To connect it in Aman:

1. Click **More** in the left bar, click **Settings**, then click **Connectors**.
2. Find github in the list and click **Connect**.
3. Paste the token, then click **Connect**.

Every GitHub tool asks you first before it runs.
