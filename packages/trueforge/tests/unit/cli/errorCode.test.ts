import { errorCode } from '../../../src/cli/errorCode';

describe('errorCode', () => {
  it('reads a string code from any object, including errors from another realm', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT');
    expect(errorCode({ code: 'SQLITE_BUSY' })).toBe('SQLITE_BUSY');
  });

  it('ignores codes that are not strings and values that are not objects', () => {
    expect(errorCode({ code: 13 })).toBeUndefined();
    expect(errorCode({})).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode('ENOENT')).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
  });
});
