// Fonction serverless Vercel — RAPPELS AUTOMATIQUES avant les cours.
//
// Balaye les séances qui commencent dans moins de LEAD_MINUTES (60 par défaut),
// envoie un e-mail (Resend) à chaque élève inscrit, et un message WhatsApp si
// l'API Meta est configurée. Marque la séance pour ne jamais renvoyer deux fois.
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

// Heure locale lisible pour l'élève. Faute de fuseau par élève, on utilise
// REMINDER_TIMEZONE (défaut : America/Vancouver, cohérent avec l'indicatif +1 604).
const TZ = process.env.REMINDER_TIMEZONE || 'America/Vancouver';
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

function reminderHtml(user, session, minutesLeft) {
  const prenom = B.esc(user.firstName || '');
  const cours = B.esc(session.courseLabel || session.courseId || 'ton cours');
  return `
    <p style="font-family:Arial,sans-serif;font-size:15px">Bonjour ${prenom},</p>
    <p style="font-family:Arial,sans-serif;font-size:15px">
      Petit rappel : ton cours <b>${cours}</b> commence dans <b>${minutesLeft} minutes</b>
      (${B.esc(humanTime(session.startsAt))}).
    </p>
    <p style="font-family:Arial,sans-serif;font-size:15px">
      Installe-toi au calme et connecte-toi à ton espace élève quelques minutes en avance :<br>
      <a href="${B.esc(B.PUBLIC_URL)}" style="color:#4F46E5">${B.esc(B.PUBLIC_URL)}</a>
    </p>
    <p style="font-family:Arial,sans-serif;font-size:15px">À tout de suite ! 🚀</p>
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

      const minutesLeft = Math.max(1, Math.round((Date.parse(session.startsAt) - now) / 60000));

      for (const email of session.students) {
        const user = await A.getUser(email);
        if (!user) continue;

        try {
          await resendSend({
            from: `${B.BRAND} <${FROM_EMAIL}>`,
            to: [email],
            reply_to: B.CONTACT_EMAIL,
            subject: `Ton cours ${session.courseLabel || ''} commence dans ${minutesLeft} min ⏰`,
            html: reminderHtml(user, session, minutesLeft)
          });
          stats.emails.sent++;
        } catch (e) {
          stats.emails.failed++;
          console.error(`[reminders] e-mail échoué pour ${email}:`, e.message);
        }

        // WhatsApp : best-effort, ne fait jamais échouer le rappel e-mail.
        try {
          const r = await WA.sendTemplate(user.phone, [
            session.courseLabel || session.courseId,
            user.firstName || '',
            humanTime(session.startsAt)
          ]);
          if (r.sent) stats.whatsapp.sent++;
          else stats.whatsapp.skipped++;
        } catch (e) {
          stats.whatsapp.failed++;
          console.error(`[reminders] WhatsApp échoué pour ${email}:`, e.message);
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
