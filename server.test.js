'use strict';

const assert = require('node:assert/strict');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

// Never inherit the application's DB_NAME, host, credentials, TLS or disk storage.
const databaseName = `add_work_test_${process.pid}_${randomBytes(8).toString('hex')}`;
const databaseHost = process.env.TEST_DB_HOST || '127.0.0.1';
assert.ok(['127.0.0.1', '::1'].includes(databaseHost), 'TEST_DB_HOST must be a literal loopback address');
const databasePort = Number(process.env.TEST_DB_PORT || 3306);
assert.ok(Number.isInteger(databasePort) && databasePort > 0 && databasePort <= 65535, 'Invalid TEST_DB_PORT');
const connectionOptions = {
  host: databaseHost,
  port: databasePort,
  user: process.env.TEST_DB_USER || 'root',
  password: process.env.TEST_DB_PASSWORD ?? '808080',
  charset: 'utf8mb4',
  connectTimeout: 5000
};
Object.assign(process.env, {
  DB_NAME: databaseName,
  DB_HOST: databaseHost,
  DB_PORT: String(databasePort),
  DB_USER: connectionOptions.user,
  DB_PASSWORD: connectionOptions.password,
  FILE_STORAGE: 'db'
});
delete process.env.DB_SSL;

const tables = [
  'app_events', 'interviews', 'messages', 'contact_requests', 'notifications',
  'operation_logs', 'resume_history', 'job_history', 'favorites', 'follows',
  'applications', 'resumes', 'jobs', 'sessions', 'sms_codes', 'files', 'users'
];
const password = 'T3st!789';
const pdf = Buffer.from('%PDF-1.4\n% regression fixture, never written to disk\n%%EOF\n');
let control, pool, server, origin, passwordHash, fixtures;
let ownsDatabase = false;
let schemaReady = false;
let serial = 0;

function assertOwnedDatabase() {
  assert.match(databaseName, /^add_work_test_\d+_[a-f0-9]{16}$/);
  assert.equal(ownsDatabase, true, 'Refuse to operate on a database not created by this run');
}

async function clearFixtures() {
  assertOwnedDatabase();
  const [[row]] = await pool.query('SELECT DATABASE() AS name');
  assert.equal(row.name, databaseName);
  for (const table of tables) await pool.query(`DELETE FROM \`${table}\``);
}

async function insert(table, values) {
  assertOwnedDatabase();
  assert.ok(tables.includes(table), 'Only known fixture tables may be written');
  const [result] = await pool.query(`INSERT INTO \`${table}\` SET ?`, [values]);
  return result.insertId;
}

async function createUser(role, values = {}) {
  const user = {
    username: `regression_${++serial}_${randomBytes(4).toString('hex')}`,
    password: passwordHash,
    role,
    name: `回归${role}${serial}`,
    status: 'active',
    ...(role === 'company' ? { company_name: `回归企业${serial}`, verified: 1 } : {}),
    ...values
  };
  user.id = await insert('users', user);
  user.token = randomBytes(24).toString('hex');
  await insert('sessions', {
    user_id: user.id, token: user.token, expires_at: new Date(Date.now() + 86400000)
  });
  return user;
}

async function createJob(company, values = {}) {
  return insert('jobs', {
    company_id: company.id, title: '回归前端工程师', requirements: 'React,JavaScript',
    location: '回归城', salary_min: 10000, salary_max: 20000,
    education: '本科', experience: '3年', status: 'published', ...values
  });
}

async function seedFixtures() {
  const seeker = await createUser('seeker', { name: '回归求职者', phone: '13980000001' });
  const otherSeeker = await createUser('seeker', { phone: '13980000002' });
  const company = await createUser('company', { phone: '13880000001', license_path: 'regression-license.pdf' });
  const otherCompany = await createUser('company', { phone: '13880000002' });
  const admin = await createUser('admin');
  for (const name of ['regression-resume.pdf', 'regression-license.pdf']) {
    await insert('files', { name, mime: 'application/pdf', size: pdf.length, data: pdf });
  }
  const resume = await insert('resumes', {
    user_id: seeker.id, name: seeker.name, title: '回归简历', skills: 'React,JavaScript',
    experience: '5年前端开发', education: '本科', visibility: 'public', is_default: 1,
    attachment_name: 'resume.pdf', attachment_path: 'regression-resume.pdf'
  });
  const job = await createJob(company);
  const otherJob = await createJob(otherCompany, { title: '回归其他企业职位' });
  const application = await insert('applications', {
    resume_id: resume, seeker_id: seeker.id, job_id: job, company_id: company.id,
    status: 'submitted', match_score: 100, match_reasons: '技能与经验符合'
  });
  return { seeker, otherSeeker, company, otherCompany, admin, resume, job, otherJob, application };
}

async function request(path, { user, cookie = false, method = 'GET', body } = {}) {
  const headers = {};
  if (user) {
    if (cookie) headers.Cookie = `sid=${encodeURIComponent(user.token)}`;
    else headers.Authorization = `Bearer ${user.token}`;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(origin + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual', signal: AbortSignal.timeout(10000)
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString('utf8');
  const json = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
  return { status: response.status, headers: response.headers, buffer, text, json, path, method };
}

function expectJSON(response, status = 200) {
  assert.equal(response.status, status, `${response.method} ${response.path}: ${response.text}`);
  assert.ok(response.json, `Expected JSON from ${response.path}`);
  assert.equal(response.json.ok, status < 400, response.text);
  return response.json.data;
}

async function api(path, options = {}) {
  return expectJSON(await request(path, options), options.status ?? 200);
}

function query(path, parameters) {
  return `${path}?${new URLSearchParams(parameters)}`;
}

function assertNoKeys(value, keys) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!keys.includes(key), `Unexpected sensitive field: ${key}`);
    assertNoKeys(child, keys);
  }
}

function assertNoPhones(value) {
  const text = JSON.stringify(value);
  for (const user of [fixtures.seeker, fixtures.company]) assert.ok(!text.includes(user.phone), 'Phone leaked before consent');
}

function expectFile(response, download = false) {
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.buffer, pdf);
  assert.match(response.headers.get('content-type'), /^application\/pdf\b/);
  assert.match(response.headers.get('content-disposition'), download ? /^attachment;/ : /^inline;/);
  assert.equal(response.headers.get('content-security-policy'), null, 'CSP must not block file preview');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
}

async function applicationRow() {
  const [[row]] = await pool.query('SELECT * FROM applications WHERE id = ?', [fixtures.application]);
  return row;
}

async function events(user = fixtures.seeker) {
  return api(`/api/applications/${fixtures.application}/events`, { user });
}

async function disableCompany() {
  await api(`/api/admin/users/${fixtures.company.id}/status`, {
    user: fixtures.admin, method: 'PATCH', body: { status: 'banned' }
  });
}

async function contactRequest() {
  const result = await api('/api/contact/request', {
    user: fixtures.seeker, method: 'POST',
    body: { toUserId: fixtures.company.id, jobId: fixtures.job }
  });
  assertNoPhones(result);
  const [[row]] = await pool.query('SELECT * FROM contact_requests WHERE from_user_id = ? AND to_user_id = ?',
    [fixtures.seeker.id, fixtures.company.id]);
  assert.equal(row.status, 'pending');
  return row.id;
}

async function contactLists(id, status, accepted = false) {
  const sent = await api('/api/contact/requests', { user: fixtures.seeker });
  const received = await api('/api/contact/requests', { user: fixtures.company });
  const fromView = sent.sent.find((row) => row.id === id);
  const toView = received.received.find((row) => row.id === id);
  assert.ok(fromView && toView, 'Both participants must see the same request');
  assert.equal(fromView.status, status);
  assert.equal(toView.status, status);
  assert.equal(fromView.peer_phone, accepted ? fixtures.company.phone : null);
  assert.equal(toView.peer_phone, accepted ? fixtures.seeker.phone : null);
  assertNoKeys([fromView, toView], ['phone', 'password', 'token']);
  if (!accepted) { assertNoPhones(sent); assertNoPhones(received); }
}

async function messageFixtures() {
  const { seeker, company, otherSeeker, otherCompany } = fixtures;
  const values = Array.from({ length: 237 }, (_, index) => [
    index % 2 === 0 ? company.id : seeker.id,
    index % 2 === 0 ? seeker.id : company.id,
    `history-${String(index).padStart(3, '0')}`, 0, '2024-01-01 12:00:00'
  ]);
  values.push(
    [otherCompany.id, seeker.id, 'another peer, still unread', 0, '2024-01-01 12:00:00'],
    [otherSeeker.id, otherCompany.id, 'private third-party conversation', 0, '2024-01-01 12:00:00'],
    [company.id, otherSeeker.id, 'not addressed to the main seeker', 0, '2024-01-01 12:00:00']
  );
  await pool.query('INSERT INTO messages (from_user_id, to_user_id, content, is_read, created_at) VALUES ?', [values]);
  const [all] = await pool.query('SELECT * FROM messages ORDER BY id');
  const conversation = all.filter((row) =>
    (row.from_user_id === seeker.id && row.to_user_id === company.id) ||
    (row.from_user_id === company.id && row.to_user_id === seeker.id));
  assert.equal(conversation.length, 237);
  return { all, conversation };
}

async function assertReadRows(all, readIds) {
  const [rows] = await pool.query('SELECT id, is_read FROM messages ORDER BY id');
  assert.deepEqual(rows.map((row) => row.id), all.map((row) => row.id));
  for (const row of rows) assert.equal(row.is_read, readIds.has(row.id) ? 1 : 0, `Incorrect is_read for message ${row.id}`);
}

function future(hours = 24) {
  // DATETIME has second precision; use exact round-trippable timestamps.
  return new Date(Math.floor(Date.now() / 1000) * 1000 + hours * 3600000).toISOString();
}

async function interviewRow(id) {
  const [[row]] = await pool.query('SELECT * FROM interviews WHERE id = ?', [id]);
  return row;
}

async function invite(scheduledAt = future()) {
  const meeting = await api(`/api/applications/${fixtures.application}/interview`, {
    user: fixtures.company, method: 'POST', body: { scheduledAt, provider: 'tencent', note: '首轮面试' }
  });
  assert.equal(meeting.provider, 'tencent');
  const [rows] = await pool.query('SELECT * FROM interviews WHERE application_id = ?', [fixtures.application]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.scheduled_at.toISOString(), scheduledAt);
  assert.equal(row.proposed_at, null);
  assert.equal(row.link, meeting.url);
  assert.equal((await applicationRow()).status, 'interview');
  return row.id;
}

async function propose(id, newTime) {
  await api(`/api/interviews/${id}/respond`, {
    user: fixtures.seeker, method: 'POST', body: { action: 'reschedule', newTime, note: '希望晚一天' }
  });
}

function assertTimeEvent(rows, action, original, proposed, actor) {
  const matching = rows.filter((row) => row.action === action);
  assert.equal(matching.length, 1, `Expected exactly one ${action} event`);
  assert.equal(matching[0].actor_id, actor.id);
  assert.ok(matching[0].detail.includes(original), 'Event lost the original time');
  if (proposed) assert.ok(matching[0].detail.includes(proposed), 'Event lost the proposed time');
  return matching[0];
}

// A small CSV reader keeps assertions exact even for quoted commas/newlines/quotes.
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell); cell = '';
    } else if (char === '\n' && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  assert.equal(quoted, false, 'CSV must have balanced quotes');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [headers, ...records] = rows;
  return records.map((values) => {
    assert.equal(values.length, headers.length, 'CSV column count changed');
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

describe('MySQL + HTTP integration regression (isolated loopback database)', { concurrency: false }, () => {
  before(async () => {
    assert.match(databaseName, /^add_work_test_\d+_[a-f0-9]{16}$/);
    assert.equal(require.cache[require.resolve('./db')], undefined, 'db.js must not be imported before isolation');
    control = await mysql.createConnection(connectionOptions);
    // No IF NOT EXISTS: a collision is an error, never permission to reuse/drop a database.
    await control.query(`CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    ownsDatabase = true;
    const db = require('./db');
    pool = db.pool;
    const [[selected]] = await pool.query('SELECT DATABASE() AS name');
    assert.equal(selected.name, databaseName);
    await db.init();
    schemaReady = true;
    passwordHash = db.hashPassword(password);
    await clearFixtures();
    const app = require('./server');
    assert.equal(require('./storage').MODE, 'db');
    await new Promise((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
  }, { timeout: 60000 });

  beforeEach(async () => { fixtures = await seedFixtures(); });
  afterEach(async () => { if (schemaReady) await clearFixtures(); });

  after(async () => {
    // Run every cleanup step even if setup, a test, or an earlier cleanup step failed.
    const failures = [];
    if (server) {
      try {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      } catch (error) { failures.push(error); }
    }
    if (pool) {
      try { await pool.end(); } catch (error) { failures.push(error); }
    }
    if (control) {
      try {
        if (ownsDatabase) {
          assertOwnedDatabase();
          await control.query(`DROP DATABASE \`${databaseName}\``);
          ownsDatabase = false;
          const [left] = await control.query('SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?', [databaseName]);
          assert.equal(left.length, 0, 'Temporary database was not removed');
        }
      } catch (error) { failures.push(error); }
      finally {
        try { await control.end(); } catch (error) { failures.push(error); }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Integration-test cleanup failed');
  }, { timeout: 30000 });

  it('runs against its owned database and a real loopback HTTP server', async () => {
    const [[row]] = await pool.query('SELECT DATABASE() AS name');
    assert.equal(row.name, databaseName);
    const response = await request('/healthz');
    expectJSON(response);
    assert.equal(response.json.db, true);
    assert.equal((await api('/api/me', { user: fixtures.seeker, cookie: true })).id, fixtures.seeker.id);
    await api('/api/me', { status: 401 });
  });

  for (const endpoint of ['code', 'forgot', 'reset']) {
    it(`public /api/auth/${endpoint} fails closed with 503 and cannot issue/use a code`, async () => {
      await insert('sms_codes', {
        phone: fixtures.seeker.phone, code: '987654', purpose: 'reset', used: 0,
        expires_at: new Date(Date.now() + 600000)
      });
      const response = await request(`/api/auth/${endpoint}`, {
        method: 'POST', body: { phone: fixtures.seeker.phone, username: fixtures.seeker.username,
          code: '987654', purpose: 'reset', password: 'Changed9', newPassword: 'Changed9' }
      });
      expectJSON(response, 503);
      assertNoKeys(response.json, ['code', 'token']);
      assert.ok(!response.text.includes('987654'));
      assert.equal(response.headers.get('set-cookie'), null);
      const [[user]] = await pool.query('SELECT password FROM users WHERE id = ?', [fixtures.seeker.id]);
      assert.equal(user.password, passwordHash);
      const [codes] = await pool.query('SELECT code, used FROM sms_codes');
      assert.deepEqual(codes.map((row) => ({ ...row })), [{ code: '987654', used: 0 }]);
      const [[sessions]] = await pool.query('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?', [fixtures.seeker.id]);
      assert.equal(sessions.count, 1);
    });
  }

  it('public resume files allow owner/admin/companies but not another seeker or anonymous requests', async () => {
    for (const user of [fixtures.seeker, fixtures.admin, fixtures.company, fixtures.otherCompany]) {
      expectFile(await request('/uploads/regression-resume.pdf', { user, cookie: true }));
    }
    await api('/uploads/regression-resume.pdf', { user: fixtures.otherSeeker, status: 403 });
    await api('/uploads/regression-resume.pdf', { status: 401 });
  });

  it('targeted resume files allow only an applied-to company, owner and admin', async () => {
    await pool.query("UPDATE resumes SET visibility = 'targeted' WHERE id = ?", [fixtures.resume]);
    for (const user of [fixtures.seeker, fixtures.admin, fixtures.company]) {
      expectFile(await request('/uploads/regression-resume.pdf', { user }));
    }
    for (const user of [fixtures.otherSeeker, fixtures.otherCompany]) {
      await api('/uploads/regression-resume.pdf', { user, status: 403 });
    }
    expectFile(await request(`/api/applications/${fixtures.application}/attachment`, { user: fixtures.company }));
  });

  it('hidden resumes revoke access even from the original application company and redact received data', async () => {
    await pool.query("UPDATE resumes SET visibility = 'hidden' WHERE id = ?", [fixtures.resume]);
    for (const user of [fixtures.seeker, fixtures.admin]) expectFile(await request('/uploads/regression-resume.pdf', { user }));
    for (const user of [fixtures.otherSeeker, fixtures.company, fixtures.otherCompany]) {
      await api('/uploads/regression-resume.pdf', { user, status: 403 });
    }
    for (const suffix of ['', '?download=1']) {
      await api(`/api/applications/${fixtures.application}/attachment${suffix}`, { user: fixtures.company, status: 403 });
    }
    const received = await api('/api/applications/received', { user: fixtures.company });
    const row = received.find((item) => item.id === fixtures.application);
    assert.equal(row.candidate, '简历不可见');
    for (const field of ['skills', 'experience', 'education', 'attachment_name', 'attachment_path', 'match_reasons']) assert.equal(row[field], null);
    assert.deepEqual(await events(), []);
    assert.equal((await applicationRow()).status, 'submitted');
  });

  it('company licenses are private to their owner and admin, including when the name is known', async () => {
    for (const user of [fixtures.company, fixtures.admin]) expectFile(await request('/uploads/regression-license.pdf', { user }));
    for (const user of [fixtures.seeker, fixtures.otherSeeker, fixtures.otherCompany]) {
      await api('/uploads/regression-license.pdf', { user, status: 403 });
    }
    await api('/uploads/regression-license.pdf', { status: 401 });
  });

  it('application attachment authorization rejects non-owners without creating activity', async () => {
    for (const user of [fixtures.otherCompany, fixtures.seeker, fixtures.admin]) {
      await api(`/api/applications/${fixtures.application}/attachment`, { user, status: 403 });
      await api(`/api/applications/${fixtures.application}/attachment?download=1`, { user, status: 403 });
    }
    await api(`/api/applications/${fixtures.application}/attachment`, { status: 401 });
    assert.deepEqual(await events(), []);
    assert.equal((await applicationRow()).status, 'submitted');
  });

  it('application preview/download omit CSP and deduplicate concurrent viewed/downloaded events', async () => {
    const path = `/api/applications/${fixtures.application}/attachment`;
    const previews = await Promise.all(Array.from({ length: 3 }, () => request(path, { user: fixtures.company })));
    previews.forEach((response) => expectFile(response));
    const downloads = await Promise.all(Array.from({ length: 3 }, () => request(path + '?download=1', { user: fixtures.company, cookie: true })));
    downloads.forEach((response) => expectFile(response, true));
    const history = await events();
    assert.deepEqual(history.map((row) => row.action).sort(), ['downloaded', 'viewed']);
    assert.ok(history.every((row) => row.actor_id === fixtures.company.id));
    assert.equal((await applicationRow()).status, 'viewed');
    assert.deepEqual(await events(fixtures.company), history);
    for (const user of [fixtures.otherCompany, fixtures.otherSeeker]) {
      await api(`/api/applications/${fixtures.application}/events`, { user, status: 403 });
    }
    await pool.query("UPDATE applications SET status = 'accepted' WHERE id = ?", [fixtures.application]);
    expectFile(await request(path, { user: fixtures.company }));
    assert.equal((await applicationRow()).status, 'accepted', 'Preview must not regress a later application status');
    assert.equal((await events()).length, 2);
  });

  async function sortJobs() {
    const pinned = await createJob(fixtures.company, { title: 'sortcase pinned', requirements: 'Rust', education: '博士', experience: '20年', salary_min: 1000, salary_max: 2000, is_top: 1 });
    const best = await createJob(fixtures.company, { title: 'sortcase best', salary_min: 20000, salary_max: 30000 });
    const partial = await createJob(fixtures.company, { title: 'sortcase partial', requirements: 'React,Python', salary_min: 10000, salary_max: 20000 });
    const mismatch = await createJob(fixtures.company, { title: 'sortcase mismatch', requirements: 'Rust', education: '博士', experience: '20年', salary_min: 30000, salary_max: 40000 });
    return { pinned, best, partial, mismatch };
  }

  it('job match ordering scores the Cookie user before pagination, preserving pinned priority', async () => {
    const { pinned, best, partial, mismatch } = await sortJobs();
    const firstPath = query('/api/jobs', { keyword: 'sortcase', sort: 'match', pageSize: 2, page: 1 });
    const first = await api(firstPath, { user: fixtures.seeker, cookie: true });
    assert.deepEqual(first.list.map((job) => job.id), [pinned, best]);
    assert.deepEqual(first.list.map((job) => job.match.score), [0, 100]);
    assert.match(first.list[1].match.reasons, /技能吻合/);
    assert.deepEqual([first.total, first.page, first.pageSize, first.pages], [4, 1, 2, 2]);
    const next = await api(query('/api/jobs', { keyword: 'sortcase', sort: 'match', pageSize: 2, page: 2 }), { user: fixtures.seeker, cookie: true });
    assert.deepEqual(next.list.map((job) => job.id), [partial, mismatch]);
    assert.deepEqual(next.list.map((job) => job.match.score), [70, 0]);
    assert.deepEqual(await api(firstPath, { user: fixtures.seeker }), first);
    const anonymous = await api(firstPath);
    assert.ok(anonymous.list.every((job) => !Object.hasOwn(job, 'match')), 'Anonymous request must not reuse another user\'s resume');
  });

  for (const sort of ['salaryAsc', 'salaryDesc']) {
    it(`jobs ${sort} orders numeric salaries, pinned first and unspecified salaries last`, async () => {
      const { pinned, best, partial, mismatch } = await sortJobs();
      const unspecified = await createJob(fixtures.company, { title: 'sortcase unspecified', salary_min: null, salary_max: null });
      const result = await api(query('/api/jobs', { keyword: 'sortcase', sort, pageSize: 50 }), { user: fixtures.seeker, cookie: true });
      assert.deepEqual(result.list.map((job) => job.id), sort === 'salaryAsc'
        ? [pinned, partial, best, mismatch, unspecified] : [pinned, mismatch, best, partial, unspecified]);
      assert.equal(result.total, 5);
    });
  }

  it('company /api/jobs/mine exposes exact apply_count, including zero, without other companies\' jobs', async () => {
    const emptyJob = await createJob(fixtures.company, { title: '零投递职位' });
    const secondResume = await insert('resumes', { user_id: fixtures.otherSeeker.id, name: '第二位求职者' });
    await insert('applications', { resume_id: secondResume, seeker_id: fixtures.otherSeeker.id, company_id: fixtures.company.id, job_id: fixtures.job });
    const jobs = await api('/api/jobs/mine', { user: fixtures.company, cookie: true });
    assert.equal(jobs.find((job) => job.id === fixtures.job).apply_count, 2);
    assert.equal(jobs.find((job) => job.id === emptyJob).apply_count, 0);
    assert.ok(jobs.every((job) => job.company_id === fixtures.company.id));
    assert.ok(!jobs.some((job) => job.id === fixtures.otherJob));
  });

  it('disabled companies disappear from public/salary/match searches and their sessions are revoked', async () => {
    assert.ok((await api('/api/jobs')).list.some((job) => job.id === fixtures.job));
    await disableCompany();
    for (const sort of ['latest', 'salaryAsc', 'salaryDesc', 'match']) {
      const result = await api(query('/api/jobs', { sort }), { user: fixtures.seeker, cookie: true });
      assert.equal(result.total, 1);
      assert.deepEqual(result.list.map((job) => job.id), [fixtures.otherJob]);
    }
    assert.deepEqual((await api('/api/jobs')).list.map((job) => job.id), [fixtures.otherJob]);
    await api('/api/me', { user: fixtures.company, status: 401 });
    const [[sessions]] = await pool.query('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?', [fixtures.company.id]);
    assert.equal(sessions.count, 0);
  });

  it('disabled companies disappear from recommendations, without hiding active companies', async () => {
    const path = '/api/recommend/jobs';
    assert.ok((await api(path, { user: fixtures.seeker })).some((job) => job.id === fixtures.job));
    await disableCompany();
    const result = await api(path, { user: fixtures.seeker });
    assert.deepEqual(result.map((job) => job.id), [fixtures.otherJob]);
  });

  it('disabled company job details are blocked and do not increment exposure', async () => {
    assert.equal((await api(`/api/jobs/${fixtures.job}`)).id, fixtures.job);
    const [[before]] = await pool.query('SELECT view_count FROM jobs WHERE id = ?', [fixtures.job]);
    await disableCompany();
    await api(`/api/jobs/${fixtures.job}`, { status: 400 });
    const [[after]] = await pool.query('SELECT view_count FROM jobs WHERE id = ?', [fixtures.job]);
    assert.equal(after.view_count, before.view_count);
  });

  it('disabled company homepages are blocked rather than disclosing company or jobs', async () => {
    const path = `/api/company/${fixtures.company.id}`;
    const active = await api(path, { user: fixtures.seeker });
    assert.equal(active.company.id, fixtures.company.id);
    assert.ok(active.jobs.some((job) => job.id === fixtures.job));
    await disableCompany();
    const blocked = await request(path, { user: fixtures.seeker });
    expectJSON(blocked, 400);
    assertNoKeys(blocked.json, ['company', 'jobs', 'phone']);
  });

  it('similar jobs reject a disabled source and exclude disabled candidates for an active source', async () => {
    const activePath = `/api/jobs/${fixtures.otherJob}/similar`;
    assert.ok((await api(activePath)).some((job) => job.id === fixtures.job));
    await disableCompany();
    await api(`/api/jobs/${fixtures.job}/similar`, { status: 400 });
    assert.deepEqual(await api(activePath), []);
  });

  it('applying to a disabled company is blocked without inserting applications or notifications', async () => {
    const job = await createJob(fixtures.company, { title: '尚未投递的职位' });
    assert.equal((await api(`/api/jobs/${job}`)).id, job);
    await disableCompany();
    await api(`/api/jobs/${job}/apply`, { user: fixtures.seeker, method: 'POST', body: { resumeId: fixtures.resume }, status: 400 });
    const [[applications]] = await pool.query('SELECT COUNT(*) AS count FROM applications WHERE job_id = ?', [job]);
    assert.equal(applications.count, 0);
    const [[notifications]] = await pool.query("SELECT COUNT(*) AS count FROM notifications WHERE type = 'application'");
    assert.equal(notifications.count, 0);
    assert.deepEqual(await events(), []);
  });

  it('pending contact exchange never exposes either phone and is visible only to participants', async () => {
    const id = await contactRequest();
    await contactLists(id, 'pending');
    for (const user of [fixtures.otherSeeker, fixtures.otherCompany]) {
      assert.deepEqual(await api('/api/contact/requests', { user }), { received: [], sent: [] });
    }
    await api('/api/contact/request', { user: fixtures.seeker, method: 'POST', body: { toUserId: fixtures.company.id }, status: 400 });
    const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM contact_requests');
    assert.equal(count.count, 1);
  });

  it('contact accept requires a JSON boolean, not truthy strings/numbers/objects or an omitted value', async () => {
    const id = await contactRequest();
    for (const accept of ['false', 'true', 0, 1, null, {}, [], undefined]) {
      const response = await request(`/api/contact/requests/${id}/respond`, {
        user: fixtures.company, method: 'POST', body: accept === undefined ? {} : { accept }
      });
      expectJSON(response, 400);
      assertNoPhones(response.json);
      await contactLists(id, 'pending');
    }
  });

  it('only the recipient can accept and both participants then see the correct peer_phone once', async () => {
    const id = await contactRequest();
    const path = `/api/contact/requests/${id}/respond`;
    for (const user of [fixtures.seeker, fixtures.otherSeeker, fixtures.otherCompany, fixtures.admin]) {
      const response = await request(path, { user, method: 'POST', body: { accept: true } });
      expectJSON(response, 403);
      assertNoPhones(response.json);
    }
    await contactLists(id, 'pending');
    const accepted = await api(path, { user: fixtures.company, method: 'POST', body: { accept: true } });
    assert.equal(accepted.phone, fixtures.seeker.phone);
    await contactLists(id, 'accepted', true);
    const [before] = await pool.query("SELECT id FROM notifications WHERE type = 'contact'");
    for (const accept of [true, false]) await api(path, { user: fixtures.company, method: 'POST', body: { accept }, status: 409 });
    await contactLists(id, 'accepted', true);
    const [after] = await pool.query("SELECT id FROM notifications WHERE type = 'contact'");
    assert.deepEqual(after, before, 'Repeated responses must not duplicate notifications');
  });

  it('a boolean false rejects without phone disclosure and cannot be consumed again', async () => {
    const id = await contactRequest();
    const path = `/api/contact/requests/${id}/respond`;
    const rejected = await api(path, { user: fixtures.company, method: 'POST', body: { accept: false } });
    assert.equal(rejected.phone, null);
    assertNoPhones(rejected);
    await contactLists(id, 'rejected');
    await api(path, { user: fixtures.company, method: 'POST', body: { accept: true }, status: 409 });
    await contactLists(id, 'rejected');
  });

  it('concurrent contact responses consume pending exactly once', async () => {
    const id = await contactRequest();
    const results = await Promise.all([true, false].map((accept) => request(`/api/contact/requests/${id}/respond`, {
      user: fixtures.company, method: 'POST', body: { accept }
    })));
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
    results.forEach((response) => expectJSON(response, response.status));
    const accepted = results[0].status === 200;
    await contactLists(id, accepted ? 'accepted' : 'rejected', accepted);
  });

  it('chat returns the newest 50 of >200 rows, cursors backwards, and reads only incoming rows on returned pages', async () => {
    const { all, conversation } = await messageFixtures();
    const path = `/api/messages/${fixtures.company.id}`;
    const initialThreads = await api('/api/messages/threads', { user: fixtures.seeker });
    assert.equal(Number(initialThreads.find((thread) => thread.peer_id === fixtures.company.id).unread), 119);
    const first = await api(path, { user: fixtures.seeker });
    assert.equal(first.peer.id, fixtures.company.id);
    assert.equal(first.messages.length, 50);
    assert.deepEqual(first.messages.map((message) => message.id), conversation.slice(-50).map((message) => message.id));
    assert.equal(first.hasMore, true);
    assert.equal(first.nextBefore, first.messages[0].id);
    const readIds = new Set();
    const seen = new Set();
    function remember(page) {
      for (const message of page.messages) {
        assert.equal(seen.has(message.id), false, 'Cursor pages must not overlap');
        seen.add(message.id);
        const incoming = message.to_user_id === fixtures.seeker.id;
        assert.equal(message.is_read, incoming ? 1 : 0, 'Response must expose updated read status without reading outgoing messages');
        if (incoming) readIds.add(message.id);
      }
    }
    remember(first);
    await assertReadRows(all, readIds);
    const threads = await api('/api/messages/threads', { user: fixtures.seeker });
    assert.equal(Number(threads.find((thread) => thread.peer_id === fixtures.company.id).unread), 94);
    let page = await api(query(path, { before: first.nextBefore }), { user: fixtures.seeker });
    assert.deepEqual(page.messages.map((message) => message.id), conversation.slice(-100, -50).map((message) => message.id));
    remember(page);
    await assertReadRows(all, readIds);
    while (page.hasMore) {
      const cursor = page.nextBefore;
      page = await api(query(path, { before: cursor }), { user: fixtures.seeker });
      assert.ok(page.messages.every((message) => message.id < cursor));
      remember(page);
      await assertReadRows(all, readIds);
    }
    assert.equal(page.messages.length, 37);
    assert.equal(page.nextBefore, null);
    assert.equal(seen.size, 237);
    assert.deepEqual([...seen].sort((a, b) => a - b), conversation.map((message) => message.id));
    const empty = await api(query(path, { before: conversation[0].id }), { user: fixtures.seeker });
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.hasMore, false);
    assert.equal(empty.nextBefore, null);
  });

  it('chat cannot expose or mark read another pair\'s conversation by guessing user IDs', async () => {
    const { all, conversation } = await messageFixtures();
    const result = await api(query(`/api/messages/${fixtures.company.id}`, {
      from_user_id: fixtures.seeker.id, to_user_id: fixtures.company.id, userId: fixtures.seeker.id
    }), { user: fixtures.otherCompany });
    assert.deepEqual(result.messages, []);
    assert.equal(result.nextBefore, null);
    const ownThread = await api(`/api/messages/${fixtures.seeker.id}`, { user: fixtures.otherCompany });
    assert.equal(ownThread.messages.length, 1);
    assert.equal(ownThread.messages[0].content, 'another peer, still unread');
    assert.ok(!ownThread.messages.some((row) => conversation.some((privateRow) => privateRow.id === row.id)));
    await assertReadRows(all, new Set());
    await api(`/api/messages/${fixtures.company.id}`, { status: 401 });
  });

  it('invalid chat cursors/limits fail without marking any rows read', async () => {
    const { all } = await messageFixtures();
    for (const parameters of [{ before: 0 }, { before: -1 }, { before: 'NaN' }, { before: 1.5 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }]) {
      await api(query(`/api/messages/${fixtures.company.id}`, parameters), { user: fixtures.seeker, status: 400 });
    }
    await assertReadRows(all, new Set());
  });

  it('interview invitations require a future string time and reject foreign or completed applications', async () => {
    const path = `/api/applications/${fixtures.application}/interview`;
    for (const scheduledAt of [undefined, null, '', 'not-a-time', future(-24), Date.now() + 86400000]) {
      await api(path, { user: fixtures.company, method: 'POST', body: { scheduledAt }, status: 400 });
    }
    await api(path, { user: fixtures.otherCompany, method: 'POST', body: { scheduledAt: future() }, status: 403 });
    for (const status of ['accepted', 'rejected']) {
      await pool.query('UPDATE applications SET status = ? WHERE id = ?', [status, fixtures.application]);
      await api(path, { user: fixtures.company, method: 'POST', body: { scheduledAt: future() }, status: 409 });
      assert.equal((await applicationRow()).status, status);
    }
    const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM interviews');
    assert.equal(count.count, 0);
    assert.deepEqual(await events(), []);
    const [[notifications]] = await pool.query("SELECT COUNT(*) AS count FROM notifications WHERE type = 'interview'");
    assert.equal(notifications.count, 0);
  });

  it('interview lists include both parties but neither third party, and duplicate invitations are conflicts', async () => {
    const scheduledAt = future();
    const id = await invite(scheduledAt);
    for (const user of [fixtures.seeker, fixtures.company]) {
      const rows = await api('/api/interviews/mine', { user });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, id);
      assert.equal(rows[0].scheduled_at, scheduledAt);
      assert.equal(rows[0].candidate, fixtures.seeker.name);
      assert.equal(rows[0].company, fixtures.company.company_name);
    }
    for (const user of [fixtures.otherSeeker, fixtures.otherCompany]) assert.deepEqual(await api('/api/interviews/mine', { user }), []);
    await api('/api/interviews/mine', { status: 401 });
    await api(`/api/applications/${fixtures.application}/interview`, {
      user: fixtures.company, method: 'POST', body: { scheduledAt: future(48) }, status: 409
    });
    assertTimeEvent(await events(), 'interview', scheduledAt, null, fixtures.company);
    assert.equal((await pool.query('SELECT id FROM interviews'))[0].length, 1);
  });

  it('rescheduling keeps scheduled_at, validates proposed_at, and cannot be self-confirmed or reviewed by another company', async () => {
    const original = future(), proposed = future(48);
    const id = await invite(original);
    const path = `/api/interviews/${id}/respond`;
    for (const newTime of [undefined, 'invalid', future(-1)]) {
      await api(path, { user: fixtures.seeker, method: 'POST', body: { action: 'reschedule', newTime }, status: 400 });
    }
    assert.equal((await interviewRow(id)).status, 'pending');
    await api(path, { user: fixtures.otherSeeker, method: 'POST', body: { action: 'confirm' }, status: 403 });
    await propose(id, proposed);
    const row = await interviewRow(id);
    assert.equal(row.status, 'rescheduled');
    assert.equal(row.scheduled_at.toISOString(), original);
    assert.equal(row.proposed_at.toISOString(), proposed);
    assert.equal(row.seeker_note, '希望晚一天');
    for (const action of ['confirm', 'reschedule']) {
      await api(path, { user: fixtures.seeker, method: 'POST', body: { action, newTime: future(72) }, status: 409 });
    }
    for (const user of [fixtures.otherCompany, fixtures.seeker]) {
      await api(`/api/interviews/${id}/review`, { user, method: 'POST', body: { action: 'accept' }, status: 403 });
    }
    assert.deepEqual(await interviewRow(id), row, 'Rejected actions must not mutate a pending proposal');
    assertTimeEvent(await events(), 'interview_reschedule', original, proposed, fixtures.seeker);
  });

  for (const action of ['accept', 'reject']) {
    it(`company ${action} of rescheduling records both times, clears proposed_at, and is consumed once`, async () => {
      const original = future(), proposed = future(48);
      const id = await invite(original);
      await propose(id, proposed);
      const path = `/api/interviews/${id}/review`;
      await api(path, { user: fixtures.company, method: 'POST', body: { action, note: '企业审核备注' } });
      const row = await interviewRow(id);
      assert.equal(row.status, action === 'accept' ? 'confirmed' : 'pending');
      assert.equal(row.scheduled_at.toISOString(), action === 'accept' ? proposed : original);
      assert.equal(row.proposed_at, null);
      assert.equal(row.company_note, '企业审核备注');
      for (const repeated of ['accept', 'reject']) {
        await api(path, { user: fixtures.company, method: 'POST', body: { action: repeated }, status: 409 });
      }
      const history = await events();
      assertTimeEvent(history, 'interview_reschedule', original, proposed, fixtures.seeker);
      const event = assertTimeEvent(history, 'interview_review', original, proposed, fixtures.company);
      assert.ok(event.detail.includes(action === 'accept' ? '接受' : '拒绝'));
      const [notifications] = await pool.query("SELECT message FROM notifications WHERE user_id = ? AND type = 'interview'", [fixtures.seeker.id]);
      assert.ok(notifications.some((notification) => notification.message.includes(original) && notification.message.includes(proposed)));
      if (action === 'reject') {
        await api(`/api/interviews/${id}/respond`, { user: fixtures.seeker, method: 'POST', body: { action: 'confirm' } });
        assert.equal((await interviewRow(id)).scheduled_at.toISOString(), original);
        assert.equal((await interviewRow(id)).status, 'confirmed');
      } else {
        await api(`/api/interviews/${id}/respond`, { user: fixtures.seeker, method: 'POST', body: { action: 'confirm' }, status: 409 });
      }
    });
  }

  it('interview confirm/decline enforce transitions and produce one event per successful action', async () => {
    const scheduledAt = future();
    const id = await invite(scheduledAt);
    const path = `/api/interviews/${id}/respond`;
    await api(path, { user: fixtures.seeker, method: 'POST', body: { action: 'confirm' } });
    assert.equal((await interviewRow(id)).status, 'confirmed');
    await api(path, { user: fixtures.seeker, method: 'POST', body: { action: 'confirm' }, status: 409 });
    await api(`/api/interviews/${id}/review`, { user: fixtures.company, method: 'POST', body: { action: 'accept' }, status: 409 });
    await api(path, { user: fixtures.seeker, method: 'POST', body: { action: 'decline', note: '不再参加' } });
    assert.equal((await interviewRow(id)).status, 'declined');
    for (const action of ['confirm', 'decline', 'reschedule']) {
      await api(path, { user: fixtures.seeker, method: 'POST', body: { action, newTime: future(48) }, status: 409 });
    }
    const history = await events();
    assertTimeEvent(history, 'interview_confirm', scheduledAt, null, fixtures.seeker);
    assertTimeEvent(history, 'interview_decline', scheduledAt, null, fixtures.seeker);
    assert.equal(history.length, 3);
  });

  async function rejectCompany() {
    const reason = '许可证编号无法核实，请补交清晰扫描件';
    await api(`/api/admin/companies/${fixtures.company.id}/reject`, {
      user: fixtures.admin, method: 'POST', body: { reason }
    });
    const [[row]] = await pool.query('SELECT status, verified, reject_reason FROM users WHERE id = ?', [fixtures.company.id]);
    assert.deepEqual({ ...row }, { status: 'banned', verified: 0, reject_reason: reason });
    return reason;
  }

  it('rejected-company login reveals the reason only after a correct password and never issues a session', async () => {
    const reason = await rejectCompany();
    const wrong = await request('/api/login', { method: 'POST', body: { username: fixtures.company.username, password: 'wrong-password' } });
    expectJSON(wrong, 400);
    assert.equal(wrong.json.data, '用户名或密码错误');
    assert.ok(!wrong.text.includes(reason));
    const correct = await request('/api/login', { method: 'POST', body: { username: fixtures.company.username, password } });
    expectJSON(correct, 403);
    assert.ok(correct.json.data.includes(reason));
    for (const response of [wrong, correct]) {
      assertNoKeys(response.json, ['token', 'password', 'user']);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    const [[sessions]] = await pool.query('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?', [fixtures.company.id]);
    assert.equal(sessions.count, 0);
    await api('/api/me', { user: fixtures.company, status: 401 });
  });

  it('reapproving a rejected company clears the reason and restores real password/Cookie login', async () => {
    await rejectCompany();
    await api(`/api/admin/companies/${fixtures.company.id}/approve`, { user: fixtures.admin, method: 'POST', body: {} });
    const [[row]] = await pool.query('SELECT status, verified, reject_reason FROM users WHERE id = ?', [fixtures.company.id]);
    assert.deepEqual({ ...row }, { status: 'active', verified: 1, reject_reason: null });
    const response = await request('/api/login', { method: 'POST', body: { username: fixtures.company.username, password } });
    const data = expectJSON(response);
    assert.equal(data.user.id, fixtures.company.id);
    assert.equal(data.user.reject_reason, null);
    assertNoKeys(data.user, ['password', 'password_hash', 'token', 'license_path']);
    assert.equal(typeof data.token, 'string');
    assert.ok(data.token.length >= 32);
    assert.notEqual(data.token, fixtures.company.token);
    assert.match(response.headers.get('set-cookie'), /sid=/);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/i);
    assert.equal((await api('/api/me', { user: { token: data.token }, cookie: true })).id, fixtures.company.id);
    await api('/api/me', { user: fixtures.company, status: 401 });
  });

  const formulaStrings = [
    '=1+1', '+SUM(1,2)', '-10+20', '@SUM(A1:A2)',
    '   =1+1', '\t=SUM(1,2)', '\r@cmd', '\n+1', ' \t-10', '\u00A0=2+2',
    '\tplain text', '=HYPERLINK("https://example.invalid","x")'
  ];
  const normalStrings = ['normal text', '带中文,逗号和"引号"', 'line one\nline two', '  normal whitespace', "'already text"];
  for (const type of ['users', 'jobs', 'applications']) {
    it(`CSV ${type} prefixes formula strings (including whitespace) with a single quote and preserves non-formulas/numbers`, async () => {
      const expected = [];
      for (const value of [...formulaStrings, ...normalStrings]) {
        let id;
        if (type === 'users') {
          id = (await createUser('seeker', { name: value })).id;
        } else {
          const job = await createJob(fixtures.company, { title: value, salary_min: -123 });
          id = type === 'jobs' ? job : await insert('applications', {
            resume_id: fixtures.resume, job_id: job, seeker_id: fixtures.seeker.id,
            company_id: fixtures.company.id, match_score: -7
          });
        }
        expected.push({ id, value });
      }
      const response = await request(query('/api/admin/export', { type }), { user: fixtures.admin });
      assert.equal(response.status, 200, response.text);
      assert.match(response.headers.get('content-type'), /^text\/csv; charset=utf-8$/i);
      assert.equal(response.headers.get('content-disposition'), `attachment; filename="addwork-${type}.csv"`);
      assert.deepEqual([...response.buffer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const rows = parseCSV(response.text);
      const field = { users: 'name', jobs: 'title', applications: 'job' }[type];
      for (const { id, value } of expected) {
        const row = rows.find((record) => record.id === String(id));
        assert.ok(row, `Missing CSV fixture ${id}`);
        assert.equal(row[field], formulaStrings.includes(value) ? "'" + value : value);
        if (type === 'jobs') assert.equal(row.salary_min, '-123', 'Numeric values must not receive the string formula prefix');
        if (type === 'applications') assert.equal(row.match_score, '-7');
      }
    });
  }

  it('CSV exports require an admin session', async () => {
    await api('/api/admin/export?type=users', { status: 401 });
    for (const user of [fixtures.seeker, fixtures.company]) await api('/api/admin/export?type=users', { user, status: 403 });
  });
});
