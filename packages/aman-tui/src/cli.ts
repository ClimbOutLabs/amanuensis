#!/usr/bin/env node
import { render } from 'ink';
import { createElement } from 'react';

import { App } from './components/App.js';
import { resolveConfigDir } from './configDir.js';
import { loadInstanceStore, normalizeInstanceAddress, saveInstanceStore } from './instances.js';
import { runLogin } from './login.js';
import { PairingRefusedError } from './pairing.js';

const USAGE = [
  'aman-tui: Aman in the terminal.',
  '',
  '  aman-tui                      Open the app on the active instance.',
  '  aman-tui login <address>      Pair this terminal with an Aman instance.',
  '  aman-tui login <address> --name <name>',
  '                                Pair under a name of your choosing.',
  '  aman-tui instances            List the instances paired with this terminal.',
  '  aman-tui use <address>        Make one paired instance the active one.',
].join('\n');

function readNameFlag(args: string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === '--name') {
      return args[index + 1];
    }
    if (arg.startsWith('--name=')) {
      return arg.slice('--name='.length);
    }
  }
  return undefined;
}

/** The first argument that is not the --name flag or its value. */
function readAddressArg(args: string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    if (arg === '--name') {
      continue;
    }
    if (arg.startsWith('--')) {
      continue;
    }
    if (index > 0 && args[index - 1] === '--name') {
      continue;
    }
    return arg;
  }
  return undefined;
}

async function run(argv: string[]): Promise<number> {
  const configDir = resolveConfigDir();
  const [command, ...rest] = argv;

  if (command === undefined || command === 'chat') {
    const instance = render(createElement(App, { configDir }));
    await instance.waitUntilExit();
    return 0;
  }

  if (command === 'login') {
    const address = readAddressArg(rest);
    const deviceName = readNameFlag(rest);
    if (address === undefined) {
      console.error('Give the address Aman is opened at, for example aman-tui login https://my-computer.example:8443');
      return 1;
    }
    try {
      await runLogin({
        configDir,
        addressInput: address,
        ...(deviceName === undefined ? {} : { deviceName }),
        deps: { print: (line: string) => console.log(line) },
      });
      return 0;
    } catch (error) {
      if (error instanceof PairingRefusedError) {
        console.error(error.serverMessage);
      } else if (error instanceof Error) {
        console.error(error.message);
      } else {
        console.error('Pairing did not work. Start pairing again with aman-tui login.');
      }
      return 1;
    }
  }

  if (command === 'instances') {
    const store = loadInstanceStore(configDir);
    if (store.instances.length === 0) {
      console.log('No instances are paired yet. Pair one with aman-tui login <address>.');
      return 0;
    }
    for (const instance of store.instances) {
      const marker = instance.address === store.activeAddress ? ' (active)' : '';
      console.log(`${instance.address}  paired as "${instance.deviceName}"${marker}`);
    }
    return 0;
  }

  if (command === 'use') {
    const addressInput = rest[0];
    const address = addressInput === undefined ? undefined : normalizeInstanceAddress(addressInput);
    const store = loadInstanceStore(configDir);
    const instance = address === undefined ? undefined : store.instances.find(saved => saved.address === address);
    if (instance === undefined) {
      console.error('That address is not paired with this terminal. See the paired ones with aman-tui instances.');
      return 1;
    }
    saveInstanceStore(configDir, { instances: store.instances, activeAddress: instance.address });
    console.log(`The active instance is now ${instance.address}.`);
    return 0;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return 0;
  }

  console.error(`aman-tui does not know the command "${command}".`);
  console.error(USAGE);
  return 1;
}

process.exitCode = await run(process.argv.slice(2));
