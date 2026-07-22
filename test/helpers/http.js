// Faux couple req/res compatible avec la signature des fonctions Vercel
// (res.status().json()), pour appeler un point d'entrée sans serveur HTTP.

function faireRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.send = (b) => { res.body = b; return res; };
  return res;
}

// Appelle un handler Vercel en POST, avec jeton facultatif.
function appeler(handler) {
  return async function appel(body, token) {
    const req = {
      method: 'POST',
      headers: token ? { authorization: 'Bearer ' + token } : {},
      body, query: {}
    };
    const res = faireRes();
    await handler(req, res);
    return res;
  };
}

module.exports = { faireRes, appeler };
