// Stand-in model for proving the skill cases' setup: it adds, runs and removes a skill with fixed tool calls.
import fs from 'node:fs';
import http from 'node:http';

const LOG = process.env.STUB_LOG ?? 'stub.log';
const HN_SCRIPT = [
  'import json, urllib.request',
  'def get(u):',
  '    return json.load(urllib.request.urlopen(u, timeout=20))',
  "ids = get('https://hacker-news.firebaseio.com/v0/topstories.json')[:5]",
  "print('\\n'.join(get(f'https://hacker-news.firebaseio.com/v0/item/{i}.json')['title'] for i in ids))",
].join('\n');

const text = m => (typeof m.content === 'string' ? m.content : (m.content ?? []).map(p => p.text ?? '').join(''));

function toolName(tools, want) {
  const names = tools.map(t => t.function?.name ?? t.name).filter(Boolean);
  return names.find(n => n === want) ?? names.find(n => n.endsWith(`__${want}`) || n.endsWith(`.${want}`) || n.endsWith(`_${want}`));
}

function decide(body) {
  const msgs = body.messages ?? [];
  const tools = body.tools ?? [];
  if (tools.length === 0) {
    const all = msgs.map(text).join('\n');
    return { content: all.includes('{"facts"') ? '{"facts":[]}' : '{"items":[]}' };
  }
  const lastUser = msgs.findLastIndex(m => m.role === 'user' && !text(m).startsWith('<tfy-internal>'));
  const ask = text(msgs[lastUser] ?? {});
  const results = msgs.slice(lastUser + 1).filter(m => m.role === 'tool').map(text);
  if (results.length > 0 && /approv|card|denied|declined/i.test(results.at(-1)) && results.length < 4) { /* keep going */ }
  const call = (name, args) => {
    const real = toolName(tools, name);
    return real === undefined
      ? { content: `No ${name} tool offered. Tools: ${tools.map(t => t.function?.name).join(', ')}` }
      : { tool: { name: real, args } };
  };
  const added = /add the skill at (\S+)/i.exec(ask);
  if (added) {
    return results.length === 0 ? call('install_skill', { url: added[1] }) : { content: `Added. ${results.at(-1).slice(0, 300)}` };
  }
  if (/remove/i.test(ask)) {
    if (results.length === 0) return call('list_skills', {});
    if (results.length === 1) {
      const name = /"name":"([^"]*(?:weather|hacker)[^"]*)"/i.exec(results[0])?.[1];
      return name === undefined ? { content: `No skill to remove: ${results[0].slice(0, 300)}` } : call('remove_skill', { name });
    }
    return { content: `Removed. ${results.at(-1).slice(0, 300)}` };
  }
  if (/weather/i.test(ask)) {
    return results.length === 0
      ? call('exec', { intent: 'Check the weather in Lisbon', purpose: 'execute', command: 'curl -s https://wttr.in/Lisbon?format=3' })
      : { content: results.at(-1).slice(0, 1500) };
  }
  if (/hacker news/i.test(ask)) {
    if (results.length === 0) return call('write_file', { intent: 'Save a script that reads the Hacker News front page', path: 'hn.py', content: HN_SCRIPT });
    if (results.length === 1) return call('exec', { intent: 'Read the Hacker News front page', purpose: 'execute', command: 'python3 hn.py' });
    return { content: results.at(-1).slice(0, 1500) };
  }
  return { content: 'Done.' };
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', d => (raw += d));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {}
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'stub/model-a' }] }));
        return;
      }
      const out = decide(body);
      fs.appendFileSync(LOG, `${JSON.stringify({ last: text((body.messages ?? []).at(-1) ?? {}).slice(0, 300), out })}\n`);
      const usage = { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 };
      const toolCalls = out.tool
        ? [{ index: 0, id: `call_${Date.now()}`, type: 'function', function: { name: out.tool.name, arguments: JSON.stringify(out.tool.args) } }]
        : undefined;
      const message = { role: 'assistant', content: out.content ?? '', ...(toolCalls ? { tool_calls: toolCalls } : {}) };
      const finish = toolCalls ? 'tool_calls' : 'stop';
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage }));
      }
    });
  })
  .listen(9999);
