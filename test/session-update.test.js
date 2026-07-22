// Édition d'une séance (api/_schedule.js : updateSession / updateSeriesFrom) et
// du point d'entrée admin (api/admin.js : session.update).
//
// Avant cette fonctionnalité, corriger une heure, un cours, un prof ou un
// élève exigeait de supprimer puis recréer la séance — 24 fois pour une
// récurrence hebdomadaire entière mal saisie. Ces tests couvrent les trois
// pièges identifiés à la conception :
//   1) une édition de série ne doit PAS recopier la date telle quelle sur
//      chaque occurrence (collapse sur un seul jour) ;
//   2) l'attendance des élèves qui restent doit survivre à l'édition ;
//   3) remindedAt doit se réarmer si la nouvelle heure est encore future.

const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');
const { appeler } = require('./helpers/http');

const H = installHarness();
const A = require('../api/_auth');
const S = require('../api/_schedule');
const appel = appeler(require('../api/admin'));

const jeton = (sub, role) => A.signToken({ sub, role, email: '' }, 3600);
const adminToken = () => jeton('admin@kvs.test', 'admin');

async function ecole() {
  await A.putTeacher({ username: 'awa', firstName: 'Awa', lastName: 'Diop', email: 'awa@kvs.test' });
  await A.putTeacher({ username: 'blaise', firstName: 'Blaise', lastName: 'Mentor', email: 'blaise@kvs.test' });
  await A.putUser({ username: 'bilal', firstName: 'Bilal', lastName: 'Keita', email: 'p1@kvs.test' });
  await A.putUser({ username: 'sara', firstName: 'Sara', lastName: 'Diallo', email: 'p2@kvs.test' });
  await A.putUser({ username: 'mohamedjr', firstName: 'Mohamed', lastName: 'Junior', email: 'p3@kvs.test' });
}

// Crée une récurrence hebdomadaire de `weeks` occurrences, une par semaine, au
// même jour de semaine que `fromDate` (calculé, pas deviné) — pour ne pas
// dépendre d'un jour de semaine codé en dur qui se périmerait.
async function serieHebdo({ fromDate, hour = 11, minute = 0, weeks = 4, students = ['bilal'] }) {
  const wd = new Date(fromDate + 'T00:00:00Z').getUTCDay();
  const r = await S.createWeeklySeries({
    courseId: 'python-boucles', courseLabel: 'Python · Les boucles', durationMin: 60,
    students, teacherUsername: 'awa', teacherName: 'Awa Diop',
    tz: S.DEFAULT_TZ, fromDate, weekdays: [wd], hour, minute, weeks
  });
  // Toujours trié par date pour que les tests indexent occurrences[0] = la plus ancienne.
  return r.created.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

test('editer UNE seance (scope one) laisse les autres occurrences de la serie intactes', async () => {
  H.reset(); await ecole();
  const occ = await serieHebdo({ fromDate: '2026-08-03', weeks: 3 });
  assert.equal(occ.length, 3);

  const updated = await S.updateSession(occ[1].id, { courseLabel: 'Python · Corrigé' });
  assert.equal(updated.courseLabel, 'Python · Corrigé');

  const soeur0 = await S.getSession(occ[0].id);
  const soeur2 = await S.getSession(occ[2].id);
  assert.equal(soeur0.courseLabel, 'Python · Les boucles', 'occurrence anterieure non touchee');
  assert.equal(soeur2.courseLabel, 'Python · Les boucles', 'occurrence non ciblee non touchee');
});

test('editer une SERIE change cette occurrence et toutes les suivantes, laisse les anterieures', async () => {
  H.reset(); await ecole();
  const occ = await serieHebdo({ fromDate: '2026-08-03', weeks: 4 });
  assert.equal(occ.length, 4);

  const r = await S.updateSeriesFrom(occ[1].id, { courseLabel: 'Python · Renommé', teacherUsername: 'blaise' });
  assert.equal(r.updated, 3, 'occ[1], occ[2], occ[3] — jamais occ[0]');
  assert.equal(r.session.id, occ[1].id);

  const relues = await Promise.all(occ.map(s => S.getSession(s.id)));
  assert.equal(relues[0].courseLabel, 'Python · Les boucles', 'anterieure intacte');
  assert.equal(relues[0].teacherUsername, 'awa', 'anterieure intacte');
  for (let i = 1; i < 4; i++) {
    assert.equal(relues[i].courseLabel, 'Python · Renommé', `occurrence ${i} doit etre renommee`);
    assert.equal(relues[i].teacherUsername, 'blaise', `occurrence ${i} doit avoir le nouveau prof`);
  }
});

test('un changement d\'heure sur une serie garde CHAQUE occurrence sur SA PROPRE date', async () => {
  H.reset(); await ecole();
  const occ = await serieHebdo({ fromDate: '2026-08-03', hour: 11, minute: 0, weeks: 4 });

  // Dates civiles ORIGINALES (heure de l'ecole), avant edition.
  const datesAvant = occ.map(s => S.utcToZoned(Date.parse(s.startsAt), S.DEFAULT_TZ));

  // Nouvelle heure voulue : 15h30, exprimee sur la date propre de l'occurrence
  // EDITEE (occ[1]) — c'est cette heure-du-jour qui doit se reporter sur les
  // suivantes, jamais la date du 2e Date.parse.
  const z1 = S.utcToZoned(Date.parse(occ[1].startsAt), S.DEFAULT_TZ);
  const nouvelleHeureMs = S.zonedToUtcMs({ y: z1.y, mo: z1.mo, d: z1.d, h: 15, mi: 30 }, S.DEFAULT_TZ);

  const r = await S.updateSeriesFrom(occ[1].id, { startsAt: new Date(nouvelleHeureMs).toISOString() });
  assert.equal(r.updated, 3);

  const relues = await Promise.all(occ.map(s => S.getSession(s.id)));

  // occ[0] (anterieure) : ni date ni heure ne doivent bouger.
  assert.equal(relues[0].startsAt, occ[0].startsAt);

  // occ[1..3] : la DATE reste celle d'origine (pas de collapse sur un seul
  // jour), seule l'HEURE change pour 15h30.
  for (let i = 1; i < 4; i++) {
    const apres = S.utcToZoned(Date.parse(relues[i].startsAt), S.DEFAULT_TZ);
    assert.equal(apres.y, datesAvant[i].y, `occurrence ${i} : annee inchangee`);
    assert.equal(apres.mo, datesAvant[i].mo, `occurrence ${i} : mois inchange`);
    assert.equal(apres.d, datesAvant[i].d, `occurrence ${i} : jour inchange`);
    assert.equal(apres.h, 15, `occurrence ${i} : heure deplacee a 15h`);
    assert.equal(apres.mi, 30, `occurrence ${i} : minute deplacee a 30`);
  }
  // Les 3 dates restent bien DISTINCTES (24 occurrences ne doivent jamais
  // s'ecraser sur un seul jour).
  const jours = new Set(relues.slice(1).map(s => s.startsAt.slice(0, 10)));
  assert.equal(jours.size, 3, 'les occurrences editees restent sur des jours distincts');
});

test('ajouter un eleve cree son attendance, en retirer un le fait disparaitre, celui qui reste garde son absence declaree', async () => {
  H.reset(); await ecole();
  const s = await S.createSession({
    courseId: 'python-boucles', courseLabel: 'Python', durationMin: 60,
    startsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
    students: ['bilal', 'sara'], teacherUsername: 'awa', teacherName: 'Awa Diop'
  });

  // Bilal declare une absence AVANT l'edition.
  const { session: s2 } = await S.declareAbsence(s, { username: 'bilal', reason: 'malade', studentName: 'Bilal' });
  const absenceAvant = s2.attendance.bilal;
  assert.equal(absenceAvant.status, 'absent');
  assert.ok(absenceAvant.declaredAt);

  // Edition : bilal reste, sara part, mohamedjr arrive.
  const updated = await S.updateSession(s.id, { students: ['bilal', 'mohamedjr'] });

  assert.deepEqual(updated.students.sort(), ['bilal', 'mohamedjr']);
  assert.equal(updated.attendance.sara, undefined, 'sara retiree : plus d\'entree attendance');
  assert.deepEqual(updated.attendance.bilal, absenceAvant, 'bilal reste : son absence declaree survit telle quelle');
  assert.deepEqual(updated.attendance.mohamedjr, { status: 'expected', declaredAt: null, reason: '', requestId: null },
    'mohamedjr est nouveau : entree "expected" fraiche');
});

test('changer l\'heure d\'une seance FUTURE reinitialise remindedAt', async () => {
  H.reset(); await ecole();
  const s = await S.createSession({
    courseId: 'python-boucles', courseLabel: 'Python', durationMin: 60,
    startsAt: new Date(Date.now() + 3 * 864e5).toISOString(),
    students: ['bilal'], teacherUsername: 'awa', teacherName: 'Awa Diop'
  });
  // Simule un rappel deja envoye a l'ANCIENNE heure.
  s.remindedAt = new Date().toISOString();
  await S.putSession(s);
  assert.ok((await S.getSession(s.id)).remindedAt);

  const nouvelleHeure = new Date(Date.now() + 5 * 864e5).toISOString();
  const updated = await S.updateSession(s.id, { startsAt: nouvelleHeure });

  assert.equal(updated.remindedAt, null, 'un deplacement vers une heure future doit reamorcer le rappel');
  assert.equal(updated.startsAt, nouvelleHeure);
});

test('session.update refuse un eleve inconnu (et ne modifie rien)', async () => {
  H.reset(); await ecole();
  const s = await S.createSession({
    courseId: 'python-boucles', courseLabel: 'Python', durationMin: 60,
    startsAt: new Date(Date.now() + 3 * 864e5).toISOString(),
    students: ['bilal'], teacherUsername: 'awa', teacherName: 'Awa Diop'
  });

  const r = await appel({
    action: 'session.update', id: s.id, scope: 'one',
    students: ['bilal', 'fantome'], courseLabel: 'Ne doit pas passer'
  }, adminToken());

  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, 'unknown_student');

  const intact = await S.getSession(s.id);
  assert.equal(intact.courseLabel, 'Python', 'aucune ecriture ne doit avoir eu lieu apres le rejet');
  assert.deepEqual(intact.students, ['bilal']);
});

test('session.update exige le jeton admin', async () => {
  H.reset(); await ecole();
  const s = await S.createSession({
    courseId: 'python-boucles', courseLabel: 'Python', durationMin: 60,
    startsAt: new Date(Date.now() + 3 * 864e5).toISOString(),
    students: ['bilal'], teacherUsername: 'awa', teacherName: 'Awa Diop'
  });
  const r = await appel({ action: 'session.update', id: s.id, scope: 'one', courseLabel: 'x' });
  assert.equal(r.statusCode, 401);
});

test('session.update (scope one) via le point d\'entree admin met a jour et renvoie updated:1', async () => {
  H.reset(); await ecole();
  const s = await S.createSession({
    courseId: 'python-boucles', courseLabel: 'Python', durationMin: 60,
    startsAt: new Date(Date.now() + 3 * 864e5).toISOString(),
    students: ['bilal'], teacherUsername: 'awa', teacherName: 'Awa Diop'
  });
  const r = await appel({
    action: 'session.update', id: s.id, scope: 'one',
    courseId: 'python-poo', courseLabel: 'Python · POO', durationMin: 90,
    students: ['bilal', 'sara'], teacherUsername: 'blaise'
  }, adminToken());

  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.updated, 1);
  assert.equal(r.body.session.courseId, 'python-poo');
  assert.equal(r.body.session.durationMin, 90);
  assert.equal(r.body.session.teacherUsername, 'blaise');
  assert.equal(r.body.session.teacherName, 'Blaise Mentor');
  assert.deepEqual(r.body.session.students.sort(), ['bilal', 'sara']);
});
