// Fonction serverless Vercel — RAPPELS AUTOMATIQUES avant les cours.
//
// Balaye les séances qui commencent dans moins de LEAD_MINUTES (60 par défaut),
// puis pour chaque séance :
//   - envoie un e-mail de rappel à chaque ÉLÈVE inscrit (+ WhatsApp si Meta configuré) ;
//   - envoie un e-mail de rappel au PROFESSEUR assigné (session.teacherUsername), le cas échéant.
// Marque la séance pour ne jamais renvoyer deux fois.
//
// DÉCLENCHEMENT — deux branchements possibles, l'endpoint accepte les deux :
//
//   A) Cron Vercel (plan Pro requis pour une fréquence < 1×/jour)
//      Ajouter dans vercel.json :
//        "crons": [{ "path": "/api/reminders", "schedule": "*/10 * * * *" }]
//      Vercel signe ses appels avec l'en-tête `Authorization: Bearer $CRON_SECRET`.
//
//   B) Déclencheur externe gratuit (plan Hobby) — cron-job.org, GitHub Actions…
//      Appeler toutes les 10 min :
//        curl -X POST https://<domaine>/api/reminders \
//             -H "Authorization: Bearer $CRON_SECRET"
//
// Variables d'environnement :
//   CRON_SECRET          (obligatoire) secret partagé protégeant l'endpoint
//   RESEND_API_KEY       (obligatoire) envoi des e-mails
//   REMINDER_LEAD_MIN    (optionnel)   délai avant le cours, en minutes. Défaut : 60
//   BOOKING_FROM_EMAIL   (optionnel)   expéditeur (domaine vérifié dans Resend)
//   + variables WHATSAPP_* (optionnel) — voir api/_whatsapp.js
//
// Réponses :
//   200 { ok:true, scanned, remindedSessions, emails:{sent,failed}, whatsapp:{sent,skipped,failed} }
//   401 { ok:false, error:'unauthorized' }        → secret absent ou faux
//   405 { ok:false, error:'method_not_allowed' }
//   500 { ok:false, error:'not_configured' }      → CRON_SECRET ou RESEND_API_KEY manquant

const A = require('./_auth');
const B = require('./_brand');
const S = require('./_schedule');
const WA = require('./_whatsapp');

const CRON_SECRET = process.env.CRON_SECRET || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = B.FROM_EMAIL;   // source unique : api/_brand.js
const LEAD_MINUTES = Number(process.env.REMINDER_LEAD_MIN) > 0 ? Number(process.env.REMINDER_LEAD_MIN) : 60;

// Comparaison à temps constant : évite de divulguer le secret par timing.
function secretOk(req) {
  if (!CRON_SECRET) return false;
  const hdr = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const got = String(hdr).replace(/^Bearer\s+/i, '');
  if (got.length !== CRON_SECRET.length) return false;
  const crypto = require('crypto');
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(CRON_SECRET));
}

async function resendSend(payload) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error((d && d.message) || `Resend HTTP ${r.status}`);
  return d.id;
}

// Heure locale lisible. Les modèles d'e-mail affichent l'heure suivie d'un libellé
// de fuseau (« HNE » par défaut, heure de l'Est). Les deux sont configurables :
//   REMINDER_TIMEZONE  fuseau IANA du calcul (défaut : America/Toronto = Est)
//   REMINDER_TZ_LABEL  libellé affiché après l'heure (défaut : HNE)
const TZ = process.env.REMINDER_TIMEZONE || 'America/Toronto';
const TZ_LABEL = process.env.REMINDER_TZ_LABEL || 'HNE';

// Heure seule, ex. « 17 h 00 » — pour la formule « à [heure] HNE ».
function clockTime(iso) {
  try {
    return new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch (_) {
    return new Date(iso).toISOString().slice(11, 16) + ' UTC';
  }
}
// Heure + libellé de fuseau, ex. « 17 h 00 HNE ».
const timeWithTz = (iso) => `${clockTime(iso)} ${TZ_LABEL}`;

// Date + heure complètes (rappel WhatsApp / contexte), ex. « lundi 20 juillet, 17 h 00 ».
function humanTime(iso) {
  try {
    return new Intl.DateTimeFormat('fr-CA', {
      timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit'
    }).format(new Date(iso));
  } catch (_) {
    return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}

// ── E-mail de rappel ÉLÈVE (et son parent) ──────────────────────────────────
function studentReminderHtml(user, session) {
  const eleve = B.esc(`${user.firstName || ''} ${user.lastName || ''}`.trim() || user.firstName || '');
  const cours = B.esc(session.courseLabel || session.courseId || 'ton cours');
  const heure = B.esc(timeWithTz(session.startsAt));
  const url = B.esc(B.PUBLIC_URL);
  return `
    <p style="font-family:Arial,sans-serif;font-size:15px">Bonjour ! ☀️</p>
    <p style="font-family:Arial,sans-serif;font-size:15px">
      Voici ton cours Koding Village prévu aujourd'hui pour <b>${eleve}</b> :
    </p>
    <p style="font-family:Arial,sans-serif;font-size:16px;margin:12px 0">
      <b>${cours}</b> à <b>${heure}</b>.
    </p>
    <p style="font-family:Arial,sans-serif;font-size:15px">
      Pour te connecter, annuler ou reporter ta séance (possible jusqu'à 1 heure avant le cours),
      connecte-toi à ton espace élève :<br>
      <a href="${url}" style="color:#4F46E5">${url}</a>
    </p>
    <p style="font-family:Arial,sans-serif;font-size:15px">
      Une fois connecté, utilise ton calendrier pour gérer tes séances ou clique directement
      sur le lien de cours le moment venu.
    </p>
    <p style="font-family:Arial,sans-serif;font-size:13px;color:#666">
      <i>Remarque : les annulations ou reports de cours ne sont autorisés que s'ils sont faits
      au moins 1 heure avant le cours.</i>
    </p>
    ${B.emailFooter()}`;
}

// ── E-mail de rappel PROFESSEUR ─────────────────────────────────────────────
function teacherReminderHtml(session, studentNames) {
  const prof = B.esc(session.teacherName || '');
  const cours = B.esc(session.courseLabel || session.courseId || 'ton cours');
  const heure = B.esc(timeWithTz(session.startsAt));
  const eleves = B.esc(studentNames.join(', '));
  const url = B.esc(B.PUBLIC_URL);
  return `
    <p style="font-family:Arial,sans-serif;font-size:15px">Bonjour ${prof} ! ☀️</p>
    <p style="font-family:Arial,sans-serif;font-size:15px">Voici ton cours Koding Village prévu aujourd'hui :</p>
    <table cellpadding="6" style="font-family:Arial,sans-serif;font-size:15px;border-collapse:collapse;margin:8px 0">
      <tr><td><b>Élève</b></td><td>${eleves}</td></tr>
      <tr><td><b>Cours</b></td><td>${cours} à <b>${heure}</b></td></tr>
    </table>
    <p style="font-family:Arial,sans-serif;font-size:15px">
      Pense à te connecter à ton espace pour lancer la session Zoom avec l'élève :<br>
      <a href="${url}" style="color:#4F46E5">${url}</a>
    </p>
    ${B.emailFooter()}`;
}

module.exports = async (req, res) => {
  // GET toléré : certains planificateurs externes n'envoient que des GET.
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }
  if (!CRON_SECRET || !RESEND_API_KEY || !A.kvConfigured()) {
    res.status(500).json({ ok: false, error: 'not_configured' });
    return;
  }
  if (!secretOk(req)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const now = Date.now();
  const horizon = now + LEAD_MINUTES * 60000;

  const stats = {
    scanned: 0, remindedSessions: 0,
    emails: { sent: 0, failed: 0 },
    whatsapp: { sent: 0, skipped: 0, failed: 0 }
  };

  try {
    // Fenêtre [maintenant → maintenant + LEAD] : toute séance non encore rappelée
    // qui démarre dans cet intervalle. Robuste au retard du cron — tant que la
    // séance n'a pas commencé, le rappel part au passage suivant.
    const sessions = await S.sessionsBetween(now, horizon);
    stats.scanned = sessions.length;

    for (const session of sessions) {
      if (session.remindedAt) continue;              // déjà traitée
      if (!session.students || !session.students.length) continue;

      // Les élèves ayant signalé leur absence sont écartés : leur rappeler un
      // cours qu'ils viennent d'annuler est la meilleure façon de les perdre.
      // Si plus personne n'est attendu, la séance est sautée (le prof n'a pas à
      // se connecter pour une classe vide) mais reste marquée pour ne pas être
      // re-balayée à chaque passage du cron.
      const attendus = S.expectedStudents(session);
      if (!attendus.length) {
        session.remindedAt = new Date().toISOString();
        await S.putSession(session);
        continue;
      }

      const cours = session.courseLabel || session.courseId || 'cours';
      // Noms complets des élèves de la séance — réutilisés dans l'e-mail du professeur.
      const studentNames = [];

      for (const username of attendus) {
        const user = await A.getUser(username);
        if (!user) continue;
        studentNames.push(`${user.firstName || ''} ${user.lastName || ''}`.trim() || username);

        // 1) Rappel ÉLÈVE, envoyé à l'E-MAIL de contact du compte (partagé possible
        //    par une fratrie — chaque élève reçoit néanmoins son propre rappel).
        if (user.email && user.email.indexOf('@') > 0) {
          try {
            await resendSend({
              from: `${B.BRAND} <${FROM_EMAIL}>`,
              to: [user.email],
              reply_to: B.CONTACT_EMAIL,
              subject: `Rappel : Ton cours Koding Village School aujourd'hui 🎓`,
              html: studentReminderHtml(user, session)
            });
            stats.emails.sent++;
          } catch (e) {
            stats.emails.failed++;
            console.error(`[reminders] e-mail élève échoué pour ${username} (${user.email}):`, e.message);
          }
        }

        // WhatsApp : best-effort, ne fait jamais échouer le rappel e-mail.
        try {
          const r = await WA.sendTemplate(user.phone, [
            cours, user.firstName || '', humanTime(session.startsAt)
          ]);
          if (r.sent) stats.whatsapp.sent++;
          else stats.whatsapp.skipped++;
        } catch (e) {
          stats.whatsapp.failed++;
          console.error(`[reminders] WhatsApp échoué pour ${username}:`, e.message);
        }
      }

      // 2) Rappel PROFESSEUR — un seul e-mail par séance, listant l'élève (ou les élèves).
      if (session.teacherUsername && studentNames.length) {
        const teacher = await A.getTeacher(session.teacherUsername);
        if (teacher && teacher.email && teacher.email.indexOf('@') > 0) {
          // Nom dénormalisé en priorité ; à défaut, celui du compte enseignant.
          if (!session.teacherName) {
            session.teacherName = `${teacher.firstName || ''} ${teacher.lastName || ''}`.trim();
          }
          try {
            await resendSend({
              from: `${B.BRAND} <${FROM_EMAIL}>`,
              to: [teacher.email],
              reply_to: B.CONTACT_EMAIL,
              subject: `Rappel de cours : ${studentNames.join(', ')} - ${cours} aujourd'hui 👨‍🏫`,
              html: teacherReminderHtml(session, studentNames)
            });
            stats.emails.sent++;
          } catch (e) {
            stats.emails.failed++;
            console.error(`[reminders] e-mail professeur échoué pour ${teacher.email}:`, e.message);
          }
        } else {
          console.warn(`[reminders] enseignant sans e-mail valide pour la séance ${session.id}: ${session.teacherUsername}`);
        }
      }

      // Marquée APRÈS les envois : si la fonction meurt en cours de route, le
      // passage suivant réessaie plutôt que de sauter la séance silencieusement.
      session.remindedAt = new Date().toISOString();
      await S.putSession(session);
      stats.remindedSessions++;
    }

    res.status(200).json({ ok: true, leadMinutes: LEAD_MINUTES, ...stats });
  } catch (e) {
    console.error('[reminders] erreur:', e.message);
    res.status(500).json({ ok: false, error: 'server_error', message: String(e.message || '') });
  }
};
