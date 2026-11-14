# Spec: Adding a skill from a chat

**Status:** draft

## Problem

A skill is added in Settings, under Skills. A starter skill is one click, but a skill from someone's repository means filling in five fields by hand: a name, a description, the repository address, the folder and the branch. The name and description are typed by the person, so they can differ from what the skill says about itself, and a branch name is saved as it is, so the skill changes whenever the repository does.

## Solution

Let the person ask the assistant in a chat: "add the skill at github.com/acme/skills/tree/main/skills/release-notes", or name a starter skill. The server does the lookup and shows one approval card. Nothing is saved until the person allows it.

Three rules do not bend:

1. **Adding a skill always asks.** The card offers only a yes or a no for this one skill. No earlier answer, in this chat or any other, covers it.
2. **The card shows what the server read, not what the model said.** The call names only where the skill is. The name, the description and the instructions on the card come from the skill's own `SKILL.md`.
3. **What is approved is what is saved.** The branch or tag is settled to one full commit before the card is built, and the skill is saved pinned to that commit.

## 1. Tools

Two tools of the server's own, mounted on a chat turn's root thread:

- `list_skills`: the skills already added, and the starter skills that can still be added. Read-only, runs without a card.
- `install_skill`: takes `url`, and optionally `path` and `ref`. It accepts the plain repository address and the address of the skill folder or its `SKILL.md` as a browser shows it. It takes no name and no description.

Nothing here changes or removes a skill.

## 2. Reading the skill

- Only public repositories on github.com are read, with no sign-in. Anything else is refused with a plain message that points to Settings, under Skills.
- Every lookup goes through the app's one guard for outside addresses. Only `api.github.com` is asked, the address it answers from must be on the public internet, and a redirect is never followed.
- The ref is settled to a full commit through the GitHub API. No ref means the repository's main branch. A full commit is used as it is.
- `SKILL.md` is read at that commit. Its opening block must hold a description. The stored name is the skill's own name in the form skill names take (lower-case letters, digits and hyphens); when the file names none, the folder name is used.
- A `SKILL.md` over 100 KB, a description over 1,024 characters, or a name that cannot be made into a skill name is refused.
- A lookup is given up after 15 seconds.
- A starter skill from the shipped catalog is added as shipped, at the commit the catalog pins, with its catalog name and description. No lookup is made.

## 3. The approval

- The classifier ranks `install_skill` as an action that always asks, with its own reason. That reason is on the list of reasons that never get a chat-wide or an every-chat answer.
- The card shows the name, what the skill is for, the repository and folder, and the full commit. For a skill read from GitHub its instructions sit under Details. A starter skill's card says it comes with the app. Text from the skill is shown as plain text.
- When the person answers, the server settles the skill again. If the branch has moved, or anything else on the card differs, the approval no longer covers the call and nothing is saved.
- An install the server could not settle is refused without a card.

## 4. What an install does and does not do

- It saves one skill, with the same checks the Settings page saves under.
- It only adds. A skill from the same place that is already there is not added twice, and a different skill with the same name is not replaced. Both say what to do next.
- Before the card, the host reads every file of the skill at the pinned commit (the same host-side git fetch the sandbox copy uses) and scans them for websites (`scanSkillSites`). Nothing in the skill runs. The found list becomes the skill's `network_hosts`; a starter skill uses the list its catalog entry names. Code that builds addresses at run time is flagged on the card. If the files cannot be read, or the list is longer than a skill may name, nothing is offered.
- Approval is all or nothing. Allow saves the skill and its approval of exactly the listed websites; if that approval cannot be saved, the skill is removed again. The list is part of what the approval covers, so a different list at dispatch ends the approval and nothing is saved.
- Settings uses the same scan. Its add form checks the skill first (`POST /api/v1/settings/skills/check-websites`) and sends the list the person saw as `approved_websites`. The server scans again and saves the skill and its approval in one transaction only when the two lists match; otherwise nothing is saved. A git skill's `network_hosts` always comes from the scan, never from the request.
- Removing a skill in Settings removes its websites with its record, and drops its allow-once answers in open chats. A website another installed skill lists stays allowed through that skill's own record.
- Scripts a skill brings run in the sandbox under the same rules as any other code.
- After a call that finishes while the chat is open, the app turns the skill on for that chat. A finished call in an older chat is left alone.
- Without a sandbox the skill is still added, and the assistant says it will work once the sandbox is set up.

## 5. Where it is off

- **Incognito chats:** the tool is not offered, and the classifier refuses the call, like every other lasting change.
- **Scheduled runs:** the tools are not mounted. Nobody is there to read the card.
- **Instances whose skills are kept by a managed registry:** the tools are not mounted.
- **Offline mode:** `install_skill` is marked as needing the network.

## Privacy

Adding a skill from GitHub sends GitHub the address of that skill and a request to read it, with no sign-in and nothing about the person. GitHub sees the computer's internet address. A starter skill sends nothing. `api.github.com` is already on the reviewed list of outside hosts. The privacy page says this.

## Testing

All tests use synthetic data and a stand-in for GitHub; none reaches the real site.

- Classifier: the list runs without asking, an install always asks, skill text is escaped, an unsettled install is refused, an unknown tool fails closed, and an incognito chat is refused.
- Tool set: the card holds what the server read; the name and description cannot be passed in; nothing is saved without approval; a branch that moved ends the approval; starter skills need no lookup; the card lists the websites found and approving allows exactly those; a changed list ends the approval; unreadable files add nothing; a failed approval write removes the skill; nothing is replaced or added twice; each refusal says the one thing to do next.
- Reader: address forms, the opening block, each failure, and the size limit.
- App: the card, the server event parser, and turning the skill on for the chat.
- End to end: a chat asks for a starter skill, the card shows, a chat-wide answer is refused, and Allow saves it. The browser test does the same on the screen.

## Out of scope

- Changing, updating or removing a skill from a chat.
- Private repositories and GitLab from a chat. Both still work in Settings.
- Allowing a website one by one from the install card: the list is approved whole or not at all.
