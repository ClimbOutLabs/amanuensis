# A hosted judges' instance on Nebius

One small Ubuntu VM, one shared judge account, an invented demo world, and the model served by Nebius Token Factory. Check the flags below against `installer/install.sh --help` for the release you install.

## 1. The VM

- **Size:** 4 vCPU, 16 GB RAM, 100 GB disk. The first build needs at least 6 GB of memory and the installer asks for 10 GB free for Docker plus 20 GB free under `/var/lib/aman-slots` for the sandbox disks, so 100 GB leaves room for image builds. 8 GB RAM is the floor; below it the build can be killed.
- **Image:** Ubuntu 24.04 LTS. The installer's Docker and Caddy steps target Ubuntu. 22.04 was not checked.
- **Network:** allow inbound TCP 443 and 80, plus SSH (22) from your own address only. Nothing else. The installer only needs 443; port 80 is for the redirect.
- Note the VM's public IPv4 address (example below: `203.0.113.10`).

## 2. A https name without buying a domain

`--tls caddy` needs real DNS names, not bare IPs, and checks that both names resolve to the VM before it asks Let's Encrypt. A name that embeds the IP passes both checks:

- app: `203-0-113-10.sslip.io`
- sign-in: `login.203-0-113-10.sslip.io`

`nip.io` is built the same way. The installer's name check accepts both forms. Shared name services can hit Let's Encrypt's per-domain limits, so run the install a day early to leave time to switch to a domain of your own.

Fallback: a cheap domain with two A records to the VM, or no public site: `--local-only` and an SSH tunnel for the judges.

## 3. Install

```
ssh ubuntu@203.0.113.10
git clone https://github.com/ClimbOutLabs/amanuensis.git && cd amanuensis
git checkout <release-tag>
```

`v0.1.0` is too old: it has no Token Factory, demo or Caddy support. Use a newer release tag (see `RELEASING.md`), or the exact commit you tested.

Docker is installed by the installer if you pass `--install-docker`. Put the Token Factory key in a file readable only by you, then pipe it in (never as an argument):

```
install -m 600 /dev/null ~/tf.key && nano ~/tf.key   # paste the key, save
./installer/install.sh --yes --install-docker --sandbox-root --tls-root \
  --tls caddy \
  --public-url https://203-0-113-10.sslip.io \
  --login-url https://login.203-0-113-10.sslip.io \
  --email judge@example.com \
  --token-factory-key-stdin \
  --token-factory-model nvidia/nemotron-3-super-120b-a12b \
  --demo < ~/tf.key
shred -u ~/tf.key
```

- `--token-factory-model` can be left out: that id is the installer's default.
- The owner password is generated and shown once at the end. Copy it. With `--password-stdin` it must be the first stdin line, before the key.
- `--yes` never uses sudo or installs Docker on its own; the `--install-docker`, `--sandbox-root` and `--tls-root` flags give that consent. The first run takes several minutes, mostly image builds.
- Use `--dry-run` first to see the plan and any DNS problem.
- Add `--public-ip 203.0.113.10` if the install cannot look up its own address.

## 4. The demo world

`--demo` turns on `DEMO_MODE=true` and runs `aman demo-seed` once the app is healthy. It seeds a persona, memory notes, a morning-briefing schedule and a finished briefing chat for the owner (or `--demo-user ADDRESS`). Every date in her world is counted from the day the seed runs, in Europe/Lisbon (Maya's zone). The seed and the mail move together only when both are run on the same day, so re-run both on the day of judging.

- The seed needs a configured model. The Token Factory model is added to the app when it starts, so this works right after the install.
- `DEMO_MODE` only enables the seeder. Do not connect a real Google account to a demo instance.

### Maya's mailbox

The mailbox is Maya's test Gmail account, filled with the invented emails from `demo/fixtures/mailbox` in English, Portuguese and Spanish, plus two PDFs and a Word file. Load them with `pnpm demo:import-mailbox`. The Arabic, Hindi, Japanese, Sinhala, Chinese and Russian fixtures are not loaded.

## 5. Order on the day

1. Install (sections 3 and 4), a day early.
2. Import the invented emails into Maya's Gmail with `demo:import-mailbox`.
3. Add the birthday to her Google Calendar by hand: an all-day event a few days after the judging date, with an invented name, and not on the GP appointment date (three days after the day you seed).
4. On the morning of judging, run `./installer/install.sh instance demo-seed` (section 7 first if you need a reset), so the dates count from that day. Then run `pnpm demo:import-mailbox` again on that day, which makes the mail for that day; the mail imported on an earlier day stays in the mailbox as it was.
5. Run `aman doctor` and send one test message.

## 6. Check it

```
aman doctor
```

Then open `https://203-0-113-10.sslip.io` and sign in as `judge@example.com`. Send one message and confirm the answer comes from the Nemotron model.

## 7. Reset before judging

```
./installer/install.sh instance demo-seed --reset
./installer/install.sh instance demo-seed
```

The first removes the synthetic records only; the second seeds them again. Chats the judges made are not synthetic, so they stay. For a fully clean start, remove the instance and install again (section 8).

Re-seed and re-import the mail on the morning of judging, since both count from the day they run. Each run makes new Message-IDs, so the new mail is imported; old copies stay in the mailbox until you delete them.

## 8. Tear down after judging

```
./installer/install.sh instance remove main --purge-data --tls-root
```

Type `main` when asked. Then delete the VM in the Nebius console and revoke the Token Factory key. Backups under `~/.amanuensis/backups` die with the VM.
