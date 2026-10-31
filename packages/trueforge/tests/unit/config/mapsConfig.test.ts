/**
 * Maps config: MAPS_* URLs are parsed at boot and fail fast on invalid values.
 * These tests exercise the parsing helpers via the config module shape.
 */
describe('maps config', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  async function loadConfig(): Promise<typeof import('../../../src/config').default> {
    const mod = await import('../../../src/config');
    return mod.default;
  }

  it('uses public defaults when unset', async () => {
    delete process.env['MAPS_GEOCODER_URL'];
    delete process.env['MAPS_ROUTER_URL'];
    delete process.env['MAPS_TILE_URL'];
    delete process.env['MAPS_USER_AGENT'];
    delete process.env['MAPS_ROUTER_PROVIDER'];
    const config = await loadConfig();
    expect(config.MAPS_GEOCODER_URL).toBe('https://nominatim.openstreetmap.org');
    expect(config.MAPS_ROUTER_URL).toBe('https://router.project-osrm.org');
    expect(config.MAPS_TILE_URL).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(config.MAPS_ROUTER_PROVIDER).toBe('osrm');
    expect(config.MAPS_USER_AGENT).toMatch(/^Amanuensis\//);
  });

  it('says which maps URLs came from the environment', async () => {
    delete process.env['MAPS_GEOCODER_URL'];
    delete process.env['MAPS_WALKING_ROUTER_URL'];
    delete process.env['MAPS_CYCLING_ROUTER_URL'];
    delete process.env['MAPS_TRANSIT_URL'];
    delete process.env['MAPS_TILE_URL'];
    process.env['MAPS_ROUTER_URL'] = 'https://routes.example.internal';
    const config = await loadConfig();
    expect(config.MAPS_URL_FROM_ENV).toEqual({
      MAPS_GEOCODER_URL: false,
      MAPS_ROUTER_URL: true,
      MAPS_WALKING_ROUTER_URL: false,
      MAPS_CYCLING_ROUTER_URL: false,
      MAPS_TRANSIT_URL: false,
      MAPS_TILE_URL: false,
    });
  });

  it('treats a blank maps URL environment variable as unset', async () => {
    process.env['MAPS_ROUTER_URL'] = '   ';
    const config = await loadConfig();
    expect(config.MAPS_URL_FROM_ENV.MAPS_ROUTER_URL).toBe(false);
    expect(config.MAPS_ROUTER_URL).toBe('https://router.project-osrm.org');
  });

  it('defaults the walking, cycling and transit services', async () => {
    delete process.env['MAPS_WALKING_ROUTER_URL'];
    delete process.env['MAPS_CYCLING_ROUTER_URL'];
    delete process.env['MAPS_TRANSIT_URL'];
    const config = await loadConfig();
    expect(config.MAPS_WALKING_ROUTER_URL).toBe('https://routing.openstreetmap.de/routed-foot');
    expect(config.MAPS_CYCLING_ROUTER_URL).toBe('https://routing.openstreetmap.de/routed-bike');
    expect(config.MAPS_TRANSIT_URL).toBe('https://api.transitous.org/api/v6');
  });

  it('accepts custom travel service URLs and trims a trailing slash', async () => {
    process.env['MAPS_WALKING_ROUTER_URL'] = 'https://foot.example.internal/';
    process.env['MAPS_CYCLING_ROUTER_URL'] = 'https://bike.example.internal';
    process.env['MAPS_TRANSIT_URL'] = 'https://transit.example.internal/api/v6/';
    const config = await loadConfig();
    expect(config.MAPS_WALKING_ROUTER_URL).toBe('https://foot.example.internal');
    expect(config.MAPS_CYCLING_ROUTER_URL).toBe('https://bike.example.internal');
    expect(config.MAPS_TRANSIT_URL).toBe('https://transit.example.internal/api/v6');
  });

  it('rejects an invalid travel service URL', async () => {
    process.env['MAPS_TRANSIT_URL'] = 'not a url';
    await expect(loadConfig()).rejects.toThrow('MAPS_TRANSIT_URL must be a valid URL');
    process.env['MAPS_TRANSIT_URL'] = 'https://transit.example/api?key=1';
    await expect(loadConfig()).rejects.toThrow('MAPS_TRANSIT_URL must not include a query or hash');
  });

  it('accepts custom http(s) URLs', async () => {
    process.env['MAPS_GEOCODER_URL'] = 'https://geocode.example.internal/';
    process.env['MAPS_ROUTER_URL'] = 'https://routes.example.internal';
    const config = await loadConfig();
    expect(config.MAPS_GEOCODER_URL).toBe('https://geocode.example.internal');
    expect(config.MAPS_ROUTER_URL).toBe('https://routes.example.internal');
  });

  it.each(['MAPS_GEOCODER_URL', 'MAPS_ROUTER_URL', 'MAPS_TILE_URL'])(
    'refuses plain http for %s off loopback',
    async key => {
      const suffix = key === 'MAPS_TILE_URL' ? '/{z}/{x}/{y}.png' : '';
      process.env[key] = `http://maps.example.internal${suffix}`;
      await expect(loadConfig()).rejects.toThrow(`${key} must use https`);
    },
  );

  it.each([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://127.1.2.3',
    'http://[::1]:8080',
    'http://LOCALHOST:8080',
    'http://[::ffff:127.0.0.1]:8080',
  ])('allows plain http on loopback: %s', async url => {
    process.env['MAPS_GEOCODER_URL'] = url;
    const config = await loadConfig();
    expect(config.MAPS_GEOCODER_URL).toBe(url);
  });

  it('does not treat lookalike hosts as loopback', async () => {
    process.env['MAPS_GEOCODER_URL'] = 'http://localhost.evil.example';
    await expect(loadConfig()).rejects.toThrow('must use https');
    process.env['MAPS_GEOCODER_URL'] = 'http://127.0.0.1.evil.example';
    await expect(loadConfig()).rejects.toThrow('must use https');
  });

  it('rejects non-http(s) URLs', async () => {
    process.env['MAPS_GEOCODER_URL'] = 'ftp://example.com';
    await expect(loadConfig()).rejects.toThrow('MAPS_GEOCODER_URL must be an http(s) URL');
  });

  it('rejects URLs with query or hash', async () => {
    process.env['MAPS_TILE_URL'] = 'https://tiles.example/{z}/{x}/{y}.png?key=abc';
    await expect(loadConfig()).rejects.toThrow('MAPS_TILE_URL must not include a query or hash');
  });

  it('rejects a tile URL missing a placeholder', async () => {
    process.env['MAPS_TILE_URL'] = 'https://tiles.example/{z}/{x}/tile.png';
    await expect(loadConfig()).rejects.toThrow('MAPS_TILE_URL must include the {y} placeholder');
  });

  it('rejects unknown router providers', async () => {
    process.env['MAPS_ROUTER_PROVIDER'] = 'trafficorp';
    await expect(loadConfig()).rejects.toThrow('MAPS_ROUTER_PROVIDER must be "osrm"');
  });
});
