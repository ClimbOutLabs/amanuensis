/**
 * Invented places in the response shape Tavily's /search and /extract return (checked against the
 * live API and Tavily's reference). No real business, person or number appears here.
 */
export const HARBOUR_URL = 'https://harbour-clinic.example/en';
export const GARDEN_URL = 'https://garden-health.example/doctors';
export const CANAL_URL = 'https://canal-practice.example/about';
export const REVIEW_URL = 'https://reviews.example/best-doctors';

export const HARBOUR_TEXT =
  'Harbour Family Clinic\n12 Example Street, Lisbon 1100-000\nLanguages: English, Portuguese\n' +
  'Opening hours: Mon-Fri 9:00-18:00\nConsultation 60 EUR\nPhone +351 210 000 111\n';
export const GARDEN_TEXT =
  'Garden Health Centre, 4 Sample Avenue, Lisbon 1200-000. We speak English and French. ' +
  'Open daily 8:00-20:00. Call 210 000 222.';

export const searchResponse = {
  query: 'English speaking doctor Lisbon',
  follow_up_questions: null,
  answer: null,
  images: [],
  results: [
    {
      url: HARBOUR_URL,
      title: 'Harbour Family Clinic',
      content: 'English speaking family doctors.',
      score: 0.86,
      raw_content: null,
    },
    {
      url: GARDEN_URL,
      title: 'Garden Health Centre',
      content: 'Doctors who speak English.',
      score: 0.83,
      raw_content: null,
    },
    { url: CANAL_URL, title: 'Canal Practice', content: 'A practice by the canal.', score: 0.8, raw_content: null },
    { url: REVIEW_URL, title: 'Best doctors', content: 'A list of doctors.', score: 0.7, raw_content: null },
  ],
  response_time: 1.2,
  request_id: 'req-0001',
};

export const extractResponse = {
  results: [
    { url: HARBOUR_URL, title: 'Harbour Family Clinic', raw_content: HARBOUR_TEXT, images: [] },
    { url: GARDEN_URL, title: 'Garden Health Centre', raw_content: GARDEN_TEXT, images: [] },
  ],
  failed_results: [{ url: CANAL_URL, error: 'Could not load the page' }],
  response_time: 0.9,
  request_id: 'req-0002',
};
