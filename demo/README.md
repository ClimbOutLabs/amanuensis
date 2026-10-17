# Demo

Everything used to stage and run the hackathon demo: the invented mailbox for the Maya persona, the scripts that load it, the script for the day and the hosting runbook.

- `demo-script.md`: the beat-by-beat script for the judges.
- `deploy-nebius.md`: runbook for a hosted judges' instance on Nebius.
- `fixtures/mailbox/`: the invented `.eml` files, their generator, expectations and attachments.
- `scripts/`: `pnpm send-test-mailbox` (SMTP delivery) and `pnpm demo:import-mailbox` (Gmail import).
