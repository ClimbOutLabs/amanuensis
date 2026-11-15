// Gives commands such as the doctor the keys this instance keeps encrypted, as the server gets them.
import '../secrets/savedEnvStart';

import { runCli } from './dispatch';
import { processIo } from './io';

process.exit(await runCli({ argv: process.argv.slice(2), io: processIo() }));
