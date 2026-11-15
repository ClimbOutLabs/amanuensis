/** One made-up note: who it came from, how many days before today it is dated, and what it says. */
export interface ExampleNote {
  key: string;
  daysAgo: number;
  from: 'person' | 'email';
  text: string;
}

/**
 * About two years of made-up notes for trying how old and new memories are used. They mix things that end
 * by themselves, things that last, advice that was later replaced, and things that may or may not still hold,
 * so no single rule about age fits them all.
 */
export const EXAMPLE_NOTES: readonly ExampleNote[] = [
  // About two years ago.
  { key: 'allergy', daysAgo: 725, from: 'person', text: 'I am allergic to penicillin.' },
  { key: 'partner', daysAgo: 722, from: 'person', text: 'My partner is called Robin. We live together.' },
  {
    key: 'cpa-old',
    daysAgo: 716,
    from: 'email',
    text: 'The CPA, Dana Whitfield, said not to file taxes early this year, and to wait for the corrected brokerage form.',
  },
  {
    key: 'elbow',
    daysAgo: 710,
    from: 'person',
    text: 'I have elbow pain from tennis and I am taking an anti-inflammatory for it.',
  },
  { key: 'iron', daysAgo: 701, from: 'person', text: 'My doctor says I have an iron deficiency.' },
  { key: 'car-old', daysAgo: 690, from: 'person', text: 'I drive a grey Honda Civic.' },
  { key: 'city-old', daysAgo: 684, from: 'person', text: 'I live in Austin, in a rented flat near the river.' },
  {
    key: 'job-old',
    daysAgo: 670,
    from: 'person',
    text: 'I work as a product designer at a small studio called Fernhill.',
  },
  {
    key: 'dentist',
    daysAgo: 655,
    from: 'email',
    text: 'The dental practice of Dr Okafor confirmed a check-up and asked to arrive ten minutes early.',
  },
  { key: 'coffee', daysAgo: 640, from: 'person', text: 'I drink my coffee black, no sugar.' },
  // About 20 to 13 months ago.
  { key: 'jacket', daysAgo: 610, from: 'person', text: 'My Versace jacket has a hole in the sleeve.' },
  { key: 'marathon', daysAgo: 590, from: 'person', text: 'I am training for a half marathon in the spring.' },
  {
    key: 'sister',
    daysAgo: 575,
    from: 'person',
    text: 'My sister Priya lives in Toronto and her birthday is on March 3.',
  },
  {
    key: 'landlord',
    daysAgo: 560,
    from: 'email',
    text: 'The landlord wrote that the rent goes up by 4 percent at the next renewal.',
  },
  { key: 'cold', daysAgo: 540, from: 'person', text: 'I have a bad cold and I am staying in this week.' },
  { key: 'vegetarian', daysAgo: 525, from: 'person', text: 'I have stopped eating meat. I am vegetarian now.' },
  { key: 'laptop', daysAgo: 500, from: 'person', text: 'My laptop battery only lasts about an hour.' },
  { key: 'spanish', daysAgo: 480, from: 'person', text: 'I started learning Spanish. I am a beginner.' },
  { key: 'move', daysAgo: 430, from: 'person', text: 'I moved to Denver. I do not live in Austin any more.' },
  { key: 'job-new', daysAgo: 410, from: 'person', text: 'I left Fernhill. I now work as a design lead at Northwind.' },
  // About a year ago.
  {
    key: 'boots',
    daysAgo: 372,
    from: 'person',
    text: 'I put a hole in my mountaineering boots on the last trip of the season.',
  },
  { key: 'tent', daysAgo: 370, from: 'person', text: 'My two-person tent is in good shape and stored in the garage.' },
  {
    key: 'cpa-mid',
    daysAgo: 360,
    from: 'email',
    text: 'The CPA, Dana Whitfield, sent the yearly checklist and asked for the mortgage interest statement.',
  },
  { key: 'car-new', daysAgo: 330, from: 'person', text: 'I sold the Civic and bought a blue Subaru Outback.' },
  { key: 'dog', daysAgo: 300, from: 'person', text: 'We adopted a dog called Biscuit. She is a border collie mix.' },
  { key: 'knee', daysAgo: 270, from: 'person', text: 'My left knee hurts after long runs.' },
  {
    key: 'gym',
    daysAgo: 255,
    from: 'email',
    text: 'The climbing gym wrote that the membership renews every year on the first of March.',
  },
  { key: 'wifi', daysAgo: 230, from: 'person', text: 'The wifi at home drops every evening.' },
  { key: 'spanish-b1', daysAgo: 200, from: 'person', text: 'I passed the B1 Spanish exam.' },
  // The last six months.
  { key: 'project', daysAgo: 170, from: 'person', text: 'I am leading the redesign of the Northwind checkout.' },
  {
    key: 'robin-job',
    daysAgo: 150,
    from: 'person',
    text: 'Robin started a new job as a nurse at the children’s hospital.',
  },
  { key: 'trip-plan', daysAgo: 120, from: 'person', text: 'I want to climb Mount Rainier next summer.' },
  { key: 'router', daysAgo: 95, from: 'person', text: 'I replaced the router and the wifi is fine now.' },
  {
    key: 'vet',
    daysAgo: 70,
    from: 'email',
    text: 'The vet wrote that Biscuit is due for her yearly shots next month.',
  },
  { key: 'headache', daysAgo: 45, from: 'person', text: 'I have had headaches in the afternoon this week.' },
  { key: 'tennis', daysAgo: 30, from: 'person', text: 'I am playing tennis again on Saturdays with Sam.' },
  { key: 'launch', daysAgo: 21, from: 'person', text: 'The new checkout launched. The project is done.' },
  { key: 'tooth', daysAgo: 9, from: 'person', text: 'I chipped a tooth and I need to see the dentist.' },
  { key: 'guests', daysAgo: 4, from: 'person', text: 'Priya is visiting us next weekend.' },
  {
    key: 'cpa-new',
    daysAgo: 1,
    from: 'email',
    text: 'The CPA, Dana Whitfield, said to file taxes early this year, because nothing is expected to be corrected.',
  },
  { key: 'tired', daysAgo: 1, from: 'person', text: 'I slept badly and I am tired today.' },
];
