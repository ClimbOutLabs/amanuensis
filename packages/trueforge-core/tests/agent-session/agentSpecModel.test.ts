import { OpenAPIHono } from '@hono/zod-openapi';
import { AgentSpecSchema } from '../../src/agent-session/schemas/agentSpec';

describe('AgentSpecSchema model.name', () => {
  it('accepts opaque non-empty identifiers including non-FQN shapes', () => {
    expect(AgentSpecSchema.parse({ model: { name: 'gpt-4' } }).model.name).toBe('gpt-4');
    expect(AgentSpecSchema.parse({ model: { name: 'provider/model' } }).model.name).toBe('provider/model');
    expect(AgentSpecSchema.parse({ model: { name: 'a/b/c' } }).model.name).toBe('a/b/c');
  });

  it('rejects empty model.name', () => {
    const result = AgentSpecSchema.safeParse({ model: { name: '' } });
    expect(result.success).toBe(false);
  });

  it('keeps auxiliary role model properties as flat references to Model', () => {
    const app = new OpenAPIHono();
    app.openAPIRegistry.register('AgentSpec', AgentSpecSchema);
    const document = app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'test', version: '0' } });
    const components = document.components?.schemas ?? {};
    const auxiliary = components['AuxiliaryModels'];
    if (auxiliary === undefined || typeof auxiliary !== 'object' || !('properties' in auxiliary)) {
      throw new Error('AuxiliaryModels was not emitted as an object schema');
    }
    const properties = auxiliary.properties as Record<string, unknown>;
    expect(properties['compaction']).toEqual({ $ref: '#/components/schemas/Model' });
    expect(properties['delegation']).toEqual({ $ref: '#/components/schemas/Model' });
    expect(Object.keys(components).filter(name => name.startsWith('AuxiliaryModels'))).toEqual(['AuxiliaryModels']);
  });
});
