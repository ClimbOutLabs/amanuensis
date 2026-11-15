#!/usr/bin/env node
// Entry for `pnpm eval:models`. Logic lives in scripts/eval-models/.
import process from 'node:process';
import { main } from './eval-models/cli.mjs';

process.exitCode = await main({
  argv: process.argv.slice(2),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
});
