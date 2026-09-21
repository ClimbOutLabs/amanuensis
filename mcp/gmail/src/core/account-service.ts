import fs from "node:fs";
import path from "node:path";
import {
  type AccountManifest,
  AccountNotFoundError,
  getAccountDir,
  getAccountsDir,
  loadManifest,
  removeAccount,
  saveManifest,
  validateAccountId,
} from "./accounts.js";

export function renameAccount(
  oldId: string,
  newId: string,
  env: NodeJS.ProcessEnv = process.env,
): AccountManifest {
  validateAccountId(oldId);
  validateAccountId(newId);
  if (oldId === newId) {
    throw new Error("New account id must be different from the current id.");
  }

  const manifest = loadManifest({ env });
  if (!manifest?.accounts[oldId]) {
    throw new AccountNotFoundError(oldId);
  }
  if (manifest.accounts[newId]) {
    throw new Error(`Account "${newId}" already exists.`);
  }

  const oldDir = getAccountDir(oldId, env);
  const newDir = getAccountDir(newId, env);
  if (fs.existsSync(newDir)) {
    throw new Error(`Account directory already exists: ${newDir}`);
  }

  if (fs.existsSync(oldDir)) {
    fs.mkdirSync(path.dirname(newDir), { recursive: true, mode: 0o700 });
    fs.renameSync(oldDir, newDir);
  } else if (!fs.existsSync(getAccountsDir(env))) {
    fs.mkdirSync(getAccountsDir(env), { recursive: true, mode: 0o700 });
  }

  manifest.accounts[newId] = {
    ...manifest.accounts[oldId],
    updatedAt: new Date().toISOString(),
  };
  delete manifest.accounts[oldId];
  if (manifest.defaultAccount === oldId) {
    manifest.defaultAccount = newId;
  }
  saveManifest(manifest, env);
  return manifest;
}

export function deleteAccount(
  id: string,
  opts: { keepFiles?: boolean; env?: NodeJS.ProcessEnv } = {},
): AccountManifest {
  const env = opts.env ?? process.env;
  validateAccountId(id);
  const manifest = removeAccount(id, env);
  if (!opts.keepFiles) {
    const dir = getAccountDir(id, env);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return manifest;
}
