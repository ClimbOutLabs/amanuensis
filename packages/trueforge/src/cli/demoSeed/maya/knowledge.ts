import type { DemoKnowledgeDocument } from '../model';
import { BACKUP_CLINIC, GP_CLINIC, VISA_CLINIC } from './places';

/** Printed next to a document title in the reply's "Sources:" footer: the guide name the persona instructions use. */
export const RELOCATION_GUIDE_LABEL = 'Lisbon relocation guide';
export const PHOTOGRAPHY_GUIDE_LABEL = 'Lisbon photography guide';

type GuidePage = Pick<DemoKnowledgeDocument, 'title' | 'text'>;

function labelled({ label, pages }: { label: string; pages: GuidePage[] }): DemoKnowledgeDocument[] {
  return pages.map(page => ({ ...page, sourceLabel: label }));
}

/** June's library: a Lisbon relocation guide, written for Maya's situation and free of anything private. */
export function relocationGuide(): DemoKnowledgeDocument[] {
  const pages: GuidePage[] = [
    {
      title: 'Visa and residence permit checklist',
      text: [
        '# Visa and residence permit checklist',
        '',
        "General information, not legal advice. Maya's lawyer, Sofia Almeida, handles the residence permit file.",
        '',
        '## What the application needs',
        'Residence permits are applied for at AIMA (Agência para a Integração, Migrações e Asilo), within 90 days of arrival. The usual file holds:',
        '- a valid visa',
        '- proof of income',
        '- health insurance',
        '- accommodation details',
        '- the NIF (tax number)',
        'A criminal background check and biometrics may also be requested.',
        '',
        '## The health certificate',
        'Portugal does not publish one mandatory "visa medical exam" for a standard residence permit. In practice a lawyer may ask for a general health certificate for the file. Present it as "your lawyer asked for a health certificate for the file", never as a government requirement.',
        `Maya's appointment is at 10:00 at ${VISA_CLINIC.name}, ${VISA_CLINIC.address} (the date is on her calendar). It covers a medical history review, a physical examination, blood tests and a chest X-ray. Fasting is not required. Arrive 15 minutes early.`,
        '',
        '## What to bring to the medical',
        '- Passport',
        '- NIF document',
        '- Health insurance card',
        '- A list of current medications (including the asthma inhaler)',
        '- A written note of her allergy: she is allergic to penicillin, and the doctor must hear it',
        '',
        '## After the medical',
        'The clinic issues the certificate. Sofia needs a scan the same day, and Maya has a call with her the week after to review the file.',
      ].join('\n'),
    },
    {
      title: 'NIF (tax number) process',
      text: [
        '# NIF (tax number)',
        '',
        'The NIF (número de identificação fiscal) is the Portuguese tax number. Almost everything needs it: a bank account, a lease, utilities, a phone contract and the residence permit file.',
        '',
        '## How people get one',
        '- In person at a tax office (Finanças) with a passport and proof of address.',
        '- Through a fiscal representative or a lawyer, which is common for people who do not yet have a Portuguese address.',
        '',
        "## Maya's NIF",
        'Her lawyer Sofia Almeida arranged it, and the document is saved in her shared folder. She has already used it to open her Portuguese bank account and to register with AIMA.',
      ].join('\n'),
    },
    {
      title: 'Lisbon neighborhoods for an apartment hunt',
      text: [
        '# Lisbon neighborhoods',
        '',
        '## Alfama',
        'The oldest district, under São Jorge Castle. Narrow cobbled lanes, fado houses, craft shops. It went from poor to fashionable and many buildings still need renovation. No cars in the lanes. Steep. Great for the "Old Lisbon" photo series.',
        '## Graça',
        'A hilltop on the far side of the castle. Spectacular miradouros, old-town charm, a mostly local feel, slowly gentrifying. No metro: trams and rideshares only. Steep.',
        '## Mouraria',
        "The birthplace of fado and Lisbon's most multicultural area, with vibrant street art. Charming and romantic, but hilly with steps.",
        '## Campo de Ourique',
        'The quintessential residential area. A lively market hall (Mercado de Campo de Ourique), boutique shops and traditional eateries. Flatter than the hill districts and good for daily life.',
        '## Estrela',
        'West of Chiado and Bairro Alto. A mix of upper-middle-class locals and expats, embassies and parks. Cosmopolitan without feeling touristy.',
        '## Príncipe Real',
        'Trendy, with young locals, an organic market and a garden. Pricier.',
      ].join('\n'),
    },
    {
      title: 'Public transport basics',
      text: [
        '# Public transport in Lisbon',
        '',
        '- The metro has four lines (Blue, Yellow, Green and Red) and covers the flatter center and the north. It does not reach the old hill districts: Graça and Alfama have no metro station of their own.',
        '- Trams and buses are run by Carris. Tram 28 climbs through Alfama and Graça; it is a classic photo subject and is crowded by day.',
        '- A rechargeable Viva Viagem card works on metro, trams, buses and the river ferries. Monthly Navegante passes cover a whole area for regulars.',
        '- Ferries cross the Tagus from Cais do Sodré to Cacilhas.',
        '- On the hills, a short taxi or rideshare is often easier than a bus.',
        '- Check current fares and timetables before relying on them.',
      ].join('\n'),
    },
    {
      title: 'Finding and booking a regular GP',
      text: [
        '# Finding a regular English-speaking GP',
        '',
        'Maya wants a regular doctor on file before the visa paperwork is finished. Her task list has an item to book one.',
        '',
        '## Shortlist',
        `- ${GP_CLINIC.name}, ${GP_CLINIC.address}. English-speaking doctors, open ${GP_CLINIC.hours}. First choice.`,
        `- ${BACKUP_CLINIC.name}, ${BACKUP_CLINIC.address}. Highly rated, open ${BACKUP_CLINIC.hours}. The backup.`,
        `${VISA_CLINIC.name} is already booked for the visa medical, so it is not part of the GP search.`,
        '',
        '## When she books',
        '- Mention the penicillin allergy and the asthma inhaler.',
        '- Offer two or three afternoons and a phone number.',
      ].join('\n'),
    },
    {
      title: 'Emergency numbers and key phrases',
      text: [
        '# Emergency numbers and key phrases',
        '',
        '- 112 is the European emergency number, valid in Portugal for police, fire and ambulance.',
        '',
        '## Phrases (Portuguese, with English)',
        '- Bom dia / Boa tarde: Good morning / Good afternoon',
        '- Fala inglês?: Do you speak English?',
        '- Preciso de uma consulta: I need an appointment',
        '- Tenho alergia à penicilina: I am allergic to penicillin',
        '- Tenho asma: I have asthma',
        '- Sou vegetariana: I am vegetarian',
        '- Uma mesa para duas pessoas, por favor: A table for two, please',
        '- Quanto custa?: How much is it?',
        '- Obrigada: Thank you (said by a woman)',
        '- Pode repetir, por favor?: Could you repeat that, please?',
      ].join('\n'),
    },
  ];
  return labelled({ label: RELOCATION_GUIDE_LABEL, pages });
}

/** Theo's library: a Lisbon photography guide, with twelve places and the plan for the "Old Lisbon" series. */
export function photographyGuide(): DemoKnowledgeDocument[] {
  const pages: GuidePage[] = [
    {
      title: 'Twelve places to shoot in Lisbon',
      text: [
        '# Twelve places to shoot in Lisbon',
        '',
        'Each entry gives the best time, where the light comes from, and what to look for.',
        '',
        '1. Largo do Chafariz de Dentro, Alfama. Dawn, in the first hour after sunrise. Low light slices down the lanes. Closed shutters, delivery vans, cats on the steps. The Alfama nobody photographs.',
        '2. Miradouro de Santa Luzia, Alfama. Morning. The terrace faces the river over the rooftops. Azulejo panels, bougainvillea, and tram 28 passing below the wall. Shoot the tram at 1/250 s to keep it sharp, or 1/15 s for motion.',
        '3. Miradouro das Portas do Sol, Alfama. Morning. It faces east, so the first light washes over the rooftops. The most photographed terrace in Alfama: use it to scout, then compress one detail.',
        "4. Miradouro da Graça, Graça. Golden hour: arrive an hour before sunset. Sunset falls behind São Jorge Castle. Pine trees, kiosk drinks and a relaxed crowd. Maya's favorite viewpoint so far.",
        '5. Miradouro da Senhora do Monte, Graça. Late afternoon. The highest viewpoint, with a 180-degree panorama, one block above Graça. Use it for wide scouting shots.',
        '6. The Mouraria staircases and alleys. Mid-afternoon, a couple of hours before sunset. Raking light through the laundry lines, tiled walls, fado drifting out of doorways.',
        '7. Largo do Intendente, Mouraria. Late afternoon. Tiles, street art and a mix of neighbors from everywhere.',
        '8. Miradouro de São Pedro de Alcântara, Bairro Alto side. Late afternoon into evening. A long view across the center to the castle. People watching.',
        '9. Belém riverside, starting at MAAT. Golden hour: arrive an hour before sunset. Flat riverside light with the 25 de Abril bridge as a constant backdrop. Expose for the highlights and lift the shadows later.',
        '10. Praça do Comércio. Blue hour, just after sunset. The yellow arcades glow against a deep blue sky, with the river at your back.',
        '11. Mercado de Campo de Ourique. Morning. A market hall full of vendors, produce and gestures. Ask before you point a camera at a stall.',
        '12. A neighborhood pastelaria at 6 am. Shoot the bakers loading trays, not the display case at noon. Steam on the glass, flour, the first customers.',
      ].join('\n'),
    },
    {
      title: 'Light and timing in late October',
      text: [
        '# Light and timing in late October',
        '',
        '- Golden hour is the stretch before sunset when the light turns low and warm. Start an hour before sunset and stay until the sun is on the horizon.',
        '- Blue hour follows sunset: deep blue sky, lit windows, good for Praça do Comércio and the miradouros.',
        '- Sunset comes earlier each day in late October, and the clocks go back on the last Sunday of the month, which moves sunset to the late afternoon. Check the sunset time for the exact date; the Graça and Belém sessions start an hour before it.',
        '- In the morning the narrow lanes of Alfama stay empty for the first hour after sunrise. After that the vans, the shutters opening and the first walking tours spoil the quiet.',
        '- Midday light in the lanes is flat and harsh. Skip it, or work indoors in a market or a pastelaria.',
        '- Hilltops are windy and cool in the evening: layers and a light bag.',
      ].join('\n'),
    },
    {
      title: 'Film or digital in low-light fado houses',
      text: [
        '# Low light in fado houses',
        '',
        '- No flash, ever. It breaks the performance and the room will let you know.',
        "- Digital wins for low light. A fast lens and a high ISO let you shoot hand-held. Maya's Fujifilm X-T5 has a silent electronic shutter, and her f/2 prime keeps it hand-held, which suits a quiet room.",
        '- Film can work if you push it two stops, but the grain is heavy and a roll is over before the second song. Choose it for the look, not for convenience.',
        '- Shoot a rehearsal instead of a show when you can. The singers are relaxed, the light is yours, and nobody minds a camera.',
        '- Ask the house first. Buy a drink, stay for the whole piece, and never move during a song.',
      ].join('\n'),
    },
    {
      title: 'Photography etiquette in Lisbon',
      text: [
        '# Photography etiquette',
        '',
        '- In markets, ask before you photograph a stall or a person. A smile and "Posso tirar uma fotografia?" (May I take a photo?) opens most doors. Buy something.',
        '- Do not photograph children without a parent nearby and a clear yes.',
        '- Many churches and some museums forbid flash or photography. Look for the sign.',
        '- In the lanes, step aside for residents. People live there.',
        '- Fado houses: silence while someone sings, and no flash.',
        '- A thank-you goes a long way: "Obrigada!"',
      ].join('\n'),
    },
    {
      title: '"Old Lisbon" series plan',
      text: [
        '# The "Old Lisbon" series',
        '',
        "Maya's series is about old Lisbon: Alfama, then Graça, then Belém on the river, with Mouraria as an optional extra. Keep each session to one neighborhood and go deep. Three neighborhoods in one day gives snapshots, not a series.",
        '',
        '## Planned sessions',
        '1. Alfama sunrise, just after the sun is up. Start at Largo do Chafariz de Dentro. Empty alleys, light slicing through. The X-T5 only, travel light.',
        '2. Miradouro da Graça golden hour. Arrive an hour before sunset; the sun sets over São Jorge Castle.',
        '3. Belém golden hour. Arrive an hour before sunset. Riverside light with the 25 de Abril bridge as backdrop. Expose for highlights.',
        'The dates of the three sessions are on her calendar.',
        '',
        '## Optional extras',
        '- A Mouraria afternoon, an optional extra spot: the staircases and laundry lines a couple of hours before sunset.',
        '- A fado house rehearsal, which Maya has wanted since she first heard fado in Mouraria.',
        '- The bakers at 6 am in a pastelaria.',
        '',
        '## Gear and logistics',
        '- One camera, one lens. The streets are steep.',
        '- Her new Fujifilm XF 23mm f/2 lens is waiting for pickup at the camera shop, so collect it before the first session.',
      ].join('\n'),
    },
  ];
  return labelled({ label: PHOTOGRAPHY_GUIDE_LABEL, pages });
}
