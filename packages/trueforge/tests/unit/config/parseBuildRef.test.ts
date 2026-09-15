import { parseBuildRef, UNSTAMPED_BUILD_REF } from '../../../src/config';

describe('parseBuildRef', () => {
  it('falls back to the unstamped placeholder when BUILD_REF is unset', () => {
    expect(parseBuildRef(undefined)).toBe(UNSTAMPED_BUILD_REF);
  });

  it('treats blank as unset, which is what an unpassed Docker build arg leaves behind', () => {
    expect(parseBuildRef('')).toBe(UNSTAMPED_BUILD_REF);
    expect(parseBuildRef('   ')).toBe(UNSTAMPED_BUILD_REF);
  });

  it('trims a stamped reference', () => {
    expect(parseBuildRef(' 4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90 \n')).toBe(
      '4f2a91c8d3b7e6510a2c9f4b8d1e7a3c5b6d8e90',
    );
  });
});
