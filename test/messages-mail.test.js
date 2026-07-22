const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');

const H = installHarness();
const A = require('../api/_auth');
const M = require('../api/_messages');
const N = require('../api/_notify');

async function fil() {
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'parent@kvs.test' });
  return M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'mohamedjr' });
}

test('l alerte famille nomme l enfant concerne', async () => {
  H.reset();
  let th = await fil();
  const r = await M.appendMessage(th, {
    fromRole: 'teacher', fromUsername: 'blaise', fromName: 'Blaise Mentor', body: 'Bonjour !'
  });
  const res = await N.notifyNewMessage(r.thread, r.message, 'student');
  assert.equal(res.sent, true);
  assert.equal(H.mails.length, 1);
  const mail = H.mails[0];
  assert.deepEqual(mail.to, ['parent@kvs.test']);
  assert.match(mail.subject, /Mohamed Junior/,
    'un parent de deux eleves doit savoir lequel est concerne');
  assert.match(mail.subject, /Blaise Mentor/);
});

test('l alerte enseignant part sur son adresse', async () => {
  H.reset();
  let th = await fil();
  const r = await M.appendMessage(th, {
    fromRole: 'student', fromUsername: 'mohamedjr', fromName: 'Mohamed Junior', body: 'Une question'
  });
  await N.notifyNewMessage(r.thread, r.message, 'teacher');
  assert.deepEqual(H.mails[0].to, ['blaise@kvs.test']);
});

test('l e-mail ne recopie pas le message en entier', async () => {
  H.reset();
  let th = await fil();
  const secret = 'information-confidentielle-de-la-famille';
  const r = await M.appendMessage(th, {
    fromRole: 'student', fromUsername: 'mohamedjr', fromName: 'Mohamed Junior', body: secret
  });
  await N.notifyNewMessage(r.thread, r.message, 'teacher');
  assert.equal(H.mails[0].html.includes(secret), false,
    'le contenu reste dans le produit ; l e-mail ne fait qu inviter a s y connecter');
});

test('un destinataire sans e-mail valide ne fait pas echouer', async () => {
  H.reset();
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'sansmail', firstName: 'Sans', lastName: 'Mail', email: '' });
  const th = await M.ensureThread({ teacherUsername: 'blaise', studentUsername: 'sansmail' });
  const r = await M.appendMessage(th, {
    fromRole: 'teacher', fromUsername: 'blaise', fromName: 'Blaise Mentor', body: 'Coucou'
  });
  const res = await N.notifyNewMessage(r.thread, r.message, 'student');
  assert.equal(res.sent, false);
  assert.equal(H.mails.length, 0);
});
