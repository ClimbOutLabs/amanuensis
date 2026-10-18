<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trust your home server</title>
<style>
  body { font: 1rem/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 40rem; padding: 1rem; color: #1b1b1b; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #ececec; background: #151515; } a { color: #8ab4ff; } }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.125rem; margin-top: 2rem; }
  .download { display: inline-block; margin: 0.25rem 0.5rem 0.25rem 0; padding: 0.625rem 1rem; border-radius: 0.5rem; background: #2a5bd7; color: #fff; text-decoration: none; }
  code { overflow-wrap: anywhere; }
  .note { padding: 0.75rem 1rem; border-left: 0.25rem solid #c77d00; background: rgba(199, 125, 0, 0.12); }
  ol { padding-left: 1.25rem; }
</style>
</head>
<body>
<h1>Make this device trust your home server</h1>
<p>You only do this once per device.</p>
<p>Until you do, your browser warns that the page is not private when you open Aman. Do not click past that warning. Follow the steps for your device below instead.</p>
<p class="note">Your device will show a long code called a fingerprint. Before you trust it, compare the fingerprint your device shows with the one in the terminal on the computer that runs Aman (the end of the install, or <code>aman doctor</code>). If they do not match, stop and do not trust it.</p>
<p>
  <a class="download" href="/trust/aman.mobileconfig">Download for iPhone or iPad</a>
  <a class="download" href="/trust/ca.crt">Download for Android, Mac or Windows</a>
</p>

<h2>iPhone and iPad</h2>
<p>Open this page in Safari, not inside another app.</p>
<ol>
  <li>Tap the iPhone download, then Allow.</li>
  <li>Open Settings and tap "Profile Downloaded" near the top. Tap Install and enter your passcode. Do this within 8 minutes.</li>
  <li>Open Settings, General, About, Certificate Trust Settings, and turn on full trust for "Amanuensis home server".</li>
</ol>

<h2>Android</h2>
<p>Open this page in Chrome, not inside another app.</p>
<ol>
  <li>Tap the Android download and keep the file.</li>
  <li>Open Settings and search for "certificate". Choose Install a certificate, then CA certificate, then Install anyway.</li>
  <li>Pick the file you just downloaded.</li>
</ol>

<h2>Mac</h2>
<ol>
  <li>Download the file and double-click it. Keychain Access opens.</li>
  <li>Find "Amanuensis home server", double-click it, open Trust, and choose Always Trust. Close the window and enter your password.</li>
</ol>

<h2>Windows</h2>
<ol>
  <li>Download the file and double-click it, then choose Install Certificate.</li>
  <li>Choose "Place all certificates in the following store", then Browse and pick Trusted Root Certification Authorities. Finish and answer Yes.</li>
</ol>

<p>Firefox keeps its own list: Settings, Privacy and Security, View Certificates, Authorities, Import.</p>

<p class="note">If you still see a warning, trust isn't finished. Don't tap through it; finish the steps above.</p>

<p>When you are done, open <a href="@@OPEN_URL@@">@@OPEN_URL@@</a>.</p>
</body>
</html>
