import { describe, expect, it } from 'vitest';

import { describeDuration, describeTransitStep } from '@/utils/mapsTransitSteps.js';

describe('describeTransitStep', () => {
  it('words a walk to a stop and a walk to the destination', () => {
    expect(describeTransitStep({ kind: 'walk', duration_min: 4, to_name: 'Calhariz (Bica)' })).toBe(
      'Walk 4 min to Calhariz (Bica)',
    );
    expect(describeTransitStep({ kind: 'walk', duration_min: 3, to_name: null })).toBe('Walk 3 min');
  });

  it('words a tram ride with direction, stops and departure', () => {
    expect(
      describeTransitStep({
        kind: 'ride',
        vehicle: 'tram',
        line_name: '28E',
        headsign: 'Campo Ourique',
        from_name: 'Calhariz (Bica)',
        to_name: 'Estrela',
        departs: '09:02',
        arrives: '09:08',
        stops_count: 6,
      }),
    ).toBe('Tram 28E toward Campo Ourique, 6 stops, leaves 09:02');
  });

  it('leaves out the stop count when it is unknown', () => {
    expect(
      describeTransitStep({
        kind: 'ride',
        vehicle: 'tram',
        line_name: '28E',
        headsign: 'Campo Ourique',
        from_name: 'Calhariz (Bica)',
        to_name: 'Estrela',
        departs: '09:02',
        arrives: '09:08',
        stops_count: null,
      }),
    ).toBe('Tram 28E toward Campo Ourique, leaves 09:02');
  });

  it('handles a single stop, no direction and other vehicles', () => {
    expect(
      describeTransitStep({
        kind: 'ride',
        vehicle: 'metro',
        line_name: 'Azul',
        headsign: null,
        from_name: 'A',
        to_name: 'B',
        departs: '10:00',
        arrives: '10:03',
        stops_count: 1,
      }),
    ).toBe('Metro Azul, 1 stop, leaves 10:00');
    expect(
      describeTransitStep({
        kind: 'ride',
        vehicle: 'other',
        line_name: 'Gloria',
        headsign: null,
        from_name: 'A',
        to_name: 'B',
        departs: '10:00',
        arrives: '10:03',
        stops_count: 2,
      }),
    ).toBe('Line Gloria, 2 stops, leaves 10:00');
  });
});

describe('describeDuration', () => {
  it('rounds to whole minutes and switches to hours from sixty', () => {
    expect(describeDuration(23.7)).toBe('24 min');
    expect(describeDuration(60)).toBe('1 h');
    expect(describeDuration(125.2)).toBe('2 h 5 min');
  });
});
