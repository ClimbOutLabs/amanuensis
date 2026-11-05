---
title: 'Text messages'
description: 'Let your assistant text you when something needs you.'
---

Your assistant can send you a text when something needs you and you are away from Aman. Texts are off until you turn them on. A new install texts no one.

Texts go through Twilio, a service you sign up for. You pay Twilio for each text.

## What a text says

- **Private (the default).** The text says only the kind of thing, such as "Mannie: a reminder is due. Open Aman to see it." It holds no names, amounts or message content. Your assistant's name is the one you chose in Personalization.
- **Full.** The text holds the one-sentence message. It can show on a locked screen, and Twilio and the phone company can read it.

Texts only go one way. If you reply STOP (or UNSUBSCRIBE, CANCEL, END or QUIT), Aman turns texts off and records it in Activity. Any other reply is ignored. To use texts again, reply START from that phone and confirm your number again in Settings.

## Set it up

1. Make a Twilio account and get a phone number that can send texts. Copy your account id, your auth token and the number.
2. Choose how Twilio will reach Aman. See "Let Twilio reach Aman" below. You need one https address for this.
3. Add these lines to the settings file of your Aman (under the line that says to add your own settings), then restart Aman.

```
REACH_SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_FROM_NUMBER=+15550100
TWILIO_WEBHOOK_PUBLIC_URL=https://your-address.example
# Optional. The port Twilio's messages arrive on. The default is 8793.
# TWILIO_WEBHOOK_PORT=8793
```

4. In the Twilio console, open your number and set "A message comes in" to a webhook, method POST, at `https://your-address.example/twilio/sms`.
5. In Aman, open Settings, then Reach me. Enter your number with the country code, type the code that arrives, choose Private or Full, switch texts on, save, and press Try it.

Keep the auth token secret. Aman never writes it to its logs.

## Let Twilio reach Aman

Twilio sends your replies (STOP) to a small separate door on your computer. This door has its own port and answers only Twilio's messages. It never shows the Aman app or the sign-in page. Every request must carry Twilio's signature, and Aman refuses anything else.

Pick one way to open it. Never publish the main Aman port.

- **Tailscale Funnel, on that port only.** If you use Tailscale, run `tailscale funnel 8793` (use your own port if you changed it). Tailscale gives you an https address. Use it as `TWILIO_WEBHOOK_PUBLIC_URL`.
- **Your own domain with https.** Put a web server such as Caddy in front of the Twilio port, with a certificate for your domain. Send only the path `/twilio/` to port 8793. Use your domain as `TWILIO_WEBHOOK_PUBLIC_URL`.

If you installed Aman with the installer, it opens the port on this computer only (127.0.0.1) once `REACH_SMS_PROVIDER=twilio` is in the settings file and you run the installer again. Tailscale or your web server then carries it from there.

## Privacy

Twilio and the phone company see your number and each text. In Private mode a text holds only the kind of thing. Your number is kept in your own database and is part of your data export. An import brings the number back unconfirmed and with texts off, so you confirm it again.

See [Privacy](/privacy).
