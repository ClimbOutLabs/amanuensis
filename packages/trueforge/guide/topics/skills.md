---
id: skills
title: Skills
covers: settings:skills, route:skill
---

A skill is a set of step-by-step instructions that teaches Aman a particular job, such as writing release notes or following a checklist. Turn on the skills you want, then switch them on in the chats that need them.

How to get there: Click **More** in the left bar, then **Settings**, then **Skills**.

=== "Computer"

    ![The Skills page in Settings, with enabled and available skills](../../../../docs/screenshots/app/skills-page-desktop.png)

=== "Phone"

    ![The Skills page in Settings, with enabled and available skills](../../../../docs/screenshots/app/skills-page-phone.png)

!!! note "Before you start"

    Skills run in the sandbox, a closed-off workspace where Aman can run code. Set up the sandbox first. See [Run code](code.md).

## Turn on a skill

1. Find the skill under Available. Type in **Search skills** to narrow the list.
2. Click **Enable**. The skill moves up to Enabled.

## Use a skill in a chat

1. In the chat, click **Add files and tools** beside the message box.
2. Click **Add-ons**, then the **Skills** tab.
3. Select the skill.

When a skill is on for a chat, Aman reads its instructions when the job comes up.

## Add your own skill from GitHub

1. Click **Import from GitHub**.
2. Fill in **Name** and **Description**, so you can recognize the skill later.
3. In **Repository URL**, paste the web address of the GitHub project that holds the skill.
4. In **Folder containing the SKILL.md**, type the folder that holds the skill's instructions file, such as skills/release-notes.
5. In **Branch**, type the branch to use, such as main.
6. Click **Import**.

You need to fill in every box.

## Turn a skill off

Click **Remove** on the skill's row under Enabled. For a skill you imported, Aman asks first: click **Remove skill**. You can import it again later.

## Let a skill reach the internet

Some skills need to reach certain websites. After you enable one, Aman lists the sites it asks for.

- Click **Allow** to let chats using this skill reach those sites, and no others.
- Click **Don’t allow** to keep it offline. Click **Review the sites** to decide again later.
- To take access back, click **Remove network access**.

!!! warning

    A skill with internet access can send any of your data to the sites it lists. Only allow this for a skill you trust. If a site can send email, Aman says so, because the skill could then send email as you without asking each time.

## Good to know

- Aman only reads a skill's full instructions when it decides the skill fits the job, so skills you don't need cost nothing.
- For how skills are built and where they come from, see [Skills setup](../../../../docs/skills.mdx).

## Related

- [Run code](code.md)
- [Agents](agents.md)
- [Connectors](../../../../docs/mcp-servers.mdx)
