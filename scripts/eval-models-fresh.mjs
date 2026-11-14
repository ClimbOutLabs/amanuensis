#!/usr/bin/env node
// Entry for `pnpm eval:models:fresh`. Logic lives in scripts/eval-models/fresh.mjs.
import process from 'node:process';
import { main } from './eval-models/fresh.mjs';

process.exitCode = await main({
  argv: process.argv.slice(2),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
});
