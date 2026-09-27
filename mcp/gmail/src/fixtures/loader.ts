// Fixture-mode loader: builds a GmailFixtureClient for the resolved active
// account. Used by `bootstrapSession` when GMAIL_FIXTURE_MODE=1.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { gmail_v1 } from "googleapis";
import { GmailFixtureClient, readFixtureScopes } from "./gmail-fixture-client.js";

export interface FixtureBundle {
  gmail: gmail_v1.Gmail;
  scopes: string[];
  /** Absolute path the client reads from — surfaced for diagnostics. */
  accountDir: string;
}

export function loadFixtureGmail(fixtureDir: string, accountId: string | null): FixtureBundle {
  if (!fs.existsSync(fixtureDir)) {
    throw new Error(
      `GMAIL_FIXTURE_DIR ${fixtureDir} does not exist. Create fixtures under fixtures/gmail/<accountId>/ or unset GMAIL_FIXTURE_MODE.`,
    );
  }

  // Default to the first dir under fixtureDir when no account is named.
  const id = accountId ?? defaultAccountId(fixtureDir);
  if (!id) {
    throw new Error(
      `GMAIL_FIXTURE_MODE=1 but no fixture account is configured. Set GMAIL_ACCOUNT or create fixtures/gmail/<id>/.`,
    );
  }

  const accountDir = path.join(fixtureDir, id);
  if (!fs.existsSync(accountDir)) {
    throw new Error(
      `Fixture account dir ${accountDir} does not exist. Available: ${listAccounts(fixtureDir).join(", ") || "(none)"}`,
    );
  }

  const requestedLatency = Number.parseInt(process.env.GMAIL_FIXTURE_DELAY_MS ?? "0", 10);
  const client = new GmailFixtureClient(
    accountDir,
    Number.isFinite(requestedLatency) && requestedLatency > 0 ? requestedLatency : 0,
  );
  return {
    // The cast lives at this one seam — every method in GmailFixtureClient
    // that the ops actually invoke is implemented. Anything unimplemented
    // throws at first call, surfacing the gap immediately rather than
    // silently returning undefined.
    gmail: client as unknown as gmail_v1.Gmail,
    scopes: readFixtureScopes(accountDir),
    accountDir,
  };
}

function listAccounts(fixtureDir: string): string[] {
  if (!fs.existsSync(fixtureDir)) return [];
  return fs
    .readdirSync(fixtureDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function defaultAccountId(fixtureDir: string): string | null {
  const accounts = listAccounts(fixtureDir);
  return accounts[0] ?? null;
}

/**
 * Make sure a fixture-mode config dir exists and is populated with a
 * fixture-derived `accounts.json`. Without this, `list_accounts` reads from
 * the real `~/.gmail-mcp/accounts.json` and leaks real email addresses into
 * the fixture session.
 *
 * Honours an explicit `GMAIL_CONFIG_DIR` from the caller (e2e suite, CI) —
 * we only create a temp dir when nothing is set. Idempotent: re-running
 * against an existing dir keeps it as-is unless the manifest is missing.
 */
export function ensureFixtureConfigDir(fixtureDir: string, env: NodeJS.ProcessEnv): string {
  const explicit = env.GMAIL_CONFIG_DIR?.trim();
  const dir = explicit || fs.mkdtempSync(path.join(os.tmpdir(), "gmail-fixture-cfg-"));

  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, "accounts.json");

  // Always overwrite when we built a fresh temp dir; preserve when caller
  // pointed us at their own dir AND a manifest already exists.
  const accounts = listAccounts(fixtureDir);
  const shouldWrite = !explicit || !fs.existsSync(manifestPath);
  if (shouldWrite) {
    const defaultAccount =
      accounts.find((a) => a === env.GMAIL_ACCOUNT?.trim()) ?? accounts[0] ?? null;
    const manifest = {
      defaultAccount,
      accounts: Object.fromEntries(
        accounts.map((id) => [
          id,
          {
            emailAddress: readFixtureEmail(fixtureDir, id),
            createdAt: new Date(0).toISOString(),
            scopes: readFixtureScopes(path.join(fixtureDir, id)),
            authStatus: "ok",
            updatedAt: new Date(0).toISOString(),
          },
        ]),
      ),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  // Per-account credential placeholder so the manifest-cache is happy.
  for (const id of accounts) {
    const acctDir = path.join(dir, "accounts", id);
    fs.mkdirSync(acctDir, { recursive: true });
    const credPath = path.join(acctDir, "credentials.json");
    if (!fs.existsSync(credPath)) {
      fs.writeFileSync(
        credPath,
        JSON.stringify({ tokens: { access_token: "fixture", refresh_token: "fixture" } }),
      );
    }
  }

  return dir;
}

function readFixtureEmail(fixtureDir: string, accountId: string): string {
  // profile.json may exist with `{emailAddress: ...}`; fall back to a
  // synthetic @fixture.test address so the no-real-data CI guard is happy.
  const profilePath = path.join(fixtureDir, accountId, "profile.json");
  if (fs.existsSync(profilePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(profilePath, "utf8")) as {
        emailAddress?: string;
      };
      if (raw.emailAddress && /@fixture\.test$/i.test(raw.emailAddress)) {
        return raw.emailAddress;
      }
    } catch {
      // fall through
    }
  }
  return `user-${accountId}@fixture.test`;
}
