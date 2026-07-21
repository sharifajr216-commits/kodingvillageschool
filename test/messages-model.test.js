const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');

const H = installHarness();
const A = require('../api/_auth');
const M = require('../api/_messages');

async function comptes() {
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'parent@kvs.test' });
  await A.putUser({ username: 'bilal', firstName: 'Bilal', lastName: 'Keita', email: 'parent@kvs.test' });
}

test('l identifiant de fil est deterministe et non ambigu', () => {
  assert.equal(M.threadId('blaise', 'mohamedjr'), 'th_blaise|mohamedjr');
  assert.equal(M.threadId('BLAISE', 'MohamedJR'), 'th_blaise|mohamedjr');
  assert.deepEqual(M.parseThreadId('th_blaise|mohamedjr'),
    { teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  assert.equal(M.parseThreadId('nimportequoi'), null);
});

test('ensureThread cree une fois et renvoie le meme fil ensuite', async () => {
  H.reset(); await comptes();
  const t1 = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  const t2 = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  assert.equal(t1.id, t2.id);
  assert.equal(t1.createdAt, t2.createdAt);
  assert.equal(t1.teacherName, 'Blaise Mentor');
  assert.equal(t1.studentName, 'Mohamed Junior');
  assert.deepEqual(t1.unread, { teacher: 0, student: 0 });
});

test('appendMessage incremente les non-lus du destinataire seulement', async () => {
  H.reset(); await comptes();
  let th = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  const r = await M.appendMessage(th, {
    fromRole: 'teacher', fromUsername: 'blaise', fromName: 'Blaise Mentor', body: 'Bonjour !'
  });
  assert.equal(r.message.body, 'Bonjour !');
  assert.equal(r.thread.unread.student, 1);
  assert.equal(r.thread.unread.teacher, 0);
  assert.equal(r.thread.lastFrom, 'teacher');
  assert.equal(r.thread.lastSnippet, 'Bonjour !');
});

test('le corps est refuse au-dela de la limite', async () => {
  H.reset(); await comptes();
  const th = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  await assert.rejects(() => M.appendMessage(th, {
    fromRole: 'teacher', fromUsername: 'blaise', fromName: 'B', body: 'x'.repeat(M.MAX_BODY + 1)
  }), /trop long/);
  await assert.rejects(() => M.appendMessage(th, {
    fromRole: 'teacher', fromUsername: 'blaise', fromName: 'B', body: '   '
  }), /vide/);
});

test('getMessages rend l ordre chronologique et pagine', async () => {
  H.reset(); await comptes();
  let th = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  for (const mot of ['un', 'deux', 'trois']) {
    th = (await M.appendMessage(th, { fromRole: 'teacher', fromUsername: 'blaise', fromName: 'B', body: mot })).thread;
  }
  const tous = await M.getMessages(th.id, { limit: 50 });
  assert.deepEqual(tous.map(m => m.body), ['un', 'deux', 'trois']);
  const derniers = await M.getMessages(th.id, { limit: 2 });
  assert.deepEqual(derniers.map(m => m.body), ['deux', 'trois']);
  // Traversee de frontiere : la page suivante reprend juste avant le curseur,
  // sans sauter ni repeter de message.
  const precedents = await M.getMessages(th.id, { limit: 2, before: derniers[0].id });
  assert.deepEqual(precedents.map(m => m.body), ['un']);
});

test('le curseur ne saute aucun message a horodatage identique', async () => {
  H.reset(); await comptes();
  let th = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  // Trois messages ecrits d affilee : leurs scores peuvent coincider a la ms.
  for (const mot of ['a', 'b', 'c']) {
    th = (await M.appendMessage(th, { fromRole: 'teacher', fromUsername: 'blaise', fromName: 'B', body: mot })).thread;
  }
  const tous = await M.getMessages(th.id, { limit: 50 });
  const page2 = await M.getMessages(th.id, { limit: 50, before: tous[2].id });
  assert.deepEqual(page2.map(m => m.body), ['a', 'b'],
    'paginer depuis le dernier message doit rendre TOUS les precedents');
});

test('listThreads cloisonne par role et par identifiant', async () => {
  H.reset(); await comptes();
  const a = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
  const b = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'bilal' });
  await M.appendMessage(a, { fromRole: 'teacher', fromUsername: 'blaise', fromName: 'B', body: 'a' });
  await M.appendMessage(b, { fromRole: 'teacher', fromUsername: 'blaise', fromName: 'B', body: 'b' });

  const cotePro = await M.listThreads('teacher', 'blaise', 50);
  assert.equal(cotePro.length, 2);
  const coteMj = await M.listThreads('student', 'mohamedjr', 50);
  assert.deepEqual(coteMj.map(t => t.id), [a.id]);
  const coteAdmin = await M.listThreads('admin', '', 50);
  assert.equal(coteAdmin.length, 2);
  // Le plus recemment actif en tete
  assert.equal(coteAdmin[0].id, b.id);
});
