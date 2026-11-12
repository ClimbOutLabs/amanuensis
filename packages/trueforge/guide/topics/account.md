---
id: account
title: Your sign-in and password
covers: settings:account
---

## How sign-in works on this install

This install keeps its own sign-in: one email address and one password, for one person. There is no account to make anywhere else, and nobody else can be added. The first time you opened Aman, the sign-in page asked you to create it. After that, the same page just asks for the email and password.

Aman stores the password scrambled, never as plain text, and it only works when the page is on this computer or behind https.

## Change your password

1. Open **Settings**, then click **Account**.
2. Under **Change password**, type your **Current password**.
3. Type the **New password**. Use at least 8 characters.
4. Type it once more in **Type the new password again**.
5. Click **Change password**.

Changing the password signs out every other device and browser where you were signed in. The one you are using stays signed in.

## If you forget the password

There is no reset email, because this install has no mail account of its own for you. Reset it from the terminal on this computer instead:

1. Stop Aman.
2. In a terminal, run `npx amanuensis --reset-password`. It asks for the new password twice, and what you type does not show on the screen.
3. Start Aman again and sign in with the new password.

The command will not run while Aman is running. It says to stop Aman first, so the change cannot clash with the running app.
