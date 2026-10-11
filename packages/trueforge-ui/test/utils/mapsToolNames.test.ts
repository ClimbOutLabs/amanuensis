import { MAPS_TOOL_NAMES } from '@truefoundry/trueforge-core/core';
import { describe, expect, it } from 'vitest';

import { MAPS_TOOL_NAMES as UI_MAPS_TOOL_NAMES } from '@/utils/toolCallParsing.js';

describe('maps tool names', () => {
  it('mirror the canonical list owned by trueforge-core', () => {
    expect([...UI_MAPS_TOOL_NAMES].sort()).toEqual([...MAPS_TOOL_NAMES].sort());
  });
});
