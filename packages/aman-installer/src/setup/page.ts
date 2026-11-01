import {
  PASSWORDS_DIFFER_LINE,
  PASSWORD_LACK_LENGTH,
  PASSWORD_LACK_NUMBER,
  PASSWORD_LACK_SYMBOL,
  PASSWORD_MISSING_LINE,
  PASSWORD_TOO_LONG_LINE,
  SETUP_TEXT,
  setupDownloadsTotalLine,
} from '../messages.ts';

// The wizard's one page. Everything the person sees is here: the screens
// as sections, shown one at a time by the small script at the end. The
// words come from messages.ts (they are checked there like every other
// word aman prints); the checks, plan rows, steps and findings come from
// the installer itself and arrive as data. The page keeps nothing: the
// token rides in the address and in every call, and no answer or secret
// is written to the browser's storage.
const PAGE_WORDS = JSON.stringify({
  text: SETUP_TEXT,
  tooLong: PASSWORD_TOO_LONG_LINE,
  lackLength: PASSWORD_LACK_LENGTH,
  lackNumber: PASSWORD_LACK_NUMBER,
  lackSymbol: PASSWORD_LACK_SYMBOL,
  differ: PASSWORDS_DIFFER_LINE,
  missing: PASSWORD_MISSING_LINE,
  downloadsTotal: setupDownloadsTotalLine(0).replace('0', '{mb}'),
});

export function setupPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Aman setup</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #1c1c1c; background: #f7f5f2; }
  main { max-width: 44rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
  header { display: flex; justify-content: space-between; align-items: center; }
  h1 { font-size: 1.6rem; margin: 0.5rem 0; }
  h2 { font-size: 1.15rem; margin: 1.2rem 0 0.4rem; }
  p { line-height: 1.45; }
  .screen { display: none; }
  .screen.on { display: block; }
  button { font-size: 1rem; padding: 0.55rem 1.1rem; border-radius: 0.5rem; border: 1px solid #8a8378; background: #fff; cursor: pointer; }
  button.primary { background: #205c40; color: #fff; border-color: #205c40; }
  button:disabled { opacity: 0.45; cursor: default; }
  button.small { font-size: 0.9rem; padding: 0.3rem 0.7rem; }
  label { display: block; margin: 0.9rem 0 0.25rem; font-weight: 600; }
  input[type=text], input[type=email], input[type=password] { width: 100%; box-sizing: border-box; font-size: 1rem; padding: 0.5rem; border: 1px solid #b6afa2; border-radius: 0.4rem; }
  .row { display: flex; gap: 0.6rem; align-items: flex-start; padding: 0.55rem 0; border-bottom: 1px solid #e3ded4; }
  .row .grow { flex: 1; }
  .badge { font-size: 0.8rem; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 1rem; white-space: nowrap; }
  .b-pass { background: #dcefe2; color: #205c40; }
  .b-warn { background: #fdf0d3; color: #7a5a12; }
  .b-block { background: #fbe0dc; color: #8c2f1d; }
  .b-admin { background: #fdf0d3; color: #7a5a12; }
  .b-todo { background: #eceae6; color: #55504a; }
  .fix { color: #55504a; font-size: 0.92rem; margin-top: 0.2rem; }
  .bar { height: 0.6rem; background: #e3ded4; border-radius: 1rem; overflow: hidden; margin: 0.3rem 0 0.7rem; }
  .bar i { display: block; height: 100%; background: #205c40; width: 0; }
  pre { background: #22201d; color: #e8e4dc; padding: 0.8rem; border-radius: 0.5rem; overflow: auto; max-height: 22rem; font-size: 0.8rem; line-height: 1.35; white-space: pre-wrap; word-break: break-all; }
  .note { background: #fdf0d3; border-radius: 0.5rem; padding: 0.7rem 0.9rem; }
  .hidden { display: none; }
  .addr { font-size: 1.1rem; font-weight: 700; word-break: break-all; }
  fieldset { border: 1px solid #d8d2c6; border-radius: 0.5rem; margin-top: 1rem; }
  .rules li.ok { color: #205c40; }
  .rules li.miss { color: #8c2f1d; }
  #errorbar { color: #8c2f1d; font-weight: 600; }
</style>
</head>
<body>
<main>
  <header>
    <strong>Aman</strong>
    <button id="quit" class="small" data-text="close"></button>
  </header>
  <p id="errorbar" class="hidden"></p>

  <section class="screen" id="s-welcome">
    <h1 data-text="welcomeTitle"></h1>
    <p data-text="welcomeWhat"></p>
    <p data-text="welcomeTime"></p>
    <button class="primary" id="start" data-text="start"></button>
  </section>

  <section class="screen" id="s-checks">
    <h1 data-text="checksTitle"></h1>
    <p data-text="checksIntro"></p>
    <div id="checkrows"></div>
    <p class="note hidden" id="checks-blocked" data-text="checksBlocked"></p>
    <p><button class="primary" id="checks-continue" data-text="continue"></button></p>
  </section>

  <section class="screen" id="s-about">
    <h1 data-text="aboutTitle"></h1>
    <label for="email" data-text="emailLabel"></label>
    <input type="email" id="email" autocomplete="email">
    <label for="yourname" data-text="nameLabel"></label>
    <input type="text" id="yourname" autocomplete="name">
    <label for="pw1" data-text="passwordLabel"></label>
    <input type="password" id="pw1" autocomplete="new-password">
    <ul class="rules">
      <li id="rule-length" data-text="passwordRuleLength"></li>
      <li id="rule-number" data-text="passwordRuleNumber"></li>
      <li id="rule-symbol" data-text="passwordRuleSymbol"></li>
      <li id="rule-bytes" data-text="passwordRuleBytes"></li>
    </ul>
    <p id="pwmsg"></p>
    <label for="pw2" data-text="passwordAgainLabel"></label>
    <input type="password" id="pw2" autocomplete="new-password">
    <p><button class="primary" id="about-continue" data-text="continue"></button></p>
  </section>

  <section class="screen" id="s-options">
    <h1 data-text="optionsTitle"></h1>
    <label><input type="checkbox" id="backups" checked> <span data-text="backupsLabel"></span></label>
    <p class="fix" data-text="backupsNote"></p>
    <fieldset>
      <legend data-text="reachLabel"></legend>
      <label><input type="radio" name="reach" value="local"> <span data-text="reachLocal"></span></label>
      <label><input type="radio" name="reach" value="network"> <span data-text="reachNetwork"></span></label>
    </fieldset>
    <details>
      <summary data-text="advanced"></summary>
      <label for="em-provider" data-text="emailProviderLabel"></label>
      <input type="text" id="em-provider">
      <label for="em-address" data-text="emailAddressLabel"></label>
      <input type="text" id="em-address">
      <label for="em-password" data-text="emailPasswordLabel"></label>
      <input type="password" id="em-password">
      <label for="em-imap-host" data-text="emailImapHostLabel"></label>
      <input type="text" id="em-imap-host">
      <label for="em-imap-port" data-text="emailImapPortLabel"></label>
      <input type="text" id="em-imap-port">
      <label for="em-smtp-host" data-text="emailSmtpHostLabel"></label>
      <input type="text" id="em-smtp-host">
      <label for="em-smtp-port" data-text="emailSmtpPortLabel"></label>
      <input type="text" id="em-smtp-port">
      <label for="cal-provider" data-text="calendarProviderLabel"></label>
      <input type="text" id="cal-provider">
      <label for="cal-email" data-text="calendarEmailLabel"></label>
      <input type="text" id="cal-email">
      <label for="cal-url" data-text="calendarUrlLabel"></label>
      <input type="text" id="cal-url">
      <label for="cal-user" data-text="calendarUserLabel"></label>
      <input type="text" id="cal-user">
      <label for="cal-password" data-text="calendarPasswordLabel"></label>
      <input type="password" id="cal-password">
      <label for="tf-key" data-text="tokenFactoryKeyLabel"></label>
      <input type="password" id="tf-key">
      <label for="tf-model" data-text="tokenFactoryModelLabel"></label>
      <input type="text" id="tf-model">
      <label for="tf-cap" data-text="tokenFactoryCapLabel"></label>
      <input type="text" id="tf-cap">
    </details>
    <p><button id="options-back" data-text="back"></button>
    <button class="primary" id="options-continue" data-text="continue"></button></p>
  </section>

  <section class="screen" id="s-review">
    <h1 data-text="reviewTitle"></h1>
    <p data-text="reviewIntro"></p>
    <div id="planrows"></div>
    <h2 data-text="reviewDownloads"></h2>
    <div id="plandownloads"></div>
    <p><button id="review-back" data-text="back"></button>
    <button class="primary" id="install" data-text="install"></button></p>
  </section>

  <section class="screen" id="s-installing">
    <h1 data-text="installingTitle"></h1>
    <p data-text="installingNote"></p>
    <p><span data-text="elapsedLabel"></span>: <span id="elapsed">0:00</span></p>
    <p class="note hidden" id="admin-note" data-text="adminNote"></p>
    <div id="phases"></div>
    <p><button class="small" id="details-toggle" data-text="showDetails"></button></p>
    <pre id="runlog" class="hidden"></pre>
  </section>

  <section class="screen" id="s-failed">
    <h1 data-text="failedTitle"></h1>
    <p id="failed-what"></p>
    <p class="addr" id="failed-step"></p>
    <div id="retry-password-row" class="hidden">
      <label for="retry-password" data-text="retryPasswordLabel"></label>
      <input type="password" id="retry-password">
    </div>
    <div id="retry-tf-row" class="hidden">
      <label for="retry-tf" data-text="retryTokenFactoryKeyLabel"></label>
      <input type="password" id="retry-tf">
    </div>
    <div id="retry-cal-row" class="hidden">
      <label for="retry-cal" data-text="retryCalendarPasswordLabel"></label>
      <input type="password" id="retry-cal">
    </div>
    <div id="retry-em-row" class="hidden">
      <label for="retry-em" data-text="retryEmailPasswordLabel"></label>
      <input type="password" id="retry-em">
    </div>
    <div id="retry-admin" class="hidden">
      <p data-text="retryAdminIntro"></p>
      <div id="retry-admin-rows"></div>
    </div>
    <p>
      <button class="primary" id="try-again" data-text="tryAgain"></button>
      <button id="start-docker" class="hidden" data-text="startDocker"></button>
      <button class="small" id="failed-details-toggle" data-text="showDetails"></button>
      <button class="small" id="copy-log" data-text="copyLog"></button>
    </p>
    <pre id="failedlog" class="hidden"></pre>
  </section>

  <section class="screen" id="s-done">
    <h1 id="done-title"></h1>
    <p class="note hidden" id="done-warning" data-text="doneWarningNote"></p>
    <p><a id="open-aman" href="#"><button class="primary" data-text="openAman"></button></a></p>
    <p class="addr" id="done-address"></p>
    <div id="phone-block" class="hidden">
      <p data-text="phoneNote"></p>
      <p class="addr" id="phone-address"></p>
      <pre id="phone-qr"></pre>
    </div>
    <p id="done-backups"></p>
    <p data-text="gettingStarted"></p>
    <p><button class="small" id="done-details-toggle" data-text="showDetails"></button></p>
    <pre id="donelog" class="hidden"></pre>
  </section>

  <section class="screen" id="s-already">
    <h1 data-text="alreadyTitle"></h1>
    <p data-text="alreadyNote"></p>
    <p class="addr" id="already-address"></p>
  </section>

  <section class="screen" id="s-locked">
    <h1 data-text="lockedTitle"></h1>
    <p data-text="lockedNote"></p>
  </section>

  <section class="screen" id="s-closed">
    <p data-text="closedLine"></p>
  </section>
</main>
<script>
var WORDS = ${PAGE_WORDS};
var TEXT = WORDS.text;
var TOKEN = new URLSearchParams(location.search).get('t') || '';
var state = { installDocker: false, planId: null, checksBlocked: true, poll: null, log: '', dockerReady: false };

function el(id) { return document.getElementById(id); }
function show(id) {
  var screens = document.querySelectorAll('.screen');
  for (var i = 0; i < screens.length; i++) { screens[i].classList.remove('on'); }
  el(id).classList.add('on');
}
function showError(message) {
  var bar = el('errorbar');
  if (!message) { bar.classList.add('hidden'); bar.textContent = ''; return; }
  bar.textContent = message;
  bar.classList.remove('hidden');
}
function api(path, body) {
  var url = path + (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(TOKEN);
  var opts = { method: body === undefined ? 'GET' : 'POST', headers: {} };
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(url, opts).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (data) { return { status: r.status, data: data }; });
  });
}
function badge(stateName) {
  if (stateName === 'pass') { return '<span class="badge b-pass">' + TEXT.checkPass + '</span>'; }
  if (stateName === 'warn') { return '<span class="badge b-warn">' + TEXT.checkWarn + '</span>'; }
  if (stateName === 'block') { return '<span class="badge b-block">' + TEXT.checkBlock + '</span>'; }
  if (stateName === 'admin') { return '<span class="badge b-admin">' + TEXT.stateAdmin + '</span>'; }
  if (stateName === 'done') { return '<span class="badge b-pass">' + TEXT.stateDone + '</span>'; }
  if (stateName === 'todo') { return '<span class="badge b-todo">' + TEXT.stateTodo + '</span>'; }
  return '';
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderChecks(result) {
  state.checksBlocked = result.blocked;
  var html = '';
  result.rows.forEach(function (row) {
    html += '<div class="row"><div>' + badge(row.state === 'offer' ? 'warn' : row.state) + '</div><div class="grow">';
    html += '<div>' + esc(row.name) + '</div>';
    if (row.state === 'offer' && state.installDocker) { html += '<div class="fix">' + TEXT.dockerChosen + '</div>'; }
    if (row.fix) { html += '<div class="fix">' + esc(row.fix) + '</div>'; }
    html += '</div>';
    if (row.state === 'offer' && !state.installDocker) {
      html += '<button class="small" data-docker="1">' + TEXT.installDocker + '</button>';
    }
    if ((row.state === 'warn' || row.state === 'block') && row.id) {
      html += '<button class="small" data-recheck="' + row.id + '">' + TEXT.checkAgain + '</button>';
    }
    html += '</div>';
  });
  el('checkrows').innerHTML = html;
  el('checks-blocked').classList.toggle('hidden', !result.blocked);
  el('checks-continue').disabled = result.blocked;
  var dockerButtons = document.querySelectorAll('[data-docker]');
  dockerButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      state.installDocker = true;
      renderChecks(result);
    });
  });
  var recheckButtons = document.querySelectorAll('[data-recheck]');
  recheckButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      b.disabled = true;
      api('/api/checks/recheck', { id: b.getAttribute('data-recheck') }).then(function (res) {
        if (res.data && res.data.rows) { renderChecks(res.data); } else { b.disabled = false; }
      });
    });
  });
}

function runChecks() {
  showError('');
  el('checkrows').innerHTML = '<p>' + TEXT.working + '</p>';
  show('s-checks');
  api('/api/checks', {}).then(function (res) {
    if (res.data && res.data.rows) { renderChecks(res.data); }
    else { showError((res.data && res.data.error) || TEXT.working); }
  });
}

function pwBytes(pw) { return new TextEncoder().encode(pw).length; }
// The installer's symbol rule (password_problem, under LC_ALL=C): a
// symbol is one of the ASCII punctuation characters, nothing else. An
// accented letter does not count, here or in the installer.
function pwHasSymbol(pw) {
  for (var i = 0; i < pw.length; i++) {
    var c = pw.charCodeAt(i);
    if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) { return true; }
  }
  return false;
}
function pwLacks(pw) {
  var lacks = [];
  if (pwBytes(pw) < 8) { lacks.push(WORDS.lackLength); }
  if (!/[0-9]/.test(pw)) { lacks.push(WORDS.lackNumber); }
  if (!pwHasSymbol(pw)) { lacks.push(WORDS.lackSymbol); }
  return lacks;
}
function pwProblem(pw) {
  if (pwBytes(pw) > 72) { return WORDS.tooLong; }
  var lacks = pwLacks(pw);
  if (lacks.length === 0) { return ''; }
  if (lacks.length === 1) { return 'That password still needs ' + lacks[0] + '.'; }
  if (lacks.length === 2) { return 'That password still needs ' + lacks[0] + ' and ' + lacks[1] + '.'; }
  return 'That password still needs ' + lacks[0] + ', ' + lacks[1] + ' and ' + lacks[2] + '.';
}
function validateAbout() {
  var pw = el('pw1').value;
  var lacks = pwLacks(pw);
  el('rule-length').className = pwBytes(pw) >= 8 ? 'ok' : 'miss';
  el('rule-number').className = /[0-9]/.test(pw) ? 'ok' : 'miss';
  el('rule-symbol').className = pwHasSymbol(pw) ? 'ok' : 'miss';
  el('rule-bytes').className = pwBytes(pw) <= 72 ? 'ok' : 'miss';
  var problem = pw === '' ? WORDS.missing : pwProblem(pw);
  var message = problem;
  if (problem === '' && el('pw2').value !== '' && el('pw2').value !== pw) { message = WORDS.differ; }
  el('pwmsg').textContent = message;
  var ok = el('email').value.indexOf('@') > 0 && problem === '' && el('pw2').value === pw && pw !== '';
  el('about-continue').disabled = !ok;
  return ok;
}

function readAnswers() {
  var reach = 'network';
  var radios = document.querySelectorAll('input[name=reach]');
  radios.forEach(function (r) { if (r.checked) { reach = r.value; } });
  return {
    email: el('email').value,
    yourName: el('yourname').value,
    backups: el('backups').checked ? 'daily' : 'off',
    reach: reach,
    installDocker: state.installDocker,
    advanced: {
      emailProvider: el('em-provider').value, emailAddress: el('em-address').value,
      emailImapHost: el('em-imap-host').value, emailImapPort: el('em-imap-port').value,
      emailSmtpHost: el('em-smtp-host').value, emailSmtpPort: el('em-smtp-port').value,
      calendarProvider: el('cal-provider').value, calendarEmail: el('cal-email').value,
      calendarUrl: el('cal-url').value, calendarUser: el('cal-user').value,
      tokenFactoryModel: el('tf-model').value, tokenFactoryDailyCap: el('tf-cap').value
    }
  };
}
function readSecrets() {
  return {
    password: el('pw1').value,
    emailPassword: el('em-password').value,
    calendarPassword: el('cal-password').value,
    tokenFactoryKey: el('tf-key').value
  };
}

function renderPlan(plan) {
  state.planId = plan.planId;
  var html = '';
  plan.rows.forEach(function (row) {
    html += '<div class="row"><div>' + badge(row.state) + '</div><div class="grow">' + esc(row.text) + '</div></div>';
  });
  el('planrows').innerHTML = html;
  var dl = '';
  plan.downloads.forEach(function (d) {
    dl += '<div class="row"><div class="grow">' + esc(d.what) + '</div><div>' + d.sizeMb + ' MB</div></div>';
  });
  if (plan.totalMb) { dl += '<p><strong>' + WORDS.downloadsTotal.replace('{mb}', String(plan.totalMb)) + '</strong></p>'; }
  el('plandownloads').innerHTML = dl;
  show('s-review');
}

function fmtElapsed(seconds) {
  var m = Math.floor(seconds / 60);
  var s = Math.floor(seconds % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function renderProgress(data) {
  var progress = data.progress;
  el('elapsed').textContent = fmtElapsed(progress.elapsedSeconds || 0);
  var adminNote = el('admin-note');
  if (progress.adminPrompt) {
    adminNote.textContent = progress.adminPrompt;
    adminNote.classList.remove('hidden');
  } else {
    adminNote.classList.add('hidden');
  }
  var html = '';
  progress.phases.forEach(function (phase, index) {
    var total = Math.max(phase.steps.length, 1);
    var doneCount = 0;
    var current = '';
    phase.steps.forEach(function (step) {
      if (step.result) { doneCount++; current = step.resultName || step.startName; }
      else { current = step.startName; }
    });
    var pct = Math.round((doneCount / total) * 100);
    if (data.status !== 'running' || index < progress.phases.length - 1) { if (doneCount === total) { pct = 100; } }
    html += '<div><strong>' + esc(phase.name) + '</strong><div class="bar"><i style="width:' + pct + '%"></i></div>';
    if (current) { html += '<div class="fix">' + esc(current) + '</div>'; }
    html += '</div>';
  });
  el('phases').innerHTML = html;
  state.log = data.log || '';
  if (!el('runlog').classList.contains('hidden')) { el('runlog').textContent = state.log; }
}

function stopPolling() { if (state.poll) { clearInterval(state.poll); state.poll = null; } }

function enterInstalling() {
  show('s-installing');
  stopPolling();
  var tick = function () {
    api('/api/progress').then(function (res) {
      var data = res.data;
      if (!data || !data.progress) { return; }
      renderProgress(data);
      if (data.status === 'succeeded') { stopPolling(); showDone(data); }
      else if (data.status === 'failed') { stopPolling(); showFailed(data); }
    });
  };
  tick();
  state.poll = setInterval(tick, 1500);
}

function showDone(data) {
  var done = data.done || {};
  el('done-title').textContent = done.warning ? TEXT.doneWarningTitle : TEXT.doneTitle;
  el('done-warning').classList.toggle('hidden', !done.warning);
  if (done.warning && done.verdict) {
    el('done-warning').textContent = done.verdict;
  }
  if (done.publicUrl) {
    el('open-aman').href = done.publicUrl;
    el('done-address').textContent = done.publicUrl;
  }
  if (done.phoneUrl) {
    el('phone-block').classList.remove('hidden');
    el('phone-address').textContent = done.phoneUrl;
    el('phone-qr').textContent = done.qr || '';
    el('phone-qr').classList.toggle('hidden', !done.qr);
  } else {
    el('phone-block').classList.add('hidden');
  }
  el('done-backups').textContent = done.backups === 'daily' ? TEXT.backupsOnLine : TEXT.backupsOffLine;
  el('donelog').textContent = state.log;
  show('s-done');
}

function showFailed(data) {
  el('failed-what').textContent = data.dockerDown ? TEXT.dockerStoppedWhat + ' ' + TEXT.dockerStoppedNext : TEXT.failedWhat;
  el('failed-step').textContent = data.failedStep || '';
  el('failedlog').textContent = state.log;
  el('retry-password-row').classList.toggle('hidden', !data.needsPassword);
  el('retry-tf-row').classList.toggle('hidden', !data.needsTokenFactoryKey);
  el('retry-cal-row').classList.toggle('hidden', !data.needsCalendarPassword);
  el('retry-em-row').classList.toggle('hidden', !data.needsEmailPassword);
  var adminRows = data.retryAdminRows || [];
  var adminHtml = '';
  adminRows.forEach(function (row) {
    adminHtml += '<div class="row"><div>' + badge('admin') + '</div><div class="grow">' + esc(row.text) + '</div></div>';
  });
  el('retry-admin-rows').innerHTML = adminHtml;
  el('retry-admin').classList.toggle('hidden', adminRows.length === 0);
  el('start-docker').classList.toggle('hidden', !(data.dockerDown && data.startDockerAvailable));
  state.dockerReady = false;
  show('s-failed');
}

function refreshFailed() {
  api('/api/progress').then(function (res) {
    var data = res.data;
    if (data && data.progress && data.status === 'failed') {
      state.log = data.log || state.log;
      showFailed(data);
    }
  });
}

function boot() {
  var nodes = document.querySelectorAll('[data-text]');
  nodes.forEach(function (n) { n.textContent = TEXT[n.getAttribute('data-text')] || ''; });
  api('/api/state').then(function (res) {
    var data = res.data || {};
    if (data.mode === 'already') {
      el('already-address').textContent = data.publicUrl || '';
      show('s-already');
    } else if (data.mode === 'locked') {
      show('s-locked');
    } else if (data.mode === 'attach') {
      enterInstalling();
    } else {
      var radios = document.querySelectorAll('input[name=reach]');
      radios.forEach(function (r) { r.checked = r.value === (data.cloudVm ? 'local' : 'network'); });
      show('s-welcome');
    }
  });
}

el('quit').addEventListener('click', function () {
  api('/api/quit', {}).then(function () { show('s-closed'); });
});
el('start').addEventListener('click', runChecks);
el('checks-continue').addEventListener('click', function () { show('s-about'); validateAbout(); });
el('email').addEventListener('blur', function () {
  if (!el('yourname').value) {
    var at = el('email').value.indexOf('@');
    if (at > 0) { el('yourname').value = el('email').value.slice(0, at); }
  }
});
['email', 'pw1', 'pw2'].forEach(function (id) { el(id).addEventListener('input', validateAbout); });
el('about-continue').addEventListener('click', function () { show('s-options'); });
el('options-back').addEventListener('click', function () { show('s-about'); });
el('options-continue').addEventListener('click', function () {
  showError('');
  el('options-continue').disabled = true;
  api('/api/plan', { answers: readAnswers(), secrets: readSecrets() }).then(function (res) {
    el('options-continue').disabled = false;
    if (res.data && res.data.rows) { renderPlan(res.data); }
    else { showError((res.data && res.data.error) || TEXT.working); }
  });
});
el('review-back').addEventListener('click', function () { show('s-options'); });
el('install').addEventListener('click', function () {
  showError('');
  api('/api/install', { planId: state.planId }).then(function (res) {
    if (res.data && res.data.started) { enterInstalling(); }
    else { showError((res.data && res.data.error) || TEXT.working); show('s-review'); }
  });
});
el('details-toggle').addEventListener('click', function () {
  var log = el('runlog');
  var open = log.classList.toggle('hidden');
  el('details-toggle').textContent = open ? TEXT.showDetails : TEXT.hideDetails;
  if (!open) { log.textContent = state.log; }
});
el('failed-details-toggle').addEventListener('click', function () {
  var log = el('failedlog');
  var open = log.classList.toggle('hidden');
  el('failed-details-toggle').textContent = open ? TEXT.showDetails : TEXT.hideDetails;
});
el('done-details-toggle').addEventListener('click', function () {
  var log = el('donelog');
  var open = log.classList.toggle('hidden');
  el('done-details-toggle').textContent = open ? TEXT.showDetails : TEXT.hideDetails;
});
el('copy-log').addEventListener('click', function () {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(el('failedlog').textContent).then(function () {
      el('copy-log').textContent = TEXT.copied;
      setTimeout(function () { el('copy-log').textContent = TEXT.copyLog; }, 1500);
    });
  }
});
el('start-docker').addEventListener('click', function () {
  el('start-docker').disabled = true;
  api('/api/start-docker', {}).then(function () { state.dockerReady = true; el('start-docker').disabled = false; });
});
el('try-again').addEventListener('click', function () {
  showError('');
  var body = {
    password: el('retry-password').value,
    tokenFactoryKey: el('retry-tf').value,
    calendarPassword: el('retry-cal').value,
    emailPassword: el('retry-em').value
  };
  api('/api/retry', body).then(function (res) {
    if (res.data && res.data.started) {
      el('retry-password').value = '';
      el('retry-tf').value = '';
      el('retry-cal').value = '';
      el('retry-em').value = '';
      enterInstalling();
    } else {
      showError((res.data && res.data.error) || TEXT.working);
      refreshFailed();
    }
  });
});
boot();
</script>
</body>
</html>
`;
}
