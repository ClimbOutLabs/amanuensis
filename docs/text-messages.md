---
title: 'Text messages'
description: 'Let your assistant text you when something needs you.'
---

Your assistant can send you a text when something needs you and you are away from Aman. Texts are off until you turn them on. A new install texts no one.

Texts go through Twilio, a service you sign up for. You pay Twilio for each text.

## What a text says

- **Private (the default).** The text says only the kind of thing, such as "Mannie: a reminder is due. Open the app to see it." It holds no names, amounts or message content. Your assistant's name is the one you chose in Personalization. A text uses at most 20 letters of it.
- **Full.** The text holds the one-sentence message, cut to fit two texts. It can show on a locked screen, and Twilio and the phone company can read it. A message that holds a link, a website, a phone number or an email address is sent in Private words instead. Such a message can come from mail someone else wrote, and a link or a number to call in a text is a common trick.

The text with your confirmation code holds only the code. It does not name your assistant.

Texts only go one way. If you reply STOP (or UNSUBSCRIBE, CANCEL, END or QUIT), Aman turns texts off and records it in Activity. Any other reply is ignored. To use texts again, reply START from that phone and confirm your number again in Settings.

## Set it up

1. Make a Twilio account and get a phone number that can send texts. Copy your account id, your auth token and the number.
2. Choose how Twilio will reach Aman. See "Let Twilio reach Aman" below. You need one https address for this.
3. Open the settings file of your Aman. If you installed Aman with the installer, it is `~/.amanuensis/instances/<name>/.env`, where `<name>` is your instance, such as `main`. If you run Aman from a copy of the code, it is `packages/trueforge/.env`. Add these lines under the line that says to add your own settings.

```
REACH_SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_FROM_NUMBER=+15550100
TWILIO_WEBHOOK_PUBLIC_URL=https://your-address.example
# Optional. The port Twilio's messages arrive on. The installer picks one for you.
# TWILIO_WEBHOOK_PORT=9201
```

Then start Aman again with the new settings. If you installed Aman with the installer, run `./installer/install.sh` again from your `amanuensis` folder. If you run Aman from a copy of the code, stop it and start it again. Do the same after you change any of these lines later, such as a new auth token.

When Aman starts, it tells Twilio to send the texts that come in to your number to `TWILIO_WEBHOOK_PUBLIC_URL`. You do not set this in the Twilio console. Aman changes only that setting, and only for the number in `TWILIO_FROM_NUMBER`. If it cannot, it says so in its log, and texts still go out.

4. In the Twilio console, open Messaging, then Settings, then Geo permissions. Allow only the countries you text. Aman sends codes only to numbers a person types in, but this keeps any mistake from costing you texts to far-away numbers.
5. In Aman, open Settings, then Reach me. Enter your number with the country code, type the code that arrives, choose Private or Full, switch texts on, save, and press Try it.

Keep the auth token secret. Aman never writes it to its logs. If you change the auth token, a code sent before the change no longer works. Ask for a new one.

Texts cost money, so Aman limits them:

- Each person gets at most 30 texts a day, reminders and tests included. After that, new items wait in the app, and the item says when texts start again.
- Try it sends at most 3 test texts an hour.
- Aman sends at most 3 codes an hour for each person, and at most 50 codes a day in all.
- Aman sends at most 3 codes an hour, and 10 a day, to any one number, whoever asks. The person whose number it already is can still get a code. Removing a number does not reset these limits.

To change your number, type the new one and confirm its code. Texts keep going to your old number until you do.

## Let Twilio reach Aman

Twilio sends your replies (STOP) to a small separate door on your computer. This door has its own port and answers only Twilio's messages. It never shows the Aman app or the sign-in page. Every request must carry Twilio's signature, and Aman refuses anything else.

Pick one way to open it. Never publish the main Aman port.

- **Tailscale Funnel, on that port only.** If you use Tailscale, run `tailscale funnel 9201`. Use your own port instead if the installer picked another one. Tailscale gives you an https address. Use it as `TWILIO_WEBHOOK_PUBLIC_URL`.
- **Your own domain with https.** Put a web server such as Caddy in front of the Twilio port, with a certificate for your domain. Send only the path `/twilio/` to that port. Use your domain as `TWILIO_WEBHOOK_PUBLIC_URL`.

If you installed Aman with the installer, running `./installer/install.sh` again opens the port on this computer only (127.0.0.1) once `REACH_SMS_PROVIDER=twilio` is in the settings file. Tailscale or your web server then carries it from there. Each instance with texts needs its own port. If you set no port, the installer picks a free one, starting at 9201, and writes it as `TWILIO_WEBHOOK_PORT` in the part of the settings file it manages. If you set a port that another instance already uses, the installer says so and names the line to change.

Phone calls use this same door and the same address. See [Phone calls](/phone-calls).

## Privacy

Twilio and the phone company see your number and each text. In Private mode a text holds only the kind of thing. Your number is kept in your own database and is part of your data export. An import brings the number back unconfirmed and with texts off, so you confirm it again.

See [Privacy](/privacy).
