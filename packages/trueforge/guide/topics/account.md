---
id: account
title: Password and sign-in
covers: settings:account
---

Aman has one sign-in: an email address and a password, for one person. There is no account to make anywhere else. This page shows how to change the password, and what to do if you forget it.

How to get there: Click **More** in the left bar, then **Settings**, then **Account**. You only see **Account** if you started Aman with `npx amanuensis`. If you used the installer, change the password with the `aman` command instead, as shown below.

## How sign-in works

The first time you open Aman, the sign-in page asks you to choose your email and password. After that, it just asks for them.

Aman keeps the password scrambled, never as plain text. Signing in only works when the page is on this computer, or on an `https://` address.

## Change your password in Settings

1. Click **More** in the left bar, click **Settings**, then click **Account**.
2. Under **Change password**, type your **Current password**.
3. Type the **New password**. Use at least 8 characters.
4. Type it once more in **Type the new password again**.
5. Click **Change password**.

Every other device and browser where you were signed in is signed out. The one you're using stays signed in.

## Change your password with the aman command

If you installed Aman with the installer, use this on a Mac or Linux:

1. Open a terminal on the computer where Aman is installed.
2. Type `aman password` and press Enter.
3. Type the new password, then type it again. Nothing shows on the screen while you type.

The password needs at least 8 characters, a number and a symbol, like @ # $ %. Changing it signs you out everywhere, so sign in again on each device.

## If you forget the password

Aman can't email you a reset link, because it has no mail account of its own. Set a new password on the computer where Aman is installed.

=== "Installed with the installer"

    Type `aman password` in a terminal, as shown above. You don't need the old password.

=== "Started with npx"

    1. Stop Aman.
    2. In a terminal, type this and press Enter:

        ```
        npx amanuensis --reset-password
        ```

    3. Type the new password twice. Nothing shows on the screen while you type.
    4. Start Aman again and sign in with the new password.

    The command won't run while Aman is running. It tells you to stop Aman first, so the change can't clash with it.

## Good to know

- Nobody else can be added to your sign-in. Each person who uses Aman gets their own copy, called an instance, with its own sign-in.
- Going back to a backup also brings back the password you had then.
- Signing in says the email isn't allowed? Type exactly the email you chose at install, in lowercase.

## Related

- [The aman command](../../../../docs/commands.md)
- [Back up and restore](../../../../docs/backup.md)
- [Troubleshooting](../../../../docs/troubleshooting.md)
