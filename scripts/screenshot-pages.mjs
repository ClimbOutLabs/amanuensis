// The shared parts of the test screenshot pages: the nightly contact sheet, the weekly look-over and the
// list of both. Everything is inline, so a page also opens straight from a download.

export function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** The text as JSON, or undefined when it is damaged. One bad stored file must not stop a whole page. */
export function parsedJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Aman's paper colours, the same ones the docs site uses.
const STYLE = `
:root { color-scheme: light dark; --bg: #f7f2e8; --card: #fffdf8; --ink: #2c2a26; --soft: #6a6055; --line: #d9ccb6; --tint: #ebe2d3; --accent: oklch(0.503 0.095 84.8); --good: #2f6b3f; --good-bg: #e1eedd; --bad: #a3352a; --bad-bg: #f6dfd9; --shadow: 0 0.0625rem 0.125rem rgb(44 42 38 / 0.06), 0 0.5rem 1.5rem rgb(44 42 38 / 0.06); }
@media (prefers-color-scheme: dark) { :root { --bg: #28241c; --card: #2f2a21; --ink: #f2ecdd; --soft: #a89a7f; --line: #3e382b; --tint: #3a3428; --accent: oklch(0.809 0.138 85.2); --good: #9bd0a4; --good-bg: #2c3a2c; --bad: #f09a8e; --bad-bg: #472b26; --shadow: none; } }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 4.5rem; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 1rem/1.55 'Inter Tight', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; }
main { max-width: 82rem; margin: 0 auto; padding: 2.5rem 1.5rem 5rem; }
a { color: inherit; }
header { margin-bottom: 2rem; }
.crumb { display: inline-flex; align-items: center; gap: 0.375rem; margin-bottom: 1.25rem; color: var(--soft); font-size: 0.875rem; text-decoration: none; }
.crumb:hover { color: var(--accent); }
.eyebrow { margin: 0 0 0.5rem; color: var(--accent); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
h1 { margin: 0; font-size: clamp(1.75rem, 4vw, 2.5rem); line-height: 1.15; letter-spacing: -0.02em; text-wrap: balance; }
.lead { max-width: 44rem; margin: 0.75rem 0 0; color: var(--soft); font-size: 1.0625rem; }
h2 { margin: 0; font-size: 1.375rem; letter-spacing: -0.01em; }
section { margin-top: 3.5rem; }
.section-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 1rem; padding-bottom: 0.75rem; border-bottom: 0.0625rem solid var(--line); }
.section-head p, .note { margin: 0; color: var(--soft); font-size: 0.875rem; }
.note { margin-top: 1rem; overflow-wrap: anywhere; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: 0.75rem; margin-top: 1.75rem; }
.tile { padding: 1rem 1.125rem; border: 0.0625rem solid var(--line); border-radius: 0.875rem; background: var(--card); box-shadow: var(--shadow); }
.tile b { display: block; font-size: 1.75rem; line-height: 1.1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.tile span { display: block; margin-top: 0.25rem; color: var(--soft); font-size: 0.8125rem; line-height: 1.3; }
.tile.good b { color: var(--good); }
.tile.bad b { color: var(--bad); }
nav { position: sticky; top: 0; z-index: 1; display: flex; gap: 0.5rem; margin: 1.75rem -1.5rem 0; padding: 0.75rem 1.5rem; overflow-x: auto; background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(0.5rem); border-bottom: 0.0625rem solid var(--line); }
nav a { flex: none; padding: 0.3125rem 0.75rem; border: 0.0625rem solid var(--line); border-radius: 62rem; background: var(--card); font-size: 0.8125rem; text-decoration: none; white-space: nowrap; }
nav a:hover { border-color: var(--accent); color: var(--accent); }
nav a i { margin-left: 0.375rem; color: var(--soft); font-style: normal; font-variant-numeric: tabular-nums; }
nav a.bad { border-color: var(--bad); color: var(--bad); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(21rem, 1fr)); gap: 1.25rem; margin-top: 1.25rem; }
.card { display: flex; flex-direction: column; margin: 0; border: 0.0625rem solid var(--line); border-radius: 0.875rem; background: var(--card); box-shadow: var(--shadow); overflow: hidden; }
.card.bad { border-color: var(--bad); }
.shot { display: block; padding: 0.75rem 0.75rem 0; background: var(--tint); }
.shot img { display: block; width: 100%; height: 13rem; object-fit: cover; object-position: top; border: 0.0625rem solid var(--line); border-bottom: 0; border-radius: 0.5rem 0.5rem 0 0; background: var(--card); transition: transform 0.2s; }
.shot:hover img { transform: translateY(-0.125rem); }
figcaption, .body { padding: 1rem 1.125rem 1.125rem; overflow-wrap: anywhere; }
.top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.375rem 0.75rem; }
.pill { display: inline-flex; align-items: center; gap: 0.375rem; padding: 0.125rem 0.625rem; border-radius: 62rem; background: var(--tint); color: var(--soft); font-size: 0.75rem; font-weight: 600; white-space: nowrap; }
.pill::before { content: ''; width: 0.4375rem; height: 0.4375rem; border-radius: 50%; background: currentColor; }
.pill.good { background: var(--good-bg); color: var(--good); }
.pill.bad { background: var(--bad-bg); color: var(--bad); }
.where { color: var(--soft); font-size: 0.75rem; }
h3 { margin: 0.75rem 0 0; font-size: 1.0625rem; line-height: 1.3; }
dl { margin: 0; }
dt { margin-top: 0.875rem; color: var(--accent); font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
dd { margin: 0.125rem 0 0; font-size: 0.9375rem; }
dd ul { margin: 0; padding-left: 1.125rem; }
dd li + li { margin-top: 0.25rem; }
.runs { display: grid; grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr)); gap: 1.25rem; margin-top: 1.25rem; }
.run { color: inherit; text-decoration: none; transition: transform 0.2s, border-color 0.2s; }
.run:hover { transform: translateY(-0.125rem); border-color: var(--accent); }
.strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.375rem; height: 7.5rem; padding: 0.75rem 0.75rem 0; background: var(--tint); }
.strip img { width: 100%; height: 100%; min-height: 0; object-fit: cover; object-position: top; border: 0.0625rem solid var(--line); border-bottom: 0; border-radius: 0.375rem 0.375rem 0 0; background: var(--card); }
.run .day { margin: 0; font-size: 1.25rem; font-weight: 700; letter-spacing: -0.01em; }
.run .time { margin: 0 0 0.75rem; color: var(--soft); font-size: 0.8125rem; }
.empty { margin-top: 1.25rem; padding: 2rem; border: 0.0625rem dashed var(--line); border-radius: 0.875rem; color: var(--soft); text-align: center; }
details { margin-top: 1.25rem; border: 0.0625rem solid var(--line); border-radius: 0.875rem; background: var(--card); }
summary { padding: 0.875rem 1.125rem; cursor: pointer; font-weight: 600; }
pre { margin: 0; padding: 0 1.125rem 1.125rem; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--soft); font: 0.8125rem/1.6 ui-monospace, 'SF Mono', Menlo, monospace; }
footer { margin-top: 4rem; padding-top: 1.25rem; border-top: 0.0625rem solid var(--line); color: var(--soft); font-size: 0.8125rem; }
.filters { display: flex; flex-wrap: wrap; align-items: end; gap: 0.75rem; margin-top: 1.75rem; padding: 1rem 1.125rem; border: 0.0625rem solid var(--line); border-radius: 0.875rem; background: var(--card); box-shadow: var(--shadow); }
.filters label { display: flex; flex-direction: column; gap: 0.25rem; color: var(--accent); font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.filters label.grow { flex: 1 1 14rem; }
.filters input, .filters select { min-height: 2.5rem; padding: 0.375rem 0.75rem; border: 0.0625rem solid var(--line); border-radius: 0.625rem; background: var(--bg); color: var(--ink); font: inherit; font-size: 0.9375rem; letter-spacing: normal; text-transform: none; }
.filters input:focus, .filters select:focus { outline: 0.125rem solid var(--accent); outline-offset: 0.0625rem; }
.filters output { margin-left: auto; color: var(--soft); font-size: 0.875rem; }
.filters button { min-height: 2.5rem; padding: 0.375rem 0.875rem; border: 0.0625rem solid var(--line); border-radius: 62rem; background: transparent; color: var(--ink); font: inherit; font-size: 0.875rem; cursor: pointer; }
.filters button:hover { border-color: var(--accent); color: var(--accent); }
[hidden] { display: none !important; }
@media (max-width: 40rem) { main { padding: 1.5rem 1rem 3rem; } nav { margin-inline: -1rem; padding-inline: 1rem; } .grid, .runs { grid-template-columns: 1fr; } }
`;

/** A small rounded label; `tone` is good, bad or nothing. */
export function pillHtml({ text, tone }) {
  return `<span class="pill${tone ? ` ${tone}` : ''}">${escapeHtml(text)}</span>`;
}

/** A row of big numbers, each `{ value, label, tone }`. */
export function tilesHtml(tiles) {
  return `<div class="tiles">${tiles
    .map(
      tile =>
        `<div class="tile${tile.tone ? ` ${tile.tone}` : ''}"><b>${escapeHtml(String(tile.value))}</b><span>${escapeHtml(tile.label)}</span></div>`,
    )
    .join('')}</div>`;
}

/**
 * One picture with its story. `rows` are `[name, html]` pairs and their html is used as it is, so the
 * caller escapes it.
 */
export function cardHtml({ file, alt, pill, where, heading, rows, bad, filter }) {
  const data = Object.entries(filter.values)
    .map(([name, value]) => ` data-${name}="${escapeHtml(value)}"`)
    .join('');
  return `<figure class="card${bad ? ' bad' : ''}" data-search="${escapeHtml(filter.search.toLowerCase())}"${data}><a class="shot" href="${escapeHtml(file)}"><img loading="lazy" src="${escapeHtml(file)}" alt="${escapeHtml(alt)}"></a><figcaption><div class="top">${pillHtml(pill)}<span class="where">${escapeHtml(where)}</span></div>${heading === null ? '' : `<h3>${escapeHtml(heading)}</h3>`}<dl>${rows.map(([name, html]) => `<dt>${name}</dt><dd>${html}</dd>`).join('')}</dl></figcaption></figure>`;
}

/**
 * A bar that narrows the cards on the page: a search over each card's words, and one list per kind of
 * choice. Each choice is `{ name, label, options: [{ value, label }] }`, and matches a card's
 * `data-<name>`. Without scripts the bar is hidden and every card shows.
 */
export function filterHtml({ placeholder, choices }) {
  const selects = choices.map(
    choice =>
      `<label>${escapeHtml(choice.label)}<select data-filter="${escapeHtml(choice.name)}"><option value="">All</option>${choice.options
        .map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
        .join('')}</select></label>`,
  );
  return `<form class="filters" role="search" hidden onsubmit="return false">
<label class="grow">Search<input type="search" data-filter-search placeholder="${escapeHtml(placeholder)}"></label>
${selects.join('\n')}
<button type="reset">Clear</button>
<output aria-live="polite"></output>
</form>
<p class="empty" data-filter-none hidden>No pictures match. Try fewer filters.</p>
<script>${FILTER_SCRIPT}</script>`;
}

// Runs once the page is read, since the bar sits above the cards. Hides the cards that don't match, then any
// section left with none. A summary section that repeats
// cards shown elsewhere hides while a filter is set, so no card shows twice.
const FILTER_SCRIPT = `document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('.filters');
  if (!form) return;
  form.hidden = false;
  const cards = [...document.querySelectorAll('.card[data-search]')];
  const search = form.querySelector('[data-filter-search]');
  const selects = [...form.querySelectorAll('select[data-filter]')];
  const none = document.querySelector('[data-filter-none]');
  const count = form.querySelector('output');
  const apply = () => {
    const words = search.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
    const picked = selects.filter(select => select.value !== '');
    const active = words.length > 0 || picked.length > 0;
    let shown = 0;
    for (const card of cards) {
      const summary = card.closest('[data-summary]') !== null;
      const match =
        words.every(word => card.dataset.search.includes(word)) &&
        picked.every(select => card.getAttribute('data-' + select.dataset.filter) === select.value);
      card.hidden = !match || (active && summary);
      if (!card.hidden && !summary) shown += 1;
    }
    for (const section of document.querySelectorAll('section')) {
      const inside = section.querySelectorAll('.card[data-search]');
      if (inside.length > 0) section.hidden = [...inside].every(card => card.hidden);
    }
    none.hidden = shown > 0;
    count.textContent = active ? shown + ' of ' + cards.filter(card => card.closest('[data-summary]') === null).length + ' pictures' : '';
  };
  form.addEventListener('input', apply);
  form.addEventListener('reset', () => setTimeout(apply));
  apply();
});`;

/** A whole page. `home` is the link back to the list, left out on the list itself and in a download. */
export function pageHtml({ title, eyebrow, lead, home, body, hidden = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${hidden ? '<meta name="robots" content="noindex">\n' : ''}<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
${home === undefined ? '' : `<a class="crumb" href="${escapeHtml(home)}">&larr; All test screenshots</a>`}
<p class="eyebrow">${escapeHtml(eyebrow)}</p>
<h1>${escapeHtml(title)}</h1>
<p class="lead">${escapeHtml(lead)}</p>
</header>
${body}
<footer>Everything in these pictures is made-up test data.</footer>
</main>
</body>
</html>
`;
}

/** True for a picture taken when a test failed, or by a test that went on to fail. */
export function fromFailedTest(picture) {
  return picture.failed || picture.passed === false;
}

function resultText(picture) {
  if (picture.failed) {
    return 'Test failed. This is the page at that moment.';
  }
  if (picture.passed === true) {
    return 'Test passed';
  }
  if (picture.passed === false) {
    return 'Test failed later';
  }
  return picture.test === null ? 'No result was recorded' : 'Test did not finish';
}

/** How a picture's test ended, as the result filter names it. */
function resultValue(picture) {
  if (fromFailedTest(picture)) {
    return 'failed';
  }
  return picture.passed === true ? 'passed' : 'unknown';
}

function pictureHtml({ set, feature, picture }) {
  const bad = fromFailedTest(picture);
  const rows = [
    ['What the test did', picture.did],
    ['What it should show', picture.expect],
  ]
    .filter(([, words]) => typeof words === 'string')
    .map(([name, words]) => [name, escapeHtml(words)]);
  return cardHtml({
    file: picture.file,
    alt: `${feature.id} · ${picture.step}`,
    pill: { text: resultText(picture), tone: bad ? 'bad' : picture.passed === true ? 'good' : undefined },
    where: `${feature.id} · ${picture.step}`,
    heading: picture.test ?? null,
    rows,
    bad,
    filter: {
      values: { result: resultValue(picture), set: set.id },
      search: [picture.test, picture.did, picture.expect, feature.id, picture.step, set.name]
        .filter(words => typeof words === 'string')
        .join(' '),
    },
  });
}

function count(number, word) {
  return `${String(number)} ${word}${number === 1 ? '' : 's'}`;
}

/**
 * The contact sheet as one page with no outside files, so it opens straight from the download. `home`
 * is the link back to the list when the page sits on the site.
 */
export function galleryHtml({ run, title, home }) {
  const shownIn = set => set.features.flatMap(feature => feature.pictures.map(picture => ({ set, feature, picture })));
  const failures = run.feature_sets.flatMap(set => shownIn(set).filter(({ picture }) => fromFailedTest(picture)));
  const withPictures = run.feature_sets.filter(set => shownIn(set).length > 0);
  const sections = run.feature_sets.map(set => {
    const shown = shownIn(set);
    const tested = set.features.filter(feature => feature.has_test).length;
    const noTest = set.features.filter(feature => !feature.has_test).map(feature => feature.id);
    return [
      `<section id="${escapeHtml(set.id)}">`,
      `<div class="section-head"><h2>${escapeHtml(set.name)}</h2><p>${count(shown.length, 'picture')}. ${String(tested)} of ${String(set.features.length)} features have a test.</p></div>`,
      shown.length > 0 ? `<div class="grid">${shown.map(pictureHtml).join('')}</div>` : '',
      noTest.length > 0 ? `<p class="note">No test yet: ${escapeHtml(noTest.join(', '))}</p>` : '',
      '</section>',
    ].join('\n');
  });
  const { totals } = run;
  const chips = withPictures.map(
    set => `<a href="#${escapeHtml(set.id)}">${escapeHtml(set.name)}<i>${String(shownIn(set).length)}</i></a>`,
  );
  if (failures.length > 0) {
    chips.unshift(`<a class="bad" href="#failed">Failed<i>${String(failures.length)}</i></a>`);
  }
  return pageHtml({
    title,
    eyebrow: 'Nightly tests',
    lead: 'Every picture the automatic tests took on this run. Each one says which test took it, what the test did and what the picture should show.',
    home,
    hidden: home !== undefined,
    body: `${tilesHtml([
      { value: totals.pictures, label: 'pictures' },
      { value: totals.pictures - totals.failed_pictures, label: 'from tests that did not fail', tone: 'good' },
      {
        value: totals.failed_pictures,
        label: 'from failed tests',
        tone: totals.failed_pictures > 0 ? 'bad' : undefined,
      },
      { value: `${String(totals.features_with_a_test)} of ${String(totals.features)}`, label: 'features have a test' },
    ])}
${filterHtml({
  placeholder: 'Test name or what it checks',
  choices: [
    {
      name: 'result',
      label: 'Result',
      options: [
        { value: 'failed', label: 'Failed' },
        { value: 'passed', label: 'Passed' },
        { value: 'unknown', label: 'No result' },
      ],
    },
    {
      name: 'set',
      label: 'Feature area',
      options: withPictures.map(set => ({ value: set.id, label: set.name })),
    },
  ],
})}
<nav>${chips.join('')}</nav>
${
  failures.length > 0
    ? `<section id="failed" data-summary><div class="section-head"><h2>Failed</h2><p>${count(failures.length, 'picture')} from tests that failed.</p></div><div class="grid">${failures.map(pictureHtml).join('')}</div></section>`
    : ''
}
${sections.join('\n')}`,
  });
}
