// Fonction serverless Vercel — MESSAGERIE ENSEIGNANT ↔ FAMILLE.
//
// 🔒 CLOISONNEMENT : l'identité vient du JETON SIGNÉ (payload.sub / payload.role),
//    jamais du corps de la requête. Un élève ne peut donc lire que SES fils.
//
// En-tête : Authorization: Bearer <token>   (ou body.token en repli)
//
// POST { action:'threads.list' }                          → { ok, role, threads:[…] }
// POST { action:'thread.open', threadId, before? }        → { ok, thread, messages:[…] }
//        `before` = identifiant de message (curseur d'historique), pas un horodatage.
// POST { action:'message.send', threadId|to, body }       → { ok, message, notified }
// POST { action:'contacts.list' }                         → { ok, contacts:[…] }
//
// Codes : 400 invalid_body · 401 unauthorized · 403 not_allowed / not_a_participant /
//         read_only · 429 too_many · 500 not_configured / server_error
//
// L'ADMIN est en LECTURE SEULE : il lit tous les fils (supervision annoncée aux
// participants) mais ne peut ni écrire ni marquer un fil comme lu — sa lecture ne
// doit pas faire croire à l'enseignant que la famille a ouvert le message.

const A = require('./_auth');
const M = require('./_messages');
const N = require('./_notify');

function readToken(req, body) {
  const hdr = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const t = String(hdr).replace(/^Bearer\s+/i, '');
  return t || (body && body.token) || '';
}

// Vue transmise au navigateur : on ne renvoie jamais l'objet fil brut, pour ne pas
// divulguer l'état de lecture de l'autre partie au-delà de ce qui est nécessaire.
function threadView(t, side) {
  const moi = side === 'admin' ? null : side;
  const autre = moi === 'teacher' ? 'student' : 'teacher';
  return {
    id: t.id,
    teacherName: t.teacherName, studentName: t.studentName,
    teacherUsername: t.teacherUsername, studentUsername: t.studentUsername,
    withName: moi === 'teacher' ? t.studentName : t.teacherName,
    lastSnippet: t.lastSnippet, lastMessageAt: t.lastMessageAt, lastFrom: t.lastFrom,
    unread: moi ? (t.unread || {})[moi] || 0 : 0,
    // Horodatage de lecture de l'AUTRE : c'est ce qui affiche « Lu » à l'expéditeur.
    otherReadAt: moi ? (t.lastReadAt || {})[autre] : null,
    readOnly: side === 'admin'
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  if (!A.configured() || !A.kvConfigured()) { res.status(500).json({ ok: false, error: 'not_configured' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

  const payload = A.verifyToken(readToken(req, body));
  const role = payload && payload.role;
  if (!payload || !payload.sub || !['teacher', 'student', 'admin'].includes(role)) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  const me = A.normUsername(payload.sub);
  const isAdmin = role === 'admin';

  // L'appelant participe-t-il à ce fil ?
  const participe = (t) => isAdmin
    || (role === 'teacher' && t.teacherUsername === me)
    || (role === 'student' && t.studentUsername === me);

  try {
    if (body.action === 'threads.list') {
      const fils = await M.listThreads(isAdmin ? 'admin' : role, me, 50);
      res.status(200).json({ ok: true, role, threads: fils.map(t => threadView(t, isAdmin ? 'admin' : role)) });
      return;
    }

    if (body.action === 'contacts.list') {
      if (isAdmin) { res.status(200).json({ ok: true, contacts: [] }); return; }
      res.status(200).json({ ok: true, contacts: await M.contactsFor(role, me) });
      return;
    }

    if (body.action === 'thread.open') {
      const t = await M.getThread(String(body.threadId || '').slice(0, 100));
      if (!t) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      if (!participe(t)) { res.status(403).json({ ok: false, error: 'not_a_participant' }); return; }

      const messages = await M.getMessages(t.id, { limit: 50, before: body.before || null });
      // La lecture admin ne marque rien : voir l'avertissement en tête de fichier.
      const apres = isAdmin ? t : await M.markRead(t, role);
      res.status(200).json({
        ok: true,
        thread: threadView(apres, isAdmin ? 'admin' : role),
        messages
      });
      return;
    }

    if (body.action === 'message.send') {
      if (isAdmin) { res.status(403).json({ ok: false, error: 'read_only', message: 'La supervision est en lecture seule.' }); return; }

      const texte = String(body.body == null ? '' : body.body).trim();
      if (!texte || texte.length > M.MAX_BODY) {
        res.status(400).json({ ok: false, error: 'invalid_body', message: `Le message doit contenir entre 1 et ${M.MAX_BODY} caractères.` });
        return;
      }

      // Garde-fou AVANT toute écriture : placé après la résolution du fil, une
      // rafale bloquée aurait quand même créé les fils au passage.
      if (await M.rateLimited(me)) {
        res.status(429).json({ ok: false, error: 'too_many', message: 'Trop de messages envoyés. Réessaie dans quelques minutes.' });
        return;
      }

      // Résolution du fil : soit il existe, soit on le crée après contrôle du droit.
      let thread;
      if (body.threadId) {
        thread = await M.getThread(String(body.threadId).slice(0, 100));
        if (!thread) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
        if (!participe(thread)) { res.status(403).json({ ok: false, error: 'not_a_participant' }); return; }
      } else {
        // Le rôle du destinataire se DÉDUIT de celui de l'appelant : jamais lu du corps.
        const autre = A.normUsername(body.to);
        if (!autre) { res.status(400).json({ ok: false, error: 'invalid_body', message: 'Destinataire manquant.' }); return; }
        const teacherUsername = role === 'teacher' ? me : autre;
        const studentUsername = role === 'teacher' ? autre : me;
        if (!(await M.canOpen(teacherUsername, studentUsername))) {
          res.status(403).json({ ok: false, error: 'not_allowed', message: 'Aucun cours ne vous relie à cet interlocuteur.' });
          return;
        }
        thread = await M.ensureThread({ teacherUsername, studentUsername });
      }

      const acct = role === 'teacher' ? await A.getTeacher(me) : await A.getUser(me);
      const fromName = acct ? (`${acct.firstName || ''} ${acct.lastName || ''}`.trim() || me) : me;

      // Le message est persisté ICI, avant toute tentative d'e-mail.
      const r = await M.appendMessage(thread, { fromRole: role, fromUsername: me, fromName, body: texte });

      // Alerte best-effort, et seulement si le destinataire n'en a pas déjà une en attente.
      //
      // Le try/catch est indispensable : `sendSafe` protège l'appel à Resend, mais
      // pas les lectures de compte qui le précèdent. Sans lui, une panne KV APRÈS
      // la persistance du message renverrait 500 alors que le message est bien
      // enregistré — le client réessaierait et le publierait en double.
      const dest = M.otherSide(role);
      let notified = false;
      if (M.shouldAlert(r.thread, dest)) {
        try {
          const envoi = await N.notifyNewMessage(r.thread, r.message, dest);
          if (envoi && envoi.sent) { await M.noteAlerted(r.thread, dest); notified = true; }
        } catch (e) {
          console.error('[messages] alerte non envoyée:', e.message);
        }
      }

      res.status(200).json({ ok: true, message: r.message, notified });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[messages]', e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
