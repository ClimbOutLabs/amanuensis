// The local model bridge: carries the app's model requests to a model server on this computer, over plumbing the
// instance owns. Two copies run. The host side dials the model at the port its owner named and listens only on a
// socket file in a volume the two copies share. The link side listens on the app's private network under the name
// aman-local-model and passes each connection to that socket. Nothing is published, so no other device and no other
// container reaches the model through it, and network changes on this computer (a new address, an update to
// Tailscale) cannot cut the app off from it.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT_PATTERN = /^[1-9][0-9]{3,4}$/;

/** The ports the owner named, from a comma-separated list. Anything else stops the bridge before it listens. */
export function parsePorts(raw) {
  const ports = (raw ?? '').split(',').filter(part => part !== '');
  if (ports.length === 0) {
    throw new Error('LOCAL_MODEL_PORTS names no port.');
  }
  for (const port of ports) {
    const value = Number(port);
    if (!PORT_PATTERN.test(port) || value < 1024 || value > 65535) {
      throw new Error(`LOCAL_MODEL_PORTS has ${port}, which is not a port from 1024 to 65535.`);
    }
  }
  return ports.map(Number);
}

export function socketPath({ socketDir, port }) {
  return path.join(socketDir, `${port}.sock`);
}

// One connection in, one connection out; either end closing or failing closes both.
function pipe({ incoming, connect }) {
  const outgoing = connect();
  const close = () => {
    incoming.destroy();
    outgoing.destroy();
  };
  incoming.on('error', close);
  outgoing.on('error', close);
  incoming.on('close', close);
  outgoing.on('close', close);
  incoming.pipe(outgoing).pipe(incoming);
}

function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(...args, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/**
 * Starts one side of the bridge for every port. The host side needs `target`, the address it dials the model at
 * (127.0.0.1 where Docker runs on this computer itself, host.docker.internal under Docker Desktop). The link side
 * listens on `listenHost`, all of its own addresses by default, which in the instance are its private network only.
 */
export async function startBridge({ side, ports, socketDir, target, listenHost }) {
  const servers = [];
  for (const port of ports) {
    const socket = socketPath({ socketDir, port });
    if (side === 'host') {
      if (!target) {
        throw new Error('LOCAL_MODEL_TARGET is needed on the host side.');
      }
      // A socket file left by an earlier run would stop the listen, and nothing else writes this folder.
      fs.rmSync(socket, { force: true });
      const server = net.createServer(incoming => pipe({ incoming, connect: () => net.connect(port, target) }));
      servers.push(await listen(server, socket));
    } else if (side === 'link') {
      const server = net.createServer(incoming => pipe({ incoming, connect: () => net.connect(socket) }));
      servers.push(await (listenHost === undefined ? listen(server, port) : listen(server, port, listenHost)));
    } else {
      throw new Error(`LOCAL_MODEL_SIDE is ${String(side)}; it must be host or link.`);
    }
  }
  return servers;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await startBridge({
      side: process.env.LOCAL_MODEL_SIDE,
      ports: parsePorts(process.env.LOCAL_MODEL_PORTS),
      socketDir: process.env.LOCAL_MODEL_SOCKETS ?? '/run/aman-local-model',
      target: process.env.LOCAL_MODEL_TARGET,
      listenHost: undefined,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
