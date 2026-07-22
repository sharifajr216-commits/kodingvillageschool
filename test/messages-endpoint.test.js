const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');
const { appeler } = require('./helpers/http');

const H = installHarness();
const A = require('../api/_auth');
const S = require('../api/_schedule');
const M = require('../api/_messages');
const appel = appeler(require('../api/messages'));

const jeton = (sub, role) => A.signToken({ sub, role, email: '' }, 3600);

async function ecole() {
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'p@kvs.test' });
  await A.putUser({ username: 'bilal', firstName: 'Bilal', lastName: 'Keita', email: 'p@kvs.test' });
  await S.createSession({
    courseId: 'python-boucles', courseLabel: 'Python', durationMin: 90,
    startsAt: new Date(Date.now() + 864e5).toISOString(),
    students: ['mohamedjr'], teacherUsername: 'blaise', teacherName: 'Blaise Mentor'
  });
}

test('sans jeton, tout est refuse', async () => {
  H.reset(); await ecole();
  const r = await appel({ action: 'threads.list' });
  assert.equal(r.statusCode, 401);
});

test('la famille peut ecrire la premiere', async () => {
  H.reset(); await ecole();
  const r = await appel({ action: 'message.send', to: 'blaise', body: 'Bonjour, une question' },
    jeton('mohamedjr', 'student'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.notified, true);
  assert.equal(H.mails.length, 1);
});

test('ecrire a un enseignant sans seance commune est refuse', async () => {
  H.reset(); await ecole();
  const r = await appel({ action: 'message.send', to: 'blaise', body: 'Coucou' },
    jeton('bilal', 'student'));
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, 'not_allowed');
});

test('un eleve ne peut pas ouvrir le fil d un autre : 404, pas 403', async () => {
  H.reset(); await ecole();
  // Les identifiants de fil sont deterministes et donc devinables
  // (th_<prof>|<eleve>) : un 403 distinct d un fil inexistant transformerait
  // thread.open en oracle d appartenance. Les deux cas doivent donc etre
  // rigoureusement indistinguables cote reponse.
  await appel({ action: 'message.send', to: 'blaise', body: 'a' }, jeton('mohamedjr', 'student'));
  const tid = M.threadId('blaise', 'mohamedjr');
  const r = await appel({ action: 'thread.open', threadId: tid }, jeton('bilal', 'student'));
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.error, 'not_found');
});

test('fil inexistant et fil dont on n est pas participant rendent la meme reponse', async () => {
  H.reset(); await ecole();
  await appel({ action: 'message.send', to: 'blaise', body: 'a' }, jeton('mohamedjr', 'student'));
  const reelMaisEtranger = await appel(
    { action: 'thread.open', threadId: M.threadId('blaise', 'mohamedjr') },
    jeton('bilal', 'student'));
  const inexistant = await appel(
    { action: 'thread.open', threadId: 'th_blaise|personne' },
    jeton('bilal', 'student'));
  assert.equal(reelMaisEtranger.statusCode, inexistant.statusCode);
  assert.deepEqual(reelMaisEtranger.body, inexistant.body);
});

test('le garde-fou de LECTURE renvoie 429, separe de celui d ecriture', async () => {
  H.reset(); await ecole();
  const famille = jeton('mohamedjr', 'student');
  for (let i = 0; i < M.READ_RATE_MAX; i++) {
    const r = await appel({ action: 'threads.list' }, famille);
    assert.equal(r.statusCode, 200, `lecture ${i + 1} doit passer`);
  }
  const bloque = await appel({ action: 'threads.list' }, famille);
  assert.equal(bloque.statusCode, 429);
  // Le quota d ECRITURE est intact : les deux garde-fous ne partagent pas leur budget.
  const ecrit = await appel({ action: 'message.send', to: 'blaise', body: 'toujours possible' }, famille);
  assert.equal(ecrit.statusCode, 200);
});

test('thread.open marque lu pour l appelant', async () => {
  H.reset(); await ecole();
  await appel({ action: 'message.send', to: 'mohamedjr', body: 'Bonjour' }, jeton('blaise', 'teacher'));
  const tid = M.threadId('blaise', 'mohamedjr');
  assert.equal((await M.getThread(tid)).unread.student, 1);
  const r = await appel({ action: 'thread.open', threadId: tid }, jeton('mohamedjr', 'student'));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.messages.length, 1);
  assert.equal((await M.getThread(tid)).unread.student, 0);
});

test('l admin lit tout mais ne marque rien et ne peut pas ecrire', async () => {
  H.reset(); await ecole();
  await appel({ action: 'message.send', to: 'mohamedjr', body: 'Bonjour' }, jeton('blaise', 'teacher'));
  const tid = M.threadId('blaise', 'mohamedjr');
  const adm = jeton('admin@kvs.test', 'admin');

  const liste = await appel({ action: 'threads.list' }, adm);
  assert.equal(liste.body.threads.length, 1);

  const ouvre = await appel({ action: 'thread.open', threadId: tid }, adm);
  assert.equal(ouvre.statusCode, 200);
  assert.equal((await M.getThread(tid)).unread.student, 1,
    'la lecture admin ne doit pas faire croire que la famille a ouvert');

  const ecrit = await appel({ action: 'message.send', threadId: tid, body: 'non' }, adm);
  assert.equal(ecrit.statusCode, 403);
  assert.equal(ecrit.body.error, 'read_only');
});

test('la deuxieme alerte est retenue puis rearmee apres lecture', async () => {
  H.reset(); await ecole();
  const pro = jeton('blaise', 'teacher');
  await appel({ action: 'message.send', to: 'mohamedjr', body: 'un' }, pro);
  await appel({ action: 'message.send', to: 'mohamedjr', body: 'deux' }, pro);
  assert.equal(H.mails.length, 1, 'deux messages, un seul e-mail');

  await appel({ action: 'thread.open', threadId: M.threadId('blaise', 'mohamedjr') },
    jeton('mohamedjr', 'student'));
  await appel({ action: 'message.send', to: 'mohamedjr', body: 'trois' }, pro);
  assert.equal(H.mails.length, 2, 'apres lecture, l alerte se rearme');
});

test('un tiers ne peut pas ECRIRE dans un fil dont il n est pas participant', async () => {
  H.reset(); await ecole();
  await appel({ action: 'message.send', to: 'blaise', body: 'a' }, jeton('mohamedjr', 'student'));
  const tid = M.threadId('blaise', 'mohamedjr');
  // Les identifiants de fil sont deterministes donc devinables : le chemin
  // d ecriture doit etre garde aussi solidement que le chemin de lecture.
  const r = await appel({ action: 'message.send', threadId: tid, body: 'intrusion' }, jeton('bilal', 'student'));
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, 'not_a_participant');
  assert.equal((await M.getMessages(tid, { limit: 50 })).length, 1, 'aucun message ne doit avoir ete ajoute');
});

test('un 429 sur un premier message ne cree aucun fil', async () => {
  H.reset(); await ecole();
  const t = jeton('blaise', 'teacher');
  // On epuise le quota sur un fil existant...
  await appel({ action: 'message.send', to: 'mohamedjr', body: 'depart' }, t);
  for (let i = 0; i < M.RATE_MAX; i++) {
    await appel({ action: 'message.send', to: 'mohamedjr', body: 'm' + i }, t);
  }
  // ...puis on tente un PREMIER message vers un autre eleve : refuse, et surtout
  // aucun fil ne doit avoir ete cree au passage.
  const r = await appel({ action: 'message.send', to: 'bilal', body: 'nouveau' }, t);
  assert.equal(r.statusCode, 429);
  assert.equal(await M.getThread(M.threadId('blaise', 'bilal')), null,
    'le garde-fou doit s appliquer AVANT toute ecriture');
});

test('corps vide ou trop long refuse', async () => {
  H.reset(); await ecole();
  const t = jeton('blaise', 'teacher');
  assert.equal((await appel({ action: 'message.send', to: 'mohamedjr', body: '  ' }, t)).statusCode, 400);
  assert.equal((await appel({ action: 'message.send', to: 'mohamedjr', body: 'x'.repeat(2001) }, t)).statusCode, 400);
});

test('le garde-fou renvoie 429', async () => {
  H.reset(); await ecole();
  const t = jeton('blaise', 'teacher');
  for (let i = 0; i < M.RATE_MAX; i++) {
    await appel({ action: 'message.send', to: 'mohamedjr', body: 'm' + i }, t);
  }
  const r = await appel({ action: 'message.send', to: 'mohamedjr', body: 'de trop' }, t);
  assert.equal(r.statusCode, 429);
});

test('contacts.list ne propose que les interlocuteurs autorises', async () => {
  H.reset(); await ecole();
  const r = await appel({ action: 'contacts.list' }, jeton('mohamedjr', 'student'));
  assert.deepEqual(r.body.contacts, [{ username: 'blaise', name: 'Blaise Mentor' }]);
  const vide = await appel({ action: 'contacts.list' }, jeton('bilal', 'student'));
  assert.deepEqual(vide.body.contacts, []);
});
