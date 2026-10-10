import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Owner {
  uid: number;
  gid: number;
}

const READ = 4;
const WRITE = 2;
const SEARCH = 1;

/** The kernel's discretionary check for a capability-less (non-root, no CAP_DAC_OVERRIDE) user. */
function permits(input: { user: Owner; owner: Owner; mode: number; want: number }): boolean {
  let bits = input.mode & 0o7;
  if (input.user.uid === input.owner.uid) {
    bits = (input.mode >> 6) & 0o7;
  } else if (input.user.gid === input.owner.gid) {
    bits = (input.mode >> 3) & 0o7;
  }
  return (bits & input.want) === input.want;
}

interface FakeContainer {
  user: Owner;
  /** Container path of each bind mount -> host dir behind it. */
  mounts: Map<string, string>;
}

/**
 * Stand-in for the daemon plus a container running the readiness canary. Unlike
 * a script that always succeeds, it denies what the kernel would: a container
 * uid that is neither the owner nor allowed by the group/other bits of a 0700
 * run dir cannot use it.
 *
 * Ownership of staged paths is the real one (stat) unless `server` is set, in
 * which case paths belong to that simulated server uid:gid until a recorded
 * chown says otherwise; this lets one test process act as any server uid.
 */
export class FakeSandboxContainers {
  private readonly server: Owner | undefined;
  private readonly chowned = new Map<string, Owner>();
  private readonly containers = new Map<string, FakeContainer>();

  constructor(server: Owner | undefined) {
    this.server = server;
  }

  recordChown(input: { path: string; owner: Owner }): void {
    this.chowned.set(input.path, input.owner);
  }

  /** Registers a `docker create`'s user and bind mounts; returns the container id. */
  create(args: string[]): string {
    const id = `fake-container-${String(this.containers.size + 1)}`;
    const mounts = new Map<string, string>();
    let user: Owner = { uid: 0, gid: 0 };
    for (let i = 0; i < args.length; i += 1) {
      const value = args[i + 1];
      if (args[i] === '--user' && value !== undefined) {
        const [uid, gid] = value.split(':');
        user = { uid: Number(uid), gid: Number(gid) };
      }
      if (args[i] === '-v' && value !== undefined) {
        const [hostDir, containerDir] = value.split(':');
        if (hostDir !== undefined && containerDir !== undefined) {
          mounts.set(containerDir, hostDir);
        }
      }
    }
    this.containers.set(id, { user, mounts });
    return id;
  }

  /** Runs the canary program; resolves with the container exit code. */
  async attach(input: { containerId: string; onStderr: (chunk: Buffer) => void }): Promise<number> {
    const container = this.containers.get(input.containerId);
    const ingress = container?.mounts.get('/ingress');
    const scratch = container?.mounts.get('/scratch');
    const egress = container?.mounts.get('/egress');
    if (container === undefined || ingress === undefined || scratch === undefined || egress === undefined) {
      return 0;
    }
    const isDenied = async (check: { path: string; want: number; containerPath: string }): Promise<boolean> => {
      const { path, want, containerPath } = check;
      const info = await stat(path);
      const owner = this.chowned.get(path) ?? this.server ?? { uid: info.uid, gid: info.gid };
      const allowed = permits({ user: container.user, owner, mode: info.mode, want });
      if (!allowed) {
        input.onStderr(Buffer.from(`PermissionError: [Errno 13] Permission denied: '${containerPath}'\n`));
      }
      return !allowed;
    };
    const inFile = join(ingress, 'canary_in');
    if (
      (await isDenied({ path: ingress, want: SEARCH, containerPath: '/ingress' })) ||
      (await isDenied({ path: inFile, want: READ, containerPath: '/ingress/canary_in' }))
    ) {
      return 1;
    }
    const data = await readFile(inFile);
    if (
      (await isDenied({ path: scratch, want: WRITE | SEARCH, containerPath: '/scratch/sub' })) ||
      (await isDenied({ path: egress, want: WRITE | SEARCH, containerPath: '/egress/out' }))
    ) {
      return 1;
    }
    await mkdir(join(scratch, 'sub'));
    await writeFile(join(scratch, 'sub', 'f'), data);
    await writeFile(join(egress, 'out'), data);
    return 0;
  }
}
