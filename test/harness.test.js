const { test } = require('node:test');
const assert = require('node:assert');
const { installHarness } = require('./helpers/harness');

const H = installHarness();
const A = require('../api/_auth');

test('le harnais rend le KV opérationnel', async () => {
  H.reset();
  assert.equal(A.kvConfigured(), true);
  await A.kv(['SET', 'essai', 'valeur']);
  assert.equal(await A.kv(['GET', 'essai']), 'valeur');
});

test('le ZSET trie par score croissant et décroissant', async () => {
  H.reset();
  await A.kv(['ZADD', 'z', '20', 'b']);
  await A.kv(['ZADD', 'z', '10', 'a']);
  assert.deepEqual(await A.kv(['ZRANGEBYSCORE', 'z', '-inf', '+inf']), ['a', 'b']);
  assert.deepEqual(await A.kv(['ZREVRANGE', 'z', '0', '-1']), ['b', 'a']);
});

test('EXPIRE rend la clé absente une fois le délai écoulé', async () => {
  H.reset();
  await A.kv(['SET', 'court', '1']);
  await A.kv(['EXPIRE', 'court', '-1']);
  assert.equal(await A.kv(['GET', 'court']), null);
});

test('les e-mails sont capturés et non envoyés', async () => {
  H.reset();
  const M = require('../api/_mail');
  await M.send({ from: 'a@b.c', to: ['d@e.f'], subject: 'Essai', html: '<p>bonjour</p>' });
  assert.equal(H.mails.length, 1);
  assert.equal(H.mails[0].subject, 'Essai');
});
