---
id: memory
title: Memory
covers: settings:memory, route:memoryRecall, route:memoryScreen, route:memorySummarize, route:memoryPageSorting, route:memoryNightly, route:memoryVault, route:memoryPages
---

Aman remembers what matters to you. Ask "What do you remember about me so far?" to see it.

Memory is on by default. It is stored as plain Markdown files on your own computer. Open Settings, then Memory, to read, change or delete what Aman remembers.

Memory search uses a small model that runs on your computer. Nothing about it is sent away.

Searching your past chats is separate from memory. When it is on, Aman can look through your own earlier chats when you ask, for example "What did we decide about the Lisbon trip last week?" It searches what you typed and Aman's final replies, in the chats the assistant you are asking is allowed to see: its own chats, chats with your main assistant, and chats shared with it. The chat you are in now is never included.

It is off by default. Turn it on in Settings, then Memory: "Let Aman search your past chats when you ask". A chat you delete leaves the search at once.

## Pages about people and matters

Aman keeps a short page for each person and each matter in your life, such as your sister or a house move. Open Settings, then Memory, then **Pages** to read them. You only see this tab when memory is kept as Markdown files, which is the default.

Pages are in two groups, People and Matters. Each row shows the name and one line about it. A small count says how many lines wait for you to confirm. Type in the search box to find a page by its name or another name it goes by.

Open a page to read it in order. A line you said or wrote yourself looks plain. A line Aman read in mail, the calendar or elsewhere says where it came from. Lines under Unconfirmed say "Not confirmed". Aman never treats them as your words until you decide.

- Choose **Confirm** to keep an unconfirmed line as yours. You can pick which section it goes to. The default is Now.
- Choose **Dismiss** to remove an unconfirmed line.
- Choose **Edit page** to change the whole page as text, then **Save**. If the page changed while you were editing, Aman asks you to reload it and try again. Nothing is lost.
- Choose **Delete page** to remove a page. For a few seconds you can choose **Undo** to cancel it.

Once a night Aman also checks each page for two lines that cannot both be true. When it finds some, the page row says how many pairs disagree, and the page shows **These lines disagree** at the top with both lines and a short reason. Aman changes nothing on the page. If one line is wrong, use **Edit page** to fix it. If the pair is fine, choose **Not a problem** and Aman will not list those two lines again. In the same nightly tidy, a line whose end day has passed moves to Earlier by itself.

Two helpers work on your pages while you are not chatting. Both start off, and both use the model. Open Settings, then Memory, to switch them on. Under **Sort what Aman saves onto pages**, choose Off, **Only note what it would do** or On. With On, what Aman read can only ever be added as not confirmed. Switch on **Tidy pages once a day** to have Aman move ended lines to Earlier, sort notes it missed and list lines that disagree, in the night. A change counts at once, with no restart. You only see these when memory is kept as Markdown files.

Under Recent changes you see the last things that changed on your pages. Choose **Undo** next to one to put those pages back as they were. Aman never erases its history, so an undo is a new change. If a later change also touched the page, Aman tells you which change to undo first.
