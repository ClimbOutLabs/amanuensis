import { localModelBridgePortMessage, placeOfModelHost } from '../../../src/runtime/localModels';

describe('placeOfModelHost', () => {
  it('tells the local link apart from every other address', () => {
    expect(placeOfModelHost('aman-local-model')).toBe('local_link');
    expect(placeOfModelHost('AMAN-LOCAL-MODEL.')).toBe('local_link');
    expect(placeOfModelHost('spark.example.ts.net')).toBe('elsewhere');
    expect(placeOfModelHost('192.168.1.20')).toBe('elsewhere');
    expect(placeOfModelHost('host.docker.internal')).toBe('elsewhere');
  });
});

describe('localModelBridgePortMessage', () => {
  it('names the command that adds the port', () => {
    expect(localModelBridgePortMessage('http://aman-local-model:30031/v1')).toBe(
      "Aman's local link does not carry port 30031 yet. On the computer Aman runs on, run aman local-model 30031. Then try again.",
    );
  });

  it('asks for a port when the address has none', () => {
    expect(localModelBridgePortMessage('http://aman-local-model/v1')).toContain(
      "Add your model server's port to the address",
    );
  });

  it('says nothing about any other address', () => {
    expect(localModelBridgePortMessage('http://192.168.1.20:11434/v1')).toBeUndefined();
    expect(localModelBridgePortMessage('not a url')).toBeUndefined();
  });
});
