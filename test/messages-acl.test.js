const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');

const H = installHarness();
const A = require('../api/_auth');
const S = require('../api/_schedule');
const M = require('../api/_messages');

async function ecole() {
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putTeacher({ username: 'awa', firstName: 'Awa', lastName: 'Diop', email: 'awa@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'p@kvs.test' });
  await A.putUser({ username: 'bilal', firstName: 'Bilal', lastName: 'Keita', email: 'p@kvs.test' });
  await S.createSession({
    courseId: 'python-boucles', courseLabel: 'Python', durationMin: 90,
    startsAt: new Date(Date.now() + 864e5).toISOString(),
    students: ['mohamedjr'], teacherUsername: 'blaise', teacherName: 'Blaise Mentor'
  });
}

test('une seance commune ouvre le droit, son absence le refuse', async () => {
  H.reset(); await ecole();
  assert.equal(await M.sharesSession('blaise', 'mohamedjr'), true);
  assert.equal(await M.sharesSession('blaise', 'bilal'), false);
  assert.equal(await M.sharesSession('awa', 'mohamedjr'), false);
});

test('un fil deja ouvert le reste meme sans seance', async () => {
  H.reset(); await ecole();
  assert.equal(await M.canOpen('awa', 'bilal'), false);
  await M.ensureThread({ teacherUsername: 'awa', studentUsername: 'bilal' });
  assert.equal(await M.canOpen('awa', 'bilal'), true,
    'le canal ne doit pas se fermer pendant les vacances');
});

test('contactsFor liste les interlocuteurs autorises avec leur nom', async () => {
  H.reset(); await ecole();
  const cotePro = await M.contactsFor('teacher', 'blaise');
  assert.deepEqual(cotePro, [{ username: 'mohamedjr', name: 'Mohamed Junior' }]);
  const coteEleve = await M.contactsFor('student', 'mohamedjr');
  assert.deepEqual(coteEleve, [{ username: 'blaise', name: 'Blaise Mentor' }]);
  assert.deepEqual(await M.contactsFor('student', 'bilal'), []);
});

test('le garde-fou bloque au-dela de la limite puis se relache', async () => {
  H.reset();
  for (let i = 0; i < M.RATE_MAX; i++) {
    assert.equal(await M.rateLimited('bavard'), false, `message ${i + 1} doit passer`);
  }
  assert.equal(await M.rateLimited('bavard'), true, 'le 21e doit etre bloque');
  assert.equal(await M.rateLimited('quelqu-un-dautre'), false, 'la limite est par auteur');
});
