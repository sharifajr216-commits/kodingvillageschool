// Bibliothèque PARTAGÉE (préfixe `_` → non routée par Vercel).
// E-MAILS DU CYCLE « ABSENCE → DEMANDE DE RATTRAPAGE → DÉCISION »
// + ALERTE DE NOUVEAU MESSAGE (messagerie enseignant ↔ famille).
//
// Regroupés ici parce que TROIS points d'entrée doivent envoyer exactement les
// mêmes messages, et qu'un libellé qui diverge entre eux se voit tout de suite :
//   - api/session-action.js  l'élève annule       → alerte prof + admin
//   - api/reschedule.js      décision par e-mail  → retour à l'élève
//   - api/admin.js           décision depuis le panneau admin → même retour élève
//   - api/messages.js        nouveau message      → alerte destinataire
//
// Envois « best-effort » : une panne Resend ne doit jamais annuler une absence
// ou une décision déjà enregistrée en base.

const A = require('./_auth');
const B = require('./_brand');
const M = require('./_mail');

// Durée de validité des liens de décision envoyés par e-mail.
const DECISION_TOKEN_TTL = 30 * 24 * 3600;

const ACTOR_LABEL = { teacher: 'le professeur', admin: "l'administration" };

// Lien de validation nominatif : le jeton porte la demande ET l'identité du
// décideur, si bien qu'un lien transféré reste tracé au nom de son destinataire.
function decisionUrl(requestId, actor, decision) {
  const token = A.signToken({ purpose: 'resched', rid: requestId, actor }, DECISION_TOKEN_TTL);
  return `${B.PUBLIC_URL}/api/reschedule?t=${encodeURIComponent(token)}&d=${decision}`;
}

// ── 1) Alerte prof / admin : « l'élève a annulé et propose ce créneau » ─────
function requestHtml(rq, actor) {
  const motif = rq.reason
    ? `<tr><td style="padding:6px 10px"><b>Motif</b></td><td style="padding:6px 10px">${B.esc(rq.reason)}</td></tr>`
    : '';
  return `
    <p style="font-family:Arial,sans-serif;font-size:15px">Bonjour ${B.esc(rq.teacherName || '')},</p>
    <p style="font-family:Arial,sans-serif;font-size:15px">
      <b>${B.esc(rq.studentName)}</b> vient d'<b>annuler</b> sa séance et demande un <b>rattrapage</b>.
    </p>

    <table cellpadding="0" style="font-family:Arial,sans-serif;font-size:15px;border-collapse:collapse;margin:14px 0;width:100%;max-width:520px">
      <tr><td colspan="2" style="padding:8px 10px;background:#FEF2F2;color:#991B1B;font-weight:bold">Séance annulée</td></tr>
      <tr><td style="padding:6px 10px;width:130px"><b>Cours</b></td><td style="padding:6px 10px">${B.esc(rq.courseLabel)}</td></tr>
      <tr><td style="padding:6px 10px"><b>Horaire</b></td><td style="padding:6px 10px"><s>${B.esc(M.longDateTime(rq.originalStartsAt))}</s></td></tr>
      ${motif}
      <tr><td colspan="2" style="padding:8px 10px;background:#ECFDF5;color:#065F46;font-weight:bold">Rattrapage demandé par l'élève</td></tr>
      <tr><td style="padding:6px 10px"><b>Nouvel horaire</b></td><td style="padding:6px 10px"><b>${B.esc(M.longDateTime(rq.requestedStartsAt))}</b></td></tr>
      <tr><td style="padding:6px 10px"><b>Durée</b></td><td style="padding:6px 10px">${B.esc(String(rq.durationMin))} minutes</td></tr>
    </table>

    <p style="font-family:Arial,sans-serif;font-size:15px;margin-bottom:4px">Ce créneau te convient-il ?</p>
    <p style="margin:0">
      ${M.button(decisionUrl(rq.requestId, actor, 'approve'), '✓ Valider ce rattrapage', '#059669')}
      ${M.button(decisionUrl(rq.requestId, actor, 'refuse'), '✕ Refuser', '#DC2626')}
    </p>
    <p style="font-family:Arial,sans-serif;font-size:13px;color:#666">
      Un clic ouvre une page de confirmation — rien n'est décidé tant que tu n'as pas confirmé.
      Tant que personne n'a tranché, la demande reste « en attente » dans l'espace d'administration.
    </p>
    ${B.emailFooter()}`;
}

// Prévient le professeur assigné ET l'administration.
async function notifyDecisionMakers(rq) {
  const out = { teacher: null, admin: null };
  if (!M.configured()) {
    console.warn('[notify] RESEND_API_KEY absente — aucune notification envoyée');
    return out;
  }

  if (rq.teacherUsername) {
    const teacher = await A.getTeacher(rq.teacherUsername);
    if (teacher && teacher.email && teacher.email.indexOf('@') > 0) {
      if (!rq.teacherName) rq.teacherName = `${teacher.firstName || ''} ${teacher.lastName || ''}`.trim();
      out.teacher = await M.sendSafe({
        from: `${B.BRAND} <${B.FROM_EMAIL}>`,
        to: [teacher.email],
        reply_to: B.CONTACT_EMAIL,
        subject: `Annulation + demande de rattrapage — ${rq.studentName} (${rq.courseLabel})`,
        html: requestHtml(rq, 'teacher')
      }, `alerte prof ${rq.requestId}`);
    } else {
      console.warn(`[notify] enseignant sans e-mail valide : ${rq.teacherUsername}`);
    }
  }

  if (A.ADMIN_EMAIL) {
    out.admin = await M.sendSafe({
      from: `${B.BRAND} <${B.FROM_EMAIL}>`,
      to: [A.ADMIN_EMAIL],
      reply_to: B.CONTACT_EMAIL,
      subject: `[Admin] Rattrapage à valider — ${rq.studentName} (${rq.courseLabel})`,
      html: requestHtml(rq, 'admin')
    }, `alerte admin ${rq.requestId}`);
  }

  return out;
}

// ── 2) Retour vers l'élève une fois la décision prise ───────────────────────
// Sans lui, l'élève n'apprend jamais si son rattrapage est accepté : c'est
// exactement le trou de communication à l'origine des réclamations.
async function notifyStudentOfDecision(rq) {
  if (!rq || !rq.studentEmail || rq.studentEmail.indexOf('@') < 0 || !M.configured()) return { sent: false };
  const approuve = rq.state === 'approved';
  const corps = approuve
    ? `<p style="font-family:Arial,sans-serif;font-size:15px">Bonne nouvelle : ton rattrapage est <b style="color:#059669">confirmé</b> ✅</p>
       <p style="font-family:Arial,sans-serif;font-size:16px"><b>${B.esc(rq.courseLabel)}</b><br>
          ${B.esc(M.longDateTime(rq.requestedStartsAt))} · ${B.esc(String(rq.durationMin))} minutes</p>
       <p style="font-family:Arial,sans-serif;font-size:15px">La séance apparaît dès maintenant dans
          « Mes prochains cours », avec le bouton pour rejoindre le direct le moment venu.</p>`
    : `<p style="font-family:Arial,sans-serif;font-size:15px">Le créneau de rattrapage que tu as proposé
          (${B.esc(M.longDateTime(rq.requestedStartsAt))}) <b style="color:#DC2626">n'a pas pu être retenu</b>.</p>
       ${rq.decidedNote ? `<p style="font-family:Arial,sans-serif;font-size:15px">Message : ${B.esc(rq.decidedNote)}</p>` : ''}
       <p style="font-family:Arial,sans-serif;font-size:15px">Écris-nous pour convenir ensemble d'un autre horaire —
          on trouvera une solution.</p>`;
  return M.sendSafe({
    from: `${B.BRAND} <${B.FROM_EMAIL}>`,
    to: [rq.studentEmail],
    reply_to: B.CONTACT_EMAIL,
    subject: approuve
      ? `Rattrapage confirmé — ${rq.courseLabel} ✅`
      : `Ta demande de rattrapage — ${rq.courseLabel}`,
    html: `<p style="font-family:Arial,sans-serif;font-size:15px">Bonjour ${B.esc(rq.studentName)},</p>
           ${corps}
           <p style="font-family:Arial,sans-serif;font-size:15px"><a href="${B.esc(B.PUBLIC_URL)}" style="color:#4F46E5">Ouvrir mon espace élève</a></p>
           ${B.emailFooter()}`
  }, `retour élève ${rq.requestId}`);
}

// ── 3) Alerte « nouveau message » ───────────────────────────────────────────
//
// L'e-mail NE RECOPIE PAS le message : il invite à ouvrir l'espace. Le contenu
// d'un échange sur un enfant n'a pas à traîner dans des boîtes mail, et c'est
// aussi ce qui rend l'accusé de lecture honnête (lire l'e-mail ≠ lire le fil).
//
// `side` est le DESTINATAIRE ('teacher' ou 'student').
async function notifyNewMessage(thread, message, side) {
  if (!M.configured()) {
    console.warn('[notify] RESEND_API_KEY absente — aucune alerte de message envoyée');
    return { sent: false };
  }
  const versFamille = side === 'student';
  const compte = versFamille
    ? await A.getUser(thread.studentUsername)
    : await A.getTeacher(thread.teacherUsername);
  const dest = compte && compte.email;
  if (!dest || dest.indexOf('@') < 0) {
    console.warn(`[notify] destinataire sans e-mail valide pour le fil ${thread.id}`);
    return { sent: false };
  }

  // L'e-mail de contact est partageable par une fratrie : sans le prénom de
  // l'enfant dans l'objet, un parent de deux élèves ne sait pas lequel est concerné.
  // Côté prof, l'expéditeur EST toujours l'élève nommé dans le fil (fromRole
  // 'student') : y ajouter « (Nom de l'élève) » ne fait que répéter le même nom.
  const sujet = versFamille
    ? `Message de ${message.fromName} au sujet de ${thread.studentName}`
    : message.fromRole === 'student'
      ? `Message de ${message.fromName}`
      : `Message de ${message.fromName} (${thread.studentName})`;

  const bonjour = versFamille ? 'Bonjour,' : `Bonjour ${B.esc(thread.teacherName)},`;

  // Le destinataire du côté famille est le PARENT (compte de contact), pas
  // l'enfant — d'où le vouvoiement dans cette branche, alors que le prof
  // continue d'être tutoyé comme partout ailleurs dans le produit.
  const corpsIntro = versFamille
    ? `<b>${B.esc(message.fromName)}</b> vous a envoyé un message au sujet de <b>${B.esc(thread.studentName)}</b> sur votre espace ${B.esc(B.BRAND)}.`
    : `<b>${B.esc(message.fromName)}</b> t'a envoyé un message sur ton espace ${B.esc(B.BRAND)}.`;
  const rappel = versFamille
    ? `Vous ne recevrez pas de nouvel e-mail pour cette conversation tant que vous ne l'aurez pas ouverte.`
    : `Tu ne recevras pas de nouvel e-mail pour cette conversation tant que tu ne l'auras pas ouverte.`;

  return M.sendSafe({
    from: `${B.BRAND} <${B.FROM_EMAIL}>`,
    to: [dest],
    reply_to: B.CONTACT_EMAIL,
    subject: sujet,
    html: `
      <p style="font-family:Arial,sans-serif;font-size:15px">${bonjour}</p>
      <p style="font-family:Arial,sans-serif;font-size:15px">${corpsIntro}</p>
      <p style="font-family:Arial,sans-serif;font-size:15px">
        <a href="${B.esc(B.PUBLIC_URL)}" style="color:#4F46E5">Ouvrir la conversation</a>
      </p>
      <p style="font-family:Arial,sans-serif;font-size:13px;color:#666">${rappel}</p>
      ${B.emailFooter()}`
  }, `alerte message ${message.id}`);
}

module.exports = { notifyDecisionMakers, notifyStudentOfDecision, notifyNewMessage, decisionUrl, ACTOR_LABEL };
