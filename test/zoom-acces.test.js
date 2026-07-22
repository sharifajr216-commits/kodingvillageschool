// api/zoom.js (action=meeting) — la faille corrigée : cette route renvoyait
// un join_url Zoom RÉEL sans aucune authentification. Les courseId sont
// devinables (scratch, python-boucles, dev-jeux-python…), donc n'importe qui
// sur Internet pouvait obtenir le lien de connexion d'une classe d'enfants.
// La « défense » horaire d'origine (basée sur m.start_time, l'heure Zoom)
// était en plus totalement inopérante : les réunions de l'école sont des
// récurrences SANS heure fixe → m.start_time est toujours null côté Zoom,
// donc ce garde-fou ne se déclenchait jamais (vérifié : join_url renvoyé à
// 2h du matin en production).
//
// Ces tests couvrent la nouvelle chaîne d'autorisation : jeton signé
// (élève/enseignant, jamais admin) + une séance de CE cours dans NOTRE
// planning (api/_schedule.js) dont la fenêtre [startsAt − 10 min,
// startsAt + durationMin] contient MAINTENANT — jamais l'horaire Zoom.
//
// Zoom n'est volontairement PAS configuré dans ce fichier (ni
// ZOOM_CLIENT_ID/SECRET/ACCOUNT_ID) : une autorisation réussie tombe donc
// sur 501 (getAccessToken → NOT_CONFIGURED), ce qui suffit à prouver que
// l'autorisation a été ACCORDÉE (ni 401 ni 403) sans dépendre d'un vrai
// compte Zoom. Seul ZOOM_COURSE_MEETINGS est renseigné, pour dépasser le
// garde-fou 404 (« cours non mappé ») et atteindre le code d'autorisation.

const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');
const { appelerGet } = require('./helpers/http');

const H = installHarness();
process.env.ZOOM_COURSE_MEETINGS = JSON.stringify({ 'python-boucles': '111222333' });

const A = require('../api/_auth');
const S = require('../api/_schedule');
const appel = appelerGet(require('../api/zoom'));

const jeton = (sub, role) => A.signToken({ sub, role, email: '' }, 3600);

async function ecole() {
  await A.putTeacher({ username: 'awa', firstName: 'Awa', lastName: 'Diop', email: 'awa@kvs.test' });
  await A.putUser({ username: 'bilal', firstName: 'Bilal', lastName: 'Keita', email: 'p1@kvs.test' });
  await A.putUser({ username: 'sara', firstName: 'Sara', lastName: 'Diallo', email: 'p2@kvs.test' });
}

// Séance de python-boucles qui démarre dans `offsetMs` (peut être négatif,
// pour simuler une séance déjà commencée), animée par awa, avec `students`.
async function seance({ offsetMs, durationMin = 60, students = ['bilal'] }) {
  return S.createSession({
    courseId: 'python-boucles', courseLabel: 'Python · Les boucles', durationMin,
    startsAt: new Date(Date.now() + offsetMs).toISOString(),
    students, teacherUsername: 'awa', teacherName: 'Awa Diop'
  });
}

const appelMeeting = (courseId, token) => appel({ action: 'meeting', courseId }, token);

test('sans jeton -> 401', async () => {
  H.reset(); await ecole();
  await seance({ offsetMs: 5 * 60000 }); // dans la fenêtre, mais aucun jeton fourni
  const r = await appelMeeting('python-boucles', undefined);
  assert.equal(r.statusCode, 401);
  assert.ok(r.body && r.body.error);
});

test('jeton valide mais aucune seance de ce cours -> 403', async () => {
  H.reset(); await ecole();
  // bilal n'a AUCUNE seance planifiee du tout.
  const r = await appelMeeting('python-boucles', jeton('bilal', 'student'));
  assert.equal(r.statusCode, 403);
  assert.ok(r.body && r.body.error);
});

test('eleve avec une seance HORS fenetre (dans 3h) -> 403', async () => {
  H.reset(); await ecole();
  await seance({ offsetMs: 3 * 3600000, students: ['bilal'] });
  const r = await appelMeeting('python-boucles', jeton('bilal', 'student'));
  assert.equal(r.statusCode, 403);
  assert.ok(r.body && r.body.error);
  assert.ok(r.body.opensAt, 'la prochaine ouverture doit etre indiquee quand la seance est connue');
});

test('eleve avec une seance DANS la fenetre -> autorisation accordee (501, Zoom non configure)', async () => {
  H.reset(); await ecole();
  await seance({ offsetMs: 5 * 60000, students: ['bilal'] }); // commence dans 5 min < fenetre de 10 min
  const r = await appelMeeting('python-boucles', jeton('bilal', 'student'));
  assert.notEqual(r.statusCode, 401);
  assert.notEqual(r.statusCode, 403);
  assert.equal(r.statusCode, 501, 'Zoom non configure dans ce test -> 501, preuve que l\'autorisation est passee');
});

test('enseignant de la seance, dans la fenetre -> autorisation accordee (501, Zoom non configure)', async () => {
  H.reset(); await ecole();
  await seance({ offsetMs: -10 * 60000, durationMin: 60, students: ['bilal'] }); // commencee il y a 10 min, dure 60 min
  const r = await appelMeeting('python-boucles', jeton('awa', 'teacher'));
  assert.notEqual(r.statusCode, 401);
  assert.notEqual(r.statusCode, 403);
  assert.equal(r.statusCode, 501);
});

test('un autre eleve, non inscrit a cette seance -> 403', async () => {
  H.reset(); await ecole();
  await seance({ offsetMs: 5 * 60000, students: ['bilal'] }); // sara n'y est pas inscrite
  const r = await appelMeeting('python-boucles', jeton('sara', 'student'));
  assert.equal(r.statusCode, 403);
});

test('eleve ayant declare une absence sur cette seance -> 403', async () => {
  H.reset(); await ecole();
  const s = await seance({ offsetMs: 5 * 60000, students: ['bilal'] });
  await S.declareAbsence(s, { username: 'bilal', reason: 'malade', studentName: 'Bilal' });
  const r = await appelMeeting('python-boucles', jeton('bilal', 'student'));
  assert.equal(r.statusCode, 403);
  assert.ok(r.body && r.body.error);
});
