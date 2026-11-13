---
id: agents
title: Agents
covers: route:agent, route:agentImport
---

An agent is a saved setup for one job: a model, instructions, and the connectors and skills it may use. Build it once, then try it whenever you like or have it run on a schedule, such as a weekly summary every Monday.

How to get there: Click **More** in the left bar, then **Build agent**.

=== "Computer"

    ![The Set up your agent panel beside a new chat, asking what it should do, with Add a connector and Add a skill](../../../../docs/screenshots/app/agents-build-desktop.png)

=== "Phone"

    ![The Set up your agent panel on a phone, asking what it should do, with Add a connector and Add a skill](../../../../docs/screenshots/app/agents-build-phone.png)

!!! note "Agent or persona?"

    An agent does a job you set up ahead of time, and it is what runs your [schedules](schedules.md). A [persona](personas.md) is a helper that chats with you in your everyday chats. If you want someone to talk to, make a persona instead.

## Build an agent

1. Click **More** in the left bar, then **Build agent**. A new chat opens with the **Set up your agent** panel beside it.
2. Under **What should it do?**, click **Edit Instructions** and write the job in your own words, such as "Every week, sum up my unpaid bills in a short list."
3. To let it use your apps, click **Add a connector**. To give it extra know-how, click **Add a skill**.
4. The model and run settings sit under **More settings**. The usual choices work for most agents. To pick another model, open **More settings** and click **Edit Model**.
5. Try it out in the chat until it does what you want.
6. Click **Save Agent**.
7. Type a **Name** and say **What it's for**. You need both. Spaces and capitals are fine.
8. Click **Save agent**.

## Use an agent

1. Click **More** in the left bar, then **Agents**.
2. Click **Try** on your agent's row. A chat opens with that agent.

To run it on a schedule, point at its row and click **Schedule**. See [Schedules](schedules.md).

When you make a schedule by asking in a chat, Aman saves an agent for it, named after the schedule. It shows up here, and you can change its tools, instructions or model. Deleting the schedule leaves the agent in place.

## Change, copy or delete an agent

Open **Agents**, then click the menu at the end of the agent's row:

- **Edit** opens the agent so you can change it. Click **Update Agent** to save.
- **Clone** makes a copy you can change without touching the original.
- **Manage Schedules** shows the schedules that use it.
- **Delete** removes it. Aman asks first.

## Good to know

- An agent follows the same approval rules as Aman. Sending, deleting and installing still wait for your OK.
- For every option an agent has, see [Create an agent](../../../../docs/create-agent/overview.mdx).

## Related

- [Personas](personas.md)
- [Schedules](schedules.md)
- [Skills](skills.md)
