import {
  HOME_ASSISTANT_REFUSAL,
  homeAssistantDomainOfEntity,
  homeAssistantEntityLabel,
  homeAssistantGrantLabel,
  homeAssistantGrantScopeKey,
  homeAssistantGrantScopeKeys,
  homeAssistantTarget,
  homeAssistantToolBase,
  homeAssistantToolPrefix,
  isHomeAssistantLiveContextTool,
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
    expect(target).toEqual({ entity_id: 'light.living_room_lamp', name: null, domain: 'light', device_class: null });
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
    expect(homeAssistantGrantScopeKeys(byDomain)).toEqual(['ha:entity:light.kitchen', 'ha:domain:light']);
    const byName = homeAssistantTarget({ tool_name: 'HassTurnOff', params: { name: 'Porch Light' } });
    expect(homeAssistantGrantScopeKey(byName)).toBe('ha:entity:porch light');
    const bare = homeAssistantTarget({ tool_name: 'HassTurnOn', params: { area: 'Kitchen' } });
    expect(homeAssistantGrantScopeKey(bare)).toBeNull();
  });

  it('says entity ids and grant keys in plain words', () => {
    expect(homeAssistantEntityLabel('light.living_room_lamp')).toBe('Living room lamp');
    expect(homeAssistantGrantLabel('ha:domain:light')).toBe('All Lights');
    expect(homeAssistantGrantLabel('ha:domain:media_player')).toBe('All Media players');
    expect(homeAssistantGrantLabel('ha:entity:light.living_room_lamp')).toBe('Living room lamp');
    expect(homeAssistantGrantLabel('HassTurnOn')).toBeNull();
  });
});
