import type { DayLabels } from '../calendar';
import type { DemoNote } from '../model';

/** Maya's long-term memory, one note per fact. Dated phrasing is relative to the seed day. */
export function mayaMemoryNotes(days: DayLabels): DemoNote[] {
  const meetup = `${days.weekday(10)}, ${days.monthDay(10)}`;
  return [
    {
      key: 'identity',
      body: 'Maya is 38 years old. She moved from Austin, Texas to Lisbon, Portugal about two weeks ago for a fresh start.',
    },
    {
      key: 'work',
      body: 'Maya works remotely as a UX designer. She keeps US Central hours overlap, so her mornings in Lisbon are usually free.',
    },
    {
      key: 'photo-gear',
      body: 'Maya is a street photographer. She shoots with a Fujifilm X-T5 and prefers a small, light setup for steep streets.',
    },
    {
      key: 'photo-light',
      body: 'Maya prefers morning light for photography. Empty alleys in the first hour after sunrise, light slicing through like a studio.',
    },
    {
      key: 'photo-series',
      body: "Maya is planning a photo series called 'Old Lisbon', with sessions in Alfama, Graça and Belém, and Mouraria as an optional extra spot.",
    },
    {
      key: 'photo-alfama-2023',
      body: 'Maya shot Alfama on a 2023 trip and wants to go deeper this time, past the places every visitor photographs.',
    },
    {
      key: 'photo-viewpoint',
      body: 'Her favorite viewpoint so far is Miradouro da Graça, for sunset over São Jorge Castle.',
    },
    {
      key: 'health-allergy',
      body: 'Maya is allergic to penicillin. This is important for any medical appointment.',
    },
    { key: 'health-asthma', body: 'Maya has mild asthma and uses an inhaler.' },
    { key: 'diet', body: 'Maya is vegetarian.' },
    {
      key: 'portuguese',
      body: 'Maya is learning Portuguese at beginner (A1) level. She is in week 3 of her classes.',
    },
    {
      key: 'visa-lawyer',
      body: "Maya's visa lawyer is Sofia Almeida. Sofia is handling the residence permit file.",
    },
    {
      key: 'walkable',
      body: 'Maya wants a walkable neighborhood and does not want a car. Hills are tolerable, but she has mild asthma so steps matter, and metro or tram access matters.',
    },
    {
      key: 'rental-budget',
      body: "Maya's rental budget is up to €1,600/month. She wants a 1-bedroom with natural light for a home studio corner.",
    },
    {
      key: 'friend-rui',
      body: 'Maya has a photographer friend in Lisbon, Rui Carvalho, who is introducing her to the local photography club.',
    },
    {
      key: 'fado',
      body: 'Maya likes fado music. She first heard it in Mouraria and wants to go back.',
    },
    {
      key: 'food-places',
      body: 'Maya dislikes tourist-trap restaurants. She prefers a traditional tasca or pastelaria.',
    },
    {
      key: 'coffee',
      body: 'Maya takes her coffee at traditional pastelarias, not specialty coffee shops.',
    },
    {
      key: 'newcomers',
      body: `Maya joined the 'Lisbon Newcomers' expat group. Next meetup is ${meetup} at Café do Cais in Cais do Sodré.`,
    },
    {
      key: 'photo-club',
      body: "Rui suggested Maya join the photography club's monthly critique night.",
    },
    {
      key: 'short-term-rental',
      body: "Maya's short-term rental for her first month is at Rua da Emenda 45, 1200-169 Lisboa, in Chiado, while she apartment-hunts. Trips start from there unless she says otherwise.",
    },
  ];
}
