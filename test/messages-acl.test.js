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

test('le garde-fou bloque au-dela de la limite, par auteur', async () => {
  H.reset();
  for (let i = 0; i < M.RATE_MAX; i++) {
    assert.equal(await M.rateLimited('bavard'), false, `message ${i + 1} doit passer`);
  }
  assert.equal(await M.rateLimited('bavard'), true, 'le 21e doit etre bloque');
  assert.equal(await M.rateLimited('quelqu-un-dautre'), false, 'la limite est par auteur');
});

test('la fenetre se relache une fois ecoulee', async () => {
  H.reset();
  for (let i = 0; i < M.RATE_MAX; i++) await M.rateLimited('bavard');
  assert.equal(await M.rateLimited('bavard'), true);
  // On force l echeance plutot que d attendre cinq minutes.
  await A.kv(['EXPIRE', 'rate:msg:bavard', '-1']);
  assert.equal(await M.rateLimited('bavard'), false,
    'la fenetre ecoulee doit rendre le droit d ecrire');
});

test('la toute premiere ecriture pose deja une expiration', async () => {
  H.reset();
  await M.rateLimited('bavard');
  // Garde-fou anti-blocage a vie : si la cle pouvait exister sans echeance,
  // le compteur ne repasserait jamais par 1 et l auteur serait bloque pour
  // toujours. L expiration doit donc naitre AVEC la cle.
  assert.ok(H.store.expiries.has('rate:msg:bavard'),
    'la cle de comptage ne doit jamais exister sans expiration');
});
