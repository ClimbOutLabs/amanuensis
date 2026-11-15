import { readFileSync } from 'node:fs';
const lines = readFileSync(process.argv[2], 'utf8').trim().split('\n');
for (const line of lines) {
  const r = JSON.parse(line);
  if (!r.case.startsWith('skills')) continue;
  console.log(`== ${r.case} step ${r.step}`);
  for (const t of r.turns) console.log('turn', t.id, t.status, JSON.stringify(t.required_actions ?? []).slice(0, 2500));
  for (const e of r.events) {
    const ev = e.event;
    if (ev.type === 'model.message' && ev.tool_calls) {
      for (const c of ev.tool_calls) {
        const { description, input_schema, ...info } = c.tool_info ?? {};
        console.log('call', e.turn_id, c.id, c.function?.name, JSON.stringify(info).slice(0, 3000));
      }
    } else if (String(ev.type).startsWith('tool.response')) console.log('result', e.turn_id, ev.tool_call_id, String(ev.content).slice(0, 600));
    else if (ev.type !== 'model.message' && ev.type !== 'model.message.delta') console.log('event', e.turn_id, ev.type, JSON.stringify(ev).slice(0, 1500));
  }
}
