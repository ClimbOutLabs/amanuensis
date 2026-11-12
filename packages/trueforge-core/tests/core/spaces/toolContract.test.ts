import {
  isSpaceContentWriteToolName,
  isSpaceWriteToolName,
  SPACE_WRITE_TOOL_NAMES,
} from '../../../src/core/spaces/toolContract';

describe('space write tools', () => {
  it('counts create, edit and restore as content changes', () => {
    for (const name of ['create_space', 'edit_space', 'revert_space']) {
      expect(isSpaceContentWriteToolName(name)).toBe(true);
    }
  });

  it('keeps filing a space in a folder a write that changes no content', () => {
    expect(isSpaceWriteToolName('move_space')).toBe(true);
    expect(isSpaceContentWriteToolName('move_space')).toBe(false);
  });

  it('never counts a read or an unknown tool as a content change', () => {
    expect(isSpaceContentWriteToolName('get_space')).toBe(false);
    expect(isSpaceContentWriteToolName('not_a_space_tool')).toBe(false);
    for (const name of SPACE_WRITE_TOOL_NAMES) {
      expect(isSpaceWriteToolName(name)).toBe(true);
    }
  });
});
