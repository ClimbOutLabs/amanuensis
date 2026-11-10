import { positionRanges } from '../../../../fixtures/memory/mayaWorld/positionRanges';

describe('positionRanges', () => {
  it('writes runs of three or more as ranges and the rest one by one', () => {
    expect(positionRanges([3, 4, 5, 9, 14, 15, 16, 17, 18, 19, 20])).toBe('3-5, 9, 14-20');
    expect(positionRanges([1, 2, 7])).toBe('1, 2, 7');
  });

  it('sorts first and gives an empty string for no positions', () => {
    expect(positionRanges([9, 3, 5, 4])).toBe('3-5, 9');
    expect(positionRanges([])).toBe('');
  });
});
