/**
 * The server emits `aman.skill.used` (host skill-telemetry) when an agent reads
 * or executes inside a mounted skill. The checked-in SDK union predates this
 * event, so the vendor type cannot name it; compare via the widened string
 * type instead of the narrow union to avoid a no-overlap error.
 *
 * Single canonical owner for this check (AGENTS.md): `chatServer.ts` and
 * `toUiTurnState.ts` both import it from here instead of defining their own.
 */
export function isSkillUsedEvent(event: { type: string }): boolean {
  return event.type === 'aman.skill.used';
}
