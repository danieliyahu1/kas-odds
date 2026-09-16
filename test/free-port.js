import { createServer } from 'node:net';

// Reserve OS-assigned free ports for a test's listeners. Tests that spawn a real
// server used to pick from shared fixed ranges, which collided when several test
// files ran in parallel on a busy CI runner. Ephemeral ports remove that class of
// flake. All ports are held open at once, so the returned set is collision-free.
export async function freePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      servers.push(await listen());
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(servers.map(close));
  }
}

function listen() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
