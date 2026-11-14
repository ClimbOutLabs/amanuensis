---
id: phone
title: Phone and other devices
covers:
---

Use Aman from your phone, a tablet or another computer in your home. The device must be on the same home network (Wi-Fi) as the computer Aman runs on.

!!! note "On a Mac, Aman opens on that Mac only"

    When Aman is installed on a Mac, phones and other computers can't reach it. Use it in a browser on that Mac. The steps below are for Aman on Linux or Windows.

## Before you start: let the device trust your computer

The first time you open Aman on a new device, the browser warns that the page is not private. That's because your computer made its own security certificate, which the device doesn't know yet. Don't click past the warning. Instead, do this trust step once on each device:

=== "Linux"

    1. Find the line the installer printed that starts "Instead, open this page once on that device and follow its steps". It has an address that ends in `/trust`.
    2. Open that address on the device, or scan the square code the installer printed.
    3. Follow the page. It has steps for iPhone, Android, Mac and Windows.

=== "Windows"

    1. On the computer, choose **Use Aman on my phone** in the Start menu. It prints the addresses and a square code to scan.
    2. Scan the code with the phone, or open the trust page address on the device.
    3. Follow the page. It has steps for iPhone, Android, Mac and Windows.

    If you don't see **Use Aman on my phone**, you said no to the phone question during the install. Open PowerShell from the Start menu and run:

    ```
    aman network open
    ```

    Windows asks for permission to change the firewall. Choose Yes.

!!! tip "On an iPhone"

    Open the trust page in Safari and install the profile. Then turn it on in the iPhone's Settings, under General, About, Certificate Trust Settings. The iPhone says the profile is "Not Signed". That's expected for a profile your own computer made.

While you trust it, your device shows a long code called a fingerprint. It must match the one the installer printed. If it's different, stop and don't trust it.

## Open Aman on the device

1. Open the https address from the list the installer printed. It starts with `https://` and usually ends in `:8443`.
2. Sign in with your email and password.

!!! tip "Keep it handy"

    Bookmark the address, or add it to your phone's Home Screen. On an iPhone, Aman must be on the Home Screen before it can show notices. See [Reach me](reach-me.md).

## If something goes wrong

- The page says the connection is not private. This device doesn't trust your computer yet. Do the trust step above on this device.
- "Turn on for this device" says the device doesn't trust the computer. Notices need the same trust step. Do it on this device, then go back to **Settings**, **Reach me** and press **Turn on for this device** again.
- Aman was restored from a backup, or its certificate was made again. Each device needs to trust the computer again. Do the trust step once more.
- The page doesn't open at all. Check that the device is on the same Wi-Fi as the computer, and that the computer is on.

## On a small screen

On a small phone, the buttons at the top of a chat use shorter names so they all fit. **Agent details** shows as "Details", and **Help, I'm stuck** shows as "Help". The three dots at the end open the rest, such as **Clear chat**.

## Good to know

- To close Aman to your home network again on Windows, run `aman network close` in PowerShell.
- Reaching Aman from outside your home, over the internet, takes more setup. See [Using it from other devices](../../../../docs/install.mdx#using-it-from-other-devices).

## Related

- [Reach me](reach-me.md): get notices on your phone.
- [Try Aman](../../../../docs/try-aman.md): installing and your first sign-in.
