import {
  SLOT_SKILL_NETWORK_GUEST_PORT,
  SlotExecRequestSchema,
  SlotRunCodeRequestSchema,
} from '../../../../src/core/sandbox/slots/slotContract';

const EXEC_BASE = {
  session_id: 'a'.repeat(32),
  argv: ['bash', '-c', 'curl https://github.com'],
  cwd: '/workspace',
  env: {},
  timeout_ms: 1_000,
  disk_mb: 128,
};

describe('the slot contract for skill network grants', () => {
  it('exec requests carry a skill network token of the grant shape', () => {
    const parsed = SlotExecRequestSchema.parse({ ...EXEC_BASE, skill_network_token: 'b'.repeat(32) });
    expect(parsed.skill_network_token).toBe('b'.repeat(32));
    expect(SlotExecRequestSchema.safeParse({ ...EXEC_BASE, skill_network_token: 'not-a-token' }).success).toBe(false);
    expect(SlotExecRequestSchema.parse(EXEC_BASE).skill_network_token).toBeUndefined();
  });

  it('run code requests have no skill network field at all: run code stays offline', () => {
    expect(Object.keys(SlotRunCodeRequestSchema.shape)).not.toContain('skill_network_token');
    const parsed = SlotRunCodeRequestSchema.parse({
      run_id: 'c'.repeat(32),
      argv: ['python3', '-c', 'print(1)'],
      files_in: [],
      timeout_ms: 1_000,
      disk_mb: 128,
      skill_network_token: 'b'.repeat(32),
    });
    expect(parsed).not.toHaveProperty('skill_network_token');
  });

  it('the guest port is the one the agent listens on', () => {
    expect(SLOT_SKILL_NETWORK_GUEST_PORT).toBe(18772);
  });
});
