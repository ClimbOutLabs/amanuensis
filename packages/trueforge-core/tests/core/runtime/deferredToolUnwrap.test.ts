import { tryUnwrapCallToolInput } from '../../../src/core/runtime/DeferredTool';

describe('tryUnwrapCallToolInput', () => {
  test('returns the inner input for a well-formed call_tool wrapper', () => {
    const inner = { path: '/tmp/f.txt', content: 'hello' };
    const unwrapped = tryUnwrapCallToolInput({
      mcp_server: 'fs',
      tool_name: 'write_file',
      input: inner,
    });
    expect(unwrapped).toEqual(inner);
  });

  test('returns the default empty input when the wrapper omits it', () => {
    const unwrapped = tryUnwrapCallToolInput({
      mcp_server: 'fs',
      tool_name: 'list_dir',
    });
    expect(unwrapped).toEqual({});
  });

  test('returns undefined when the wrapper is missing required fields', () => {
    expect(tryUnwrapCallToolInput({ tool_name: 'write_file', input: {} })).toBeUndefined();
    expect(tryUnwrapCallToolInput({ mcp_server: 'fs', input: {} })).toBeUndefined();
  });

  test('returns undefined when the wrapper arguments are not an object shape at all', () => {
    expect(tryUnwrapCallToolInput({})).toBeUndefined();
    expect(tryUnwrapCallToolInput({ mcp_server: 42, tool_name: 'x', input: {} })).toBeUndefined();
  });

  test('round-trips the same inner input the mint path classified over', () => {
    // DeferredTool.toolCallInfo unwraps with the same callToolSchema: the
    // verifier must hash exactly the input the classifier saw.
    const wrapperArgs = {
      mcp_server: 'fs',
      tool_name: 'read_file',
      input: { path: '/etc/hosts', offset: 0 },
      extra_wire_field: 'ignored-by-schema',
    };
    const unwrapped = tryUnwrapCallToolInput(wrapperArgs);
    expect(unwrapped).toEqual({ path: '/etc/hosts', offset: 0 });
  });
});
