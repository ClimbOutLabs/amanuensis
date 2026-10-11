import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', '..', '..', '..', '..', '..', 'ops', 'sandbox-slot', 'disks', 'setup-disks.sh');

function run(args: string[]): { status: number | null; stderr: string } {
  const result = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

describe('setup-disks.sh refuses unsafe input before it changes anything', () => {
  test.each([
    [['setup', 'relative/dir', '16', '4'], 'absolute path'],
    [['setup', '/var/lib/../etc', '16', '4'], 'letters, digits'],
    [['setup', '/var/lib/a b', '16', '4'], 'letters, digits'],
    [['setup', '/var/lib/$(id)', '16', '4'], 'letters, digits'],
    [['setup', '/var/lib/aman', 'sixteen', '4'], 'whole number'],
    [['setup', '/var/lib/aman', '0', '4'], '1 to 512'],
    [['setup', '/var/lib/aman', '16', '40'], '1 to 16'],
    [['remove', '/var/lib/aman', 'x'], 'must be a number'],
    [['unknown'], 'usage'],
  ])('%j', (args, message) => {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  test('only root may run it', () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const result = run(['setup', '/var/lib/aman', '16', '4']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must run as root');
  });
});
