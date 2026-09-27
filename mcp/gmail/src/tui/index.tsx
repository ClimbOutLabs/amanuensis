// Phase D entry point: `gmail tui` lazy-loads this module and calls runTui().
// Boots the in-process dispatcher via bootstrapSession (TUI does NOT use
// main() — Ink owns the signal handlers).
//
// No-account guard: before bootstrap we peek at the manifest. If no account
// is configured we render NoAccountScreen — an Ink-native empty-state
// dialog with a one-key launch into the interactive `gmail account auth`
// flow. This avoids the cryptic "credentials.json not found" stack and
// gives first-time users a guided path to a working TUI.

import { spawn } from "node:child_process";
import { render } from "ink";
import { loadManifest } from "../core/accounts.js";
import { BootstrapError, bootstrapSession } from "../index.js";
import { App } from "./App.js";
import { NoAccountScreen } from "./components/NoAccountScreen.js";
import { loadTuiConfig } from "./config.js";
import { withFullScreen } from "./fullscreen.js";
import { loadTheme } from "./themes/index.js";

/** Returns true when there's at least one account in the manifest. */
function hasConfiguredAccount(): boolean {
  try {
    const manifest = loadManifest();
    return !!manifest && Object.keys(manifest.accounts).length > 0;
  } catch {
    // Corrupted manifest → treat as no-account so the user can re-auth.
    return false;
  }
}

/**
 * Render a tiny Ink screen for the no-account case. Resolves when the
 * user presses `a` (returns true → re-bootstrap pending) or `q` (returns
 * false → quit). Spawning the interactive auth requires suspending the
 * Ink runtime: we unmount, spawn `gmail account auth`, inherit stdio, and
 * wait for the child to exit. The caller decides whether to retry.
 */
async function renderNoAccountScreen(reason: string | undefined): Promise<boolean> {
  const config = loadTuiConfig();
  const theme = loadTheme(config.theme);
  return new Promise((resolve) => {
    let triggered = false;
    const onAuth = () => {
      if (triggered) return;
      triggered = true;
      app.unmount();
      runAuthFlow().then(
        (authed) => {
          resolve(authed);
        },
        () => {
          resolve(false);
        },
      );
    };
    const app = render(<NoAccountScreen theme={theme} reason={reason} onAuth={onAuth} />, {
      stdout: process.stdout,
      stdin: process.stdin,
      exitOnCtrlC: true,
    });
    const settleWithoutAuth = () => {
      if (!triggered) resolve(false);
    };
    void app.waitUntilExit().then(settleWithoutAuth, settleWithoutAuth);
  });
}

/**
 * Spawn the interactive `gmail account auth` flow with full stdio
 * inheritance — the user gets the same interactive Inquirer experience
 * they would from a fresh shell. Returns true when the child exits 0
 * (auth succeeded), false otherwise.
 *
 * Resolves the bin path through `process.argv[1]` so a globally-installed
 * `gmail` AND a local `npx gmail` invocation both pick up the right
 * binary. The fallback `gmail` lookup on PATH covers the case where the
 * argv resolution fails (rare; happens when the binary is wrapped).
 */
async function runAuthFlow(): Promise<boolean> {
  const bin = resolveGmailBin();
  return new Promise((resolve) => {
    const child = spawn(bin, ["account", "auth"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      resolve(code === 0);
    });
    child.on("error", (err) => {
      process.stderr.write(`\nCould not launch auth: ${err.message}\n`);
      resolve(false);
    });
  });
}

function resolveGmailBin(): string {
  // process.argv[1] is the entrypoint script — usually the gmail bin.
  // If we can't resolve it sensibly, fall back to PATH lookup of `gmail`.
  const argv1 = process.argv[1] || "";
  if (argv1.endsWith("/gmail") || argv1.endsWith("\\gmail")) return argv1;
  return "gmail";
}

export async function runTui(): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write(
      "gmail tui requires an interactive terminal (TTY). Use `gmail` for the non-interactive CLI.\n",
    );
    process.exit(2);
  }

  // Pre-bootstrap account guard. If the manifest is missing or empty we
  // render the no-account screen first; bootstrap is deferred until the
  // user has finished `gmail account auth`. This loop runs at most twice
  // in practice: once to show the screen, once more after a successful
  // re-auth confirms an account is now configured.
  while (!hasConfiguredAccount()) {
    const authed = await renderNoAccountScreen(
      "No accounts found in ~/.gmail-mcp/accounts.json. Authorise one to continue.",
    );
    if (!authed) {
      process.stderr.write(
        "\nNo account configured. Run `gmail account auth <id>` and re-launch the TUI.\n",
      );
      process.exit(2);
    }
  }

  try {
    await bootstrapSession({ skipTransport: true });
  } catch (err) {
    if (err instanceof BootstrapError) {
      // Bootstrap failed AFTER the account guard passed — this is a real
      // credential issue (token expired, OAuth keys missing, etc), not a
      // "no account configured" case. Surface it via the same screen so
      // the user has the same one-key path to re-auth.
      const authed = await renderNoAccountScreen(err.message);
      if (!authed) {
        process.stderr.write(
          `\nCould not start TUI: ${err.message}\n\n` +
            `Hint: run \`gmail account auth <id>\` to re-authorise.\n`,
        );
        process.exit(2);
      }
      // User re-authed in-flow — retry bootstrap. If it still fails we
      // bail with the original error rather than looping forever.
      try {
        await bootstrapSession({ skipTransport: true });
      } catch (retry) {
        process.stderr.write(`\nBootstrap still failing after auth: ${(retry as Error).message}\n`);
        process.exit(2);
      }
    } else {
      throw err;
    }
  }

  const config = loadTuiConfig();
  const theme = loadTheme(config.theme);
  const ink = withFullScreen(<App initialTheme={theme} config={config} />);
  await ink.start();
  await ink.waitUntilExit();
}
