// Builds a fixed, invented transit report of about 80,000 characters (roughly 20,000 tokens).
// A seeded generator picks words from fixed lists, so every call returns the same text.

const SECTION_TOPICS = [
  'Ridership on the harbour line',
  'Ferry connections at Quayside',
  'Track condition on the north spur',
  'Signal upgrades at Millbrook',
  'Staffing and shift patterns',
  'Fare collection and ticket sales',
  'Accessibility at the platform edges',
  'Night service pilot results',
  'Bicycle storage at each stop',
  'Noise complaints near the rail yard',
  'Weather closures and delays',
  'Depot maintenance schedule',
  'Rolling stock age and replacement',
  'Customer feedback from the summer survey',
  'Park and ride capacity',
  'Bus feeder routes',
  'Energy use at the substations',
  'Lighting and station safety',
  'Freight sharing agreement',
  'Community meetings and outreach',
  'Contract terms with the operator',
  'Pilot results for the tram loop',
  'Risk register for the next three years',
  'Lessons from the Harbour Bridge closure',
  'Summary of recommendations',
];

const SUBJECTS = [
  'The harbour team',
  'The operations office in Kelvinton',
  'The Millbrook signal crew',
  'The survey group',
  'The customer panel',
  'The depot supervisors',
  'The finance desk',
  'The planning unit',
  'The station managers',
  'The contractor on the north spur',
  'The accessibility adviser',
  'The data team',
];

const VERBS = [
  'reported',
  'confirmed',
  'estimated',
  'recorded',
  'reviewed',
  'flagged',
  'compared',
  'measured',
  'summarized',
  'tested',
];

const OBJECTS = [
  'a steady rise in weekday trips',
  'a small drop in weekend use',
  'delays on the early morning run',
  'gaps in the ticket records',
  'a need for more spare parts',
  'lower use of the north platform',
  'two stops with blocked ramps',
  'an extra shift for night checks',
  'a higher cost for cable repairs',
  'better results from the new signs',
  'long queues at the east gate',
  'a pattern of short peak loads',
];

const DETAILS = [
  'during the review period',
  'after the spring timetable change',
  'once the new counters were installed',
  'compared with the previous year',
  'based on the sample from the quiet months',
  'though the figures are still provisional',
  'which the planning unit will check again',
  'and the team has noted this for the next review',
  'with most of the effect seen on Mondays',
  'while the crew waited for parts from the depot',
];

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

function sentence(random) {
  const figure = Math.floor(random() * 900) + 100;
  return `${pick(random, SUBJECTS)} ${pick(random, VERBS)} ${pick(random, OBJECTS)} ${pick(random, DETAILS)}, figure ${figure}.`;
}

function paragraph(random) {
  const count = 5 + Math.floor(random() * 2);
  return Array.from({ length: count }, () => sentence(random)).join(' ');
}

export function buildLongPage() {
  const random = makeRandom(20261102);
  const parts = [
    '# Harbour Line Transit Review 2026',
    '',
    'This report is invented for evaluation. Every name, place and figure in it is fictional.',
    '',
  ];
  SECTION_TOPICS.forEach((topic, index) => {
    parts.push(`## Section ${index + 1}: ${topic}`, '');
    for (let p = 0; p < 5; p += 1) {
      parts.push(paragraph(random), '');
    }
  });
  return parts.join('\n');
}
