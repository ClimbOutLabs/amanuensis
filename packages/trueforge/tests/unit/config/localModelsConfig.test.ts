import { parseLocalModelPorts, parseThisComputerAddresses } from '../../../src/config';

describe('THIS_COMPUTER_ADDRESSES', () => {
  it('is empty when unset or blank', () => {
    expect(parseThisComputerAddresses(undefined)).toEqual([]);
    expect(parseThisComputerAddresses(' , ')).toEqual([]);
  });

  it('keeps each address once, lowercase', () => {
    expect(parseThisComputerAddresses('127.0.0.1, Spark.Example.TS.net,127.0.0.1')).toEqual([
      '127.0.0.1',
      'spark.example.ts.net',
    ]);
  });
});

describe('LOCAL_MODEL_PORTS', () => {
  it('is empty when unset or blank', () => {
    expect(parseLocalModelPorts(undefined)).toEqual([]);
    expect(parseLocalModelPorts('')).toEqual([]);
  });

  it('reads each port once', () => {
    expect(parseLocalModelPorts('30031, 11434,30031')).toEqual([30031, 11434]);
  });

  it.each(['80', '65536', '0123', 'abc', '30031:1'])('fails the boot on %s, naming it', entry => {
    expect(() => parseLocalModelPorts(`11434,${entry}`)).toThrow(`got: ${entry}`);
  });
});
