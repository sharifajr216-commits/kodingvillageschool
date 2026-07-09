// ============================================================
//  POST /api/zoom/signature   { meetingNumber, role }
//
//  OPTION B — préparation de l'incrustation vidéo (@zoomus/websdk).
//  Génère la signature JWT (HS256) exigée par le Meeting SDK Zoom,
//  signée côté serveur avec ZOOM_SDK_SECRET (jamais exposé au client).
//
//  role : 0 = participant (élève), 1 = animateur (mentor).
//  Renvoie 501 tant que le Meeting SDK n'est pas configuré → le front
//  conserve alors l'OPTION A (redirection) sans incrustation.
// ============================================================

const crypto = require('crypto');

// Encodage base64url (sans '=', '+', '/')
function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const sdkKey = process.env.ZOOM_SDK_KEY;
  const sdkSecret = process.env.ZOOM_SDK_SECRET;
  if (!sdkKey || !sdkSecret) {
    res.status(501).json({ error: 'Meeting SDK non configuré (ZOOM_SDK_KEY / ZOOM_SDK_SECRET).' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const meetingNumber = String((body && body.meetingNumber) || '').trim();
  const role = Number((body && body.role) || 0);
  if (!meetingNumber) {
    res.status(400).json({ error: 'meetingNumber manquant.' });
    return;
  }

  const iat = Math.floor(Date.now() / 1000) - 30; // petite marge d'horloge
  const exp = iat + 60 * 60 * 2;                   // valable 2 h

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    appKey: sdkKey,
    sdkKey: sdkKey,
    mn: meetingNumber,
    role: role,
    iat: iat,
    exp: exp,
    tokenExp: exp
  };

  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createHmac('sha256', sdkSecret)
    .update(unsigned)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  res.status(200).json({ signature: `${unsigned}.${signature}`, sdkKey });
};
