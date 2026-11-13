import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

  test('retire removes only the disks past the slots kept, and never a slot past 4', () => {
    if (process.getuid?.() !== 0) {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), 'aman-disks-'));
    const fstab = join(dir, 'fstab');
    const lines: string[] = [];
    for (const slot of [3, 4, 5]) {
      writeFileSync(join(dir, `ws-${String(slot)}.img`), '');
      mkdirSync(join(dir, `ws-${String(slot)}`));
      lines.push(`# aman-sandbox-slots: ${dir}/ws-${String(slot)}.img`);
      lines.push(`${dir}/ws-${String(slot)}.img ${dir}/ws-${String(slot)} ext4 loop 0 0`);
    }
    writeFileSync(fstab, `${lines.join('\n')}\n`);
    const result = spawnSync('sh', [SCRIPT, 'retire', dir, '2'], {
      encoding: 'utf8',
      env: { ...process.env, AMAN_SLOTS_FSTAB: fstab },
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, 'ws-3.img'))).toBe(false);
    expect(existsSync(join(dir, 'ws-4.img'))).toBe(false);
    // No install ever had a slot 5, so its disk is not this script's to remove.
    expect(existsSync(join(dir, 'ws-5.img'))).toBe(true);
  });
});
