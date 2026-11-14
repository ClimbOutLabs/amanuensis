import {
  HOME_ASSISTANT_REFUSAL,
  homeAssistantDeclaredChangeTools,
  homeAssistantDomainOfEntity,
  homeAssistantDomainsLabel,
  homeAssistantEntityLabel,
  homeAssistantGrantCoverage,
  homeAssistantGrantLabel,
  homeAssistantGrantScopeKey,
  homeAssistantTarget,
  homeAssistantTargetLabel,
  homeAssistantToolBase,
  homeAssistantToolPrefix,
  isHomeAssistantCallActionTool,
  isHomeAssistantDeclaredChangeTool,
  isHomeAssistantLiveContextTool,
  isHomeAssistantNameOnlyTarget,
  isHomeAssistantReadTool,
  isHomeAssistantRefusedTarget,
} from '../../../src/core/homeassistant/toolContract';

describe('Home Assistant tool names', () => {
  it('reads the bare tool name past a set prefix', () => {
    expect(homeAssistantToolBase('intent__HassTurnOn')).toBe('HassTurnOn');
    expect(homeAssistantToolBase('light__HassLightSet')).toBe('HassLightSet');
    expect(homeAssistantToolBase('HassTurnOff')).toBe('HassTurnOff');
    expect(homeAssistantToolPrefix('climate__HassClimateSetTemperature')).toBe('climate');
    expect(homeAssistantToolPrefix('HassTurnOff')).toBeNull();
  });

  it('knows the generic action tool under any prefix', () => {
    expect(isHomeAssistantCallActionTool('call_action')).toBe(true);
    expect(isHomeAssistantCallActionTool('homeassistant__call_action')).toBe(true);
    expect(isHomeAssistantCallActionTool('intent__call_action')).toBe(true);
    expect(isHomeAssistantCallActionTool('HassTurnOn')).toBe(false);
    expect(isHomeAssistantCallActionTool('homeassistant__GetLiveContext')).toBe(false);
  });

  it('captures the change tools from the server own tool list, by what each tool declares', () => {
    const declared = homeAssistantDeclaredChangeTools([
      { name: 'intent__HassTurnOn', annotations: { readOnlyHint: false } },
      { name: 'HassTurnOff', annotations: { readOnlyHint: false } },
      { name: 'light__HassLightSet', annotations: { readOnlyHint: false } },
      { name: 'GetLiveContext', annotations: { readOnlyHint: true } },
      { name: 'HassGetState', annotations: { readOnlyHint: true } },
      // No declaration either way: the server did not say, so the tool is not captured.
      { name: 'HassUndeclared' },
      { name: 'HassAlsoUndeclared', annotations: {} },
      // The same bare name under two prefixes is captured once.
      { name: 'media__HassMediaPlay', annotations: { readOnlyHint: false } },
      { name: 'HassMediaPlay', annotations: { readOnlyHint: false } },
    ]);
    expect(declared).toEqual(['HassTurnOn', 'HassTurnOff', 'HassLightSet', 'HassMediaPlay']);
  });

  it('reads grant eligibility from the stored declaration, never from the tool name', () => {
    const declared = homeAssistantDeclaredChangeTools([
      { name: 'intent__HassTurnOn', annotations: { readOnlyHint: false } },
      // An invented tool, in no list Aman ships: the server declares it a change, so it counts.
      { name: 'HassBrewCoffee', annotations: { readOnlyHint: false } },
    ]);
    expect(isHomeAssistantDeclaredChangeTool({ tool_name: 'HassTurnOn', declared_change_tools: declared })).toBe(true);
    expect(
      isHomeAssistantDeclaredChangeTool({ tool_name: 'intent__HassTurnOn', declared_change_tools: declared }),
    ).toBe(true);
    expect(isHomeAssistantDeclaredChangeTool({ tool_name: 'HassBrewCoffee', declared_change_tools: declared })).toBe(
      true,
    );
    // A name from the old shipped list earns nothing when the server did not declare it.
    expect(isHomeAssistantDeclaredChangeTool({ tool_name: 'HassLightSet', declared_change_tools: declared })).toBe(
      false,
    );
    expect(isHomeAssistantDeclaredChangeTool({ tool_name: 'HassTurnOn', declared_change_tools: [] })).toBe(false);
    expect(isHomeAssistantDeclaredChangeTool({ tool_name: 'GetLiveContext', declared_change_tools: declared })).toBe(
      false,
    );
  });

  it('knows the live-context tool under any prefix', () => {
    expect(isHomeAssistantLiveContextTool('GetLiveContext')).toBe(true);
    expect(isHomeAssistantLiveContextTool('homeassistant__GetLiveContext')).toBe(true);
    expect(isHomeAssistantLiveContextTool('HassTurnOn')).toBe(false);
  });

  it('treats the listed reads and any read-only tool as reads', () => {
    expect(isHomeAssistantReadTool({ tool_name: 'GetLiveContext', read_only_hint: undefined })).toBe(true);
    expect(isHomeAssistantReadTool({ tool_name: 'homeassistant__GetLiveContext', read_only_hint: undefined })).toBe(
      true,
    );
    expect(isHomeAssistantReadTool({ tool_name: 'HassGetState', read_only_hint: undefined })).toBe(true);
    expect(isHomeAssistantReadTool({ tool_name: 'GetDateTime', read_only_hint: undefined })).toBe(true);
    expect(isHomeAssistantReadTool({ tool_name: 'HassTurnOn', read_only_hint: true })).toBe(true);
    expect(isHomeAssistantReadTool({ tool_name: 'HassTurnOn', read_only_hint: false })).toBe(false);
    expect(isHomeAssistantReadTool({ tool_name: 'HassTurnOn', read_only_hint: undefined })).toBe(false);
  });
});

describe('Home Assistant targets', () => {
  it('reads the domain from an entity id', () => {
    expect(homeAssistantDomainOfEntity('light.living_room_lamp')).toBe('light');
    expect(homeAssistantDomainOfEntity('no-dot')).toBeNull();
    const target = homeAssistantTarget({
      tool_name: 'HassTurnOff',
      params: { entity_id: 'light.living_room_lamp' },
    });
    expect(target).toEqual({
      entity_id: 'light.living_room_lamp',
      entity_ids: ['light.living_room_lamp'],
      name: null,
      domain: 'light',
      domains: ['light'],
      device_class: null,
      device_classes: [],
      area: null,
      floor: null,
    });
  });

  it('reads domain and device class filters as whole lists, and area and floor as targets', () => {
    const target = homeAssistantTarget({
      tool_name: 'HassTurnOn',
      params: { domain: ['cover'], device_class: ['curtain', 'garage'], area: 'Garage' },
    });
    expect(target.domains).toEqual(['cover']);
    expect(target.device_classes).toEqual(['curtain', 'garage']);
    expect(target.area).toBe('Garage');
    const multi = homeAssistantTarget({
      tool_name: 'HassTurnOff',
      params: { domain: ['light', 'lock'], floor: 'Ground floor' },
    });
    expect(multi.domains).toEqual(['light', 'lock']);
    expect(multi.domain).toBe('light');
    expect(multi.floor).toBe('Ground floor');
  });

  it('reads name, domain and device class filters', () => {
    const target = homeAssistantTarget({
      tool_name: 'HassSetPosition',
      params: { name: 'Garage door', domain: ['cover'], device_class: 'garage' },
    });
    expect(target.domain).toBe('cover');
    expect(target.device_class).toBe('garage');
    expect(target.name).toBe('Garage door');
  });

  it('takes the domain from a set prefix when the arguments do not name one', () => {
    const target = homeAssistantTarget({ tool_name: 'light__HassLightSet', params: { name: 'Porch' } });
    expect(target.domain).toBe('light');
    const intent = homeAssistantTarget({ tool_name: 'intent__HassTurnOn', params: { name: 'Porch' } });
    expect(intent.domain).toBeNull();
  });
});

describe('Home Assistant refused targets', () => {
  it('refuses locks and alarm panels by domain', () => {
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { entity_id: 'lock.front_door' } }),
      ),
    ).toBe(true);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { entity_id: 'alarm_control_panel.home' } }),
      ),
    ).toBe(true);
  });

  it('refuses a garage cover but not a blind inside the home', () => {
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({
          tool_name: 'HassSetPosition',
          params: { entity_id: 'cover.garage_door', device_class: 'garage' },
        }),
      ),
    ).toBe(true);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({
          tool_name: 'HassSetPosition',
          params: { entity_id: 'cover.living_room_blinds', device_class: 'blind' },
        }),
      ),
    ).toBe(false);
  });

  it('refuses a garage cover that arrives with a name and a domain but no device class', () => {
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({
          tool_name: 'HassSetPosition',
          params: { name: 'Garage door', domain: ['cover'] },
        }),
      ),
    ).toBe(true);
  });

  it('refuses a garage cover that arrives by entity id alone, with no device class', () => {
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { entity_id: 'cover.garage_door' } }),
      ),
    ).toBe(true);
  });

  it('still asks for a cover inside the home that arrives with no device class', () => {
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({
          tool_name: 'HassSetPosition',
          params: { entity_id: 'cover.living_room_blinds' },
        }),
      ),
    ).toBe(false);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({
          tool_name: 'HassSetPosition',
          params: { name: 'Living room blinds', domain: ['cover'] },
        }),
      ),
    ).toBe(false);
  });

  it('refuses a name that says lock, alarm or garage when nothing names a domain', () => {
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { name: 'Front door lock' } }),
      ),
    ).toBe(true);
    expect(
      isHomeAssistantRefusedTarget(homeAssistantTarget({ tool_name: 'HassTurnOn', params: { name: 'Garage door' } })),
    ).toBe(true);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { name: 'Living room lamp' } }),
      ),
    ).toBe(false);
  });

  it('refuses a call that names a refused domain anywhere in its domain list', () => {
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOff', params: { domain: ['light', 'lock'] } }),
      ),
    ).toBe(true);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({
          tool_name: 'HassTurnOff',
          params: { entity_id: ['light.kitchen', 'lock.front_door'] },
        }),
      ),
    ).toBe(true);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOff', params: { domain: ['light', 'switch'] } }),
      ),
    ).toBe(false);
  });

  it('refuses a cover when any device class in its list leads outside, even beside an inside class', () => {
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({
          tool_name: 'HassTurnOn',
          params: { domain: ['cover'], device_class: ['curtain', 'garage'] },
        }),
      ),
    ).toBe(true);
  });

  it('refuses a cover scoped to an area or floor with no inside device class named', () => {
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { area: 'Garage', domain: ['cover'] } }),
      ),
    ).toBe(true);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { floor: 'Ground floor', domain: ['cover'] } }),
      ),
    ).toBe(true);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({
          tool_name: 'HassTurnOn',
          params: { area: 'Garage', domain: ['cover'], device_class: ['curtain'] },
        }),
      ),
    ).toBe(false);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { area: 'Garage', domain: ['light'] } }),
      ),
    ).toBe(false);
  });

  it('refuses an outside device class whatever domains the call names, even none', () => {
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { area: 'Garage', device_class: ['garage'] } }),
      ),
    ).toBe(true);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { device_class: ['gate'] } }),
      ),
    ).toBe(true);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { domain: ['light'], device_class: ['door'] } }),
      ),
    ).toBe(true);
  });

  it('refuses an area or floor call that names no domain, and still asks when it names another domain', () => {
    expect(
      isHomeAssistantRefusedTarget(homeAssistantTarget({ tool_name: 'HassTurnOn', params: { area: 'Garage' } })),
    ).toBe(true);
    expect(
      isHomeAssistantRefusedTarget(homeAssistantTarget({ tool_name: 'HassTurnOn', params: { floor: 'Ground floor' } })),
    ).toBe(true);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { area: 'Garage', domain: ['light'] } }),
      ),
    ).toBe(false);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { area: 'Garage', device_class: ['curtain'] } }),
      ),
    ).toBe(false);
    expect(
      isHomeAssistantRefusedTarget(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { area: 'Garage', entity_id: 'light.kitchen' } }),
      ),
    ).toBe(false);
  });

  it('keeps the refusal line the brief fixes', () => {
    expect(HOME_ASSISTANT_REFUSAL).toBe(
      'Aman does not control locks, alarms or garage doors. Do that in Home Assistant.',
    );
  });
});

describe('Home Assistant grant scopes and labels', () => {
  it('scopes a grant by domain first, then by the one entity', () => {
    const byDomain = homeAssistantTarget({ tool_name: 'HassTurnOn', params: { entity_id: 'light.kitchen' } });
    expect(homeAssistantGrantScopeKey(byDomain)).toBe('ha:domain:light');
    expect(homeAssistantGrantCoverage(byDomain)).toEqual([['ha:entity:light.kitchen', 'ha:domain:light']]);
    const bare = homeAssistantTarget({ tool_name: 'HassTurnOn', params: { area: 'Kitchen' } });
    expect(homeAssistantGrantScopeKey(bare)).toBeNull();
  });

  it('never scopes a grant by a plain name, so a name-only call is covered by no grant', () => {
    const byName = homeAssistantTarget({ tool_name: 'HassTurnOff', params: { name: 'Porch Light' } });
    expect(isHomeAssistantNameOnlyTarget(byName)).toBe(true);
    expect(homeAssistantGrantScopeKey(byName)).toBeNull();
    expect(homeAssistantGrantCoverage(byName)).toEqual([]);
    const byNameAndEntity = homeAssistantTarget({
      tool_name: 'HassTurnOff',
      params: { name: 'Porch Light', entity_id: 'light.porch' },
    });
    expect(isHomeAssistantNameOnlyTarget(byNameAndEntity)).toBe(false);
    expect(homeAssistantGrantCoverage(byNameAndEntity)).toEqual([['ha:entity:light.porch', 'ha:domain:light']]);
  });

  it('asks a grant to cover every target a call names, not only the first', () => {
    const twoDomains = homeAssistantTarget({
      tool_name: 'HassTurnOff',
      params: { domain: ['light', 'switch'] },
    });
    expect(homeAssistantGrantCoverage(twoDomains)).toEqual([['ha:domain:light'], ['ha:domain:switch']]);
    const twoEntities = homeAssistantTarget({
      tool_name: 'HassTurnOff',
      params: { entity_id: ['light.kitchen', 'switch.porch'] },
    });
    expect(homeAssistantGrantCoverage(twoEntities)).toEqual([
      ['ha:entity:light.kitchen', 'ha:domain:light'],
      ['ha:entity:switch.porch', 'ha:domain:switch'],
    ]);
  });

  it('says entity ids and grant keys in plain words', () => {
    expect(homeAssistantEntityLabel('light.living_room_lamp')).toBe('Living room lamp');
    expect(homeAssistantGrantLabel('ha:domain:light')).toBe('All Lights');
    expect(homeAssistantGrantLabel('ha:domain:media_player')).toBe('All Media players');
    expect(homeAssistantGrantLabel('ha:entity:light.living_room_lamp')).toBe('Living room lamp');
    expect(homeAssistantGrantLabel('HassTurnOn')).toBeNull();
  });

  it('names every entity a call names in its card label, counting the rest past three', () => {
    expect(
      homeAssistantTargetLabel(
        homeAssistantTarget({ tool_name: 'HassTurnOn', params: { entity_id: ['light.a', 'light.b'] } }),
      ),
    ).toBe('A and B');
    expect(
      homeAssistantTargetLabel(
        homeAssistantTarget({
          tool_name: 'HassTurnOn',
          params: { entity_id: ['light.kitchen', 'light.porch', 'light.hallway'] },
        }),
      ),
    ).toBe('Kitchen, Porch and Hallway');
    expect(
      homeAssistantTargetLabel(
        homeAssistantTarget({
          tool_name: 'HassTurnOn',
          params: { entity_id: ['light.kitchen', 'light.porch', 'light.hallway', 'switch.den'] },
        }),
      ),
    ).toBe('Kitchen, Porch and 2 more');
  });

  it('says several domains in plain words, and one domain not at all', () => {
    expect(homeAssistantDomainsLabel(['light'])).toBeNull();
    expect(homeAssistantDomainsLabel(['light', 'switch'])).toBe('the lights and switches');
    expect(homeAssistantDomainsLabel(['light', 'switch', 'fan', 'cover'])).toBe('the lights and switches and 2 more');
  });
});
