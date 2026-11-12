---
id: memory
title: Memory
covers: settings:memory, route:memoryRecall, route:memoryScreen, route:memorySummarize, route:memoryPageSorting, route:memoryNightly, route:memoryVault, route:memoryPages
---

Aman remembers what matters to you. Ask "What do you remember about me so far?" to see it.

Memory is on by default. It is stored as plain Markdown files on your own computer. Open Settings, then Memory, to read, change or delete what Aman remembers.

Memory search uses a small model that runs on your computer. Nothing about it is sent away.

Each memory ends with a line that says where it came from. "From you" means you said it in a chat. "External source" means it came from somewhere else, such as an email, a web page or an imported file. Aman treats only "From you" memories as your own words. It asks you before it uses a link or an address from any other memory. Changing a memory never changes where it came from, and a memory you reviewed as your own still says "From you" after you edit it. A memory saved before Aman kept this line shows "External source: no record". Aman treats it as external, because nothing shows where it came from.

You can review these older memories once. Open the Memories page and look for the note that starts "Some older notes have no record of where they came from". Click **Review older notes**. The list holds only memories Aman saved in a chat where it had read nothing from outside, and where you attached no file. Tick the ones that are your own words, then click **Mark the ticked notes as from me**. Nothing is ticked at the start, and nothing changes until you click. Memories that are not in the list stay external. You can also make a fact your own by saying it to Aman in a chat.

Searching your past chats is separate from memory. When it is on, Aman can look through your own earlier chats when you ask, for example "What did we decide about the Lisbon trip last week?" It searches what you typed and Aman's final replies, in the chats the assistant you are asking is allowed to see: its own chats, chats with your main assistant, and chats shared with it. The chat you are in now is never included.

It is off by default. Turn it on in Settings, then Memory: "Let Aman search your past chats when you ask". A chat you delete leaves the search at once.

## Pages about people and matters

Aman keeps a short page for each person and each matter in your life, such as your sister or a house move. Open Settings, then Memory, then **Pages** to read them. You only see this tab when memory is kept as Markdown files, which is the default.

Pages are in two groups, People and Matters. Each row shows the name, one line about it and the day it last changed. A small count says how many lines wait for you to confirm. Type in the search box to find a page by its name or another name it goes by.

Aman does not list your pages in every reply. When you ask about something and no page was shown for it, it can look at the list and open a page that looks relevant. A page with no line of your own is listed apart, and its name is marked "not confirmed by you", because Aman made it from something it read.

Open a page to read it. The top shows the day it last changed and a short summary of what the page covers. Aman writes that summary when it makes the page, and it is only a description for you. Below it, each fact is one short line. A line you said or wrote yourself looks plain. A line Aman read in mail, the calendar or elsewhere says "External source:" and where it came from, the same words a memory uses. When you ask Aman in a chat to save something it read for you, such as an address from an email, it saves the line on the page straight away with this label. You do not have to confirm it. Aman does not save a line that looks like a password, a key or a card number onto a page, even when you ask. It tells you it did not save it. Aman never treats such a line as your instruction, and it never replaces a line of your own. To make a fact your own, say it to Aman yourself. Lines under Unconfirmed say "Not confirmed". Aman never treats them as your words until you decide.

- Choose **Confirm** to keep an unconfirmed line as yours. You can pick which section it goes to. The default is Now.
- Choose **Dismiss** to remove an unconfirmed line.
- Choose **Edit** to change the whole page as text, then **Save**. If the page changed while you were editing, Aman asks you to reload it and try again. Nothing is lost.
- Choose **Delete** to remove a page. For a few seconds you can choose **Undo** to cancel it.

Once a night Aman also checks each page for two lines that cannot both be true. When it finds some, the page row says how many pairs disagree, and the page shows **These lines disagree** at the top with both lines and a short reason. Aman changes nothing on the page. If one line is wrong, use **Edit** to fix it. If the pair is fine, choose **Not a problem** and Aman will not list those two lines again. In the same nightly tidy, a line whose end day has passed moves to Earlier by itself.

Two helpers work on your pages while you are not chatting. Both start off, and both use the model. Open Settings, then Memory, to switch them on. Under **Sort what Aman saves onto pages**, choose Off, **Only note what it would do** or On. With On, what Aman read can only ever be added as not confirmed. Switch on **Tidy pages once a day** to have Aman move ended lines to Earlier, sort notes it missed and list lines that disagree, in the night. A change counts at once, with no restart. You only see these when memory is kept as Markdown files.

Under each page in the list you have **Copy**, **Edit** and **Delete**, the same as under a memory. The same three are at the bottom of an open page. Aman keeps a history of every change to your pages in the memory folder on your computer.
