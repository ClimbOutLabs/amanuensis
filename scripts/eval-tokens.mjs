#!/usr/bin/env node
// Entry for `pnpm eval:tokens`. Logic lives in scripts/eval-tokens/.
import process from 'node:process';
import { main } from './eval-tokens/cli.mjs';

process.exitCode = await main({
  argv: process.argv.slice(2),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
});
