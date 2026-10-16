import { runCli } from './dispatch';
import { processIo } from './io';

process.exit(await runCli({ argv: process.argv.slice(2), io: processIo() }));
