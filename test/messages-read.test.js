const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');

const H = installHarness();
const A = require('../api/_auth');
const M = require('../api/_messages');

async function filPret() {
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'parent@kvs.test' });
  return M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
}
const ecrire = (th, body) => M.appendMessage(th, {
  fromRole: 'teacher', fromUsername: 'blaise', fromName: 'Blaise Mentor', body
});

test('markRead remet les non-lus a zero pour ce cote seulement', async () => {
  H.reset();
  let th = await filPret();
  th = (await ecrire(th, 'un')).thread;
  th = (await ecrire(th, 'deux')).thread;
  assert.equal(th.unread.student, 2);
  th = await M.markRead(th, 'student');
  assert.equal(th.unread.student, 0);
  assert.equal(th.unread.teacher, 0);
  assert.ok(th.lastReadAt.student);
  assert.equal(th.lastReadAt.teacher, null);
});

test('la premiere alerte part, la seconde est retenue', async () => {
  H.reset();
  let th = await filPret();
  th = (await ecrire(th, 'un')).thread;
  assert.equal(M.shouldAlert(th, 'student'), true);
  th = await M.noteAlerted(th, 'student');
  th = (await ecrire(th, 'deux')).thread;
  assert.equal(M.shouldAlert(th, 'student'), false,
    'un deuxieme message ne doit pas declencher un deuxieme e-mail');
});

test('la lecture rearme l alerte', async () => {
  H.reset();
  let th = await filPret();
  th = (await ecrire(th, 'un')).thread;
  th = await M.noteAlerted(th, 'student');
  await new Promise(r => setTimeout(r, 5));
  th = await M.markRead(th, 'student');
  th = (await ecrire(th, 'deux')).thread;
  assert.equal(M.shouldAlert(th, 'student'), true,
    'apres lecture, le message suivant doit re-alerter');
});

test('shouldAlert n ecrit rien', async () => {
  H.reset();
  let th = await filPret();
  th = (await ecrire(th, 'un')).thread;
  const avant = JSON.stringify(await M.getThread(th.id));
  M.shouldAlert(th, 'student');
  assert.equal(JSON.stringify(await M.getThread(th.id)), avant);
});
