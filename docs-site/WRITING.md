# Writing the help docs

The help docs are for people who use Aman, not for people who build it. Most readers are not technical. They come to a page with one question, such as "How do I connect my calendar?" Each page should answer that question quickly, so the reader never has to guess.

The website at climboutlabs.github.io/amanuensis is built with MkDocs Material from `docs/` and the in-app help topics in `packages/trueforge/guide/topics/`. Aman's **Help, I'm stuck** reads the same topics, so one page serves both.

## Voice

- Write in American English, with American spelling and grammar: color, favorite, organize, canceled, gray.
- Talk to the reader as "you". Call the product "Aman". Never call it TrueForge or Amanuensis on a user page.
- Be warm, plain and direct. Write the way a helpful person explains something across a desk.
- Use one idea per sentence and keep paragraphs to one to three sentences.
- Use the present tense and the active voice: "Aman saves the draft", not "The draft will be saved".
- Avoid jargon. When a technical word can't be avoided, explain it the first time, in the same sentence.
- Never blame the reader. Say what happens and what to do next.

## Page pattern

Every feature page follows the same order. Leave out a part only when it has nothing to say.

1. **Title**: what the reader wants to do, or the feature's name as the app shows it. Use sentence case, as in "Connect your calendar".
2. **Intro**: one or two sentences on what the feature does and why it helps.
3. **How to get there**: a line that starts `How to get there:` and names the clicks, as in `How to get there: Click **More** in the left bar, then **Settings**, then **Memory**.` The site shows it as a highlighted box.
4. **Screenshot** of the screen the page talks about, where one helps.
5. **Before you start**, only when something must be set up first. Use a `!!! note "Before you start"` box.
6. **Steps**: numbered, one action per step, in the order the reader does them. Name each button exactly as the app shows it.
7. **Good to know**: short bullets for limits, what stays private and what Aman asks first.
8. **Related**: links to the two or three pages a reader is most likely to want next.

## Formatting

- **Bold** is only for words the reader sees on screen, such as buttons, tabs and menu items, and it must match the app exactly. In help topics a test checks every bold phrase against `packages/trueforge/guide/ui-labels.json`. Add a new label there with the file that shows it.
- Use these MkDocs Material features where they make a page easier to follow:
  - Boxes: `!!! note` for something to know, `!!! tip` for a shortcut, `!!! warning` for something that can't be undone, and `??? note "Title"` for detail most readers can skip.
  - Tabs: `=== "Mac"`, `=== "Linux"` and `=== "Windows"` when the steps differ by computer. Indent each tab's content by four spaces.
  - Keys: `++ctrl+shift+space++` for a keyboard shortcut.
  - Grid cards (`<div class="grid cards" markdown>`) on overview pages that point to several other pages.
- Show a screen on both a computer and a phone, in two tabs:

  ```markdown
  === "Computer"

      ![The Memory page in Settings](../../../../docs/screenshots/app/memory-settings-desktop.png)

  === "Phone"

      ![The Memory page in Settings](../../../../docs/screenshots/app/memory-settings-phone.png)
  ```

- Give each screenshot alt text that says what it shows. Take screenshots with the demo data from `pnpm docs:screenshots`, never test names.
- Put commands in code blocks, one command per block where the reader runs them one at a time.
- Keep settings that need a terminal, environment variables, and how a feature works inside to the pages under **Advanced**. Link to them from a "Good to know" bullet.
- Don't tell the reader to change their computer's system settings.

## Help topics

A help topic keeps its front matter. `id` and `covers` say which screens and cards the topic explains, and `pnpm test:help-coverage` checks that every screen has one. When you merge or split topics, move their `covers` entries with the content. After editing a topic, run `pnpm guide:build` and commit the regenerated help pack.

In a help topic, a link to another topic is a plain file name, such as `[Memory](memory.md)`. A screenshot links into the docs folder: `![The Memory page](../../../../docs/screenshots/app/settings-memory.png)`.
