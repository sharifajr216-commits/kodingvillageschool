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

test('parcours complet : la famille ecrit, le prof repond, l admin supervise', async () => {
  H.reset();
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'parent@kvs.test' });
  await S.createSession({
    courseId: 'python-boucles', courseLabel: 'Python', durationMin: 90,
    startsAt: new Date(Date.now() + 864e5).toISOString(),
    students: ['mohamedjr'], teacherUsername: 'blaise', teacherName: 'Blaise Mentor'
  });

  const famille = jeton('mohamedjr', 'student');
  const pro = jeton('blaise', 'teacher');
  const adm = jeton('admin@kvs.test', 'admin');

  // 1. La famille ecrit la premiere
  const envoi = await appel({ action: 'message.send', to: 'blaise', body: 'Bonjour, Mohamed sera absent mardi.' }, famille);
  assert.equal(envoi.statusCode, 200);
  assert.equal(H.mails.length, 1);
  assert.match(H.mails[0].subject, /Mohamed Junior/);

  // 2. Le prof voit le fil non lu
  const boite = await appel({ action: 'threads.list' }, pro);
  assert.equal(boite.body.threads.length, 1);
  assert.equal(boite.body.threads[0].unread, 1);
  assert.equal(boite.body.threads[0].withName, 'Mohamed Junior');

  // 3. Il ouvre : le fil passe lu
  const tid = boite.body.threads[0].id;
  const ouvert = await appel({ action: 'thread.open', threadId: tid }, pro);
  assert.equal(ouvert.body.messages.length, 1);
  assert.equal((await appel({ action: 'threads.list' }, pro)).body.threads[0].unread, 0);

  // 4. Il repond -> la famille est alertee (elle n a pas d alerte en attente)
  await appel({ action: 'message.send', threadId: tid, body: 'Bien noté, merci !' }, pro);
  assert.equal(H.mails.length, 2);
  assert.deepEqual(H.mails[1].to, ['parent@kvs.test']);

  // 5. La famille voit « Lu » sur son premier message
  const vueFamille = await appel({ action: 'thread.open', threadId: tid }, famille);
  assert.ok(vueFamille.body.thread.otherReadAt, 'le prof a lu, la famille doit le voir');

  // 6. L admin supervise sans rien perturber
  const avant = JSON.stringify(await M.getThread(tid));
  const vueAdmin = await appel({ action: 'thread.open', threadId: tid }, adm);
  assert.equal(vueAdmin.body.messages.length, 2);
  assert.equal(vueAdmin.body.thread.readOnly, true);
  assert.equal(JSON.stringify(await M.getThread(tid)), avant, 'la supervision ne modifie rien');
});
