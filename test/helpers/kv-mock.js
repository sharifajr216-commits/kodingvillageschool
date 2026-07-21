// Sous-ensemble Redis réellement utilisé par le projet, en mémoire.
// Aucune dépendance : le vrai KV est appelé en REST, on intercepte donc au niveau
// de fetch plutôt que de simuler un client.

function createStore() {
  return { strings: new Map(), sets: new Map(), zsets: new Map(), expiries: new Map() };
}

// Applique l'expiration paresseusement : une clé expirée se comporte comme absente.
function alive(store, key) {
  const exp = store.expiries.get(key);
  if (exp !== undefined && exp <= Date.now()) {
    store.strings.delete(key); store.sets.delete(key); store.zsets.delete(key);
    store.expiries.delete(key);
    return false;
  }
  return true;
}

function kvExec(store, cmd) {
  const [rawOp, key, ...rest] = cmd;
  const op = String(rawOp).toUpperCase();
  if (key !== undefined) alive(store, key);

  switch (op) {
    case 'GET': return store.strings.has(key) ? store.strings.get(key) : null;
    case 'SET': store.strings.set(key, rest[0]); return 'OK';
    case 'DEL': {
      const had = store.strings.delete(key) || store.sets.delete(key) || store.zsets.delete(key);
      store.expiries.delete(key);
      return had ? 1 : 0;
    }
    case 'INCR': {
      const n = Number(store.strings.get(key) || 0) + 1;
      store.strings.set(key, String(n));
      return n;
    }
    case 'EXPIRE': store.expiries.set(key, Date.now() + Number(rest[0]) * 1000); return 1;
    case 'SADD': {
      const s = store.sets.get(key) || new Set();
      s.add(rest[0]); store.sets.set(key, s); return 1;
    }
    case 'SREM': { const s = store.sets.get(key); if (s) s.delete(rest[0]); return 1; }
    case 'SMEMBERS': return [...(store.sets.get(key) || [])];
    case 'ZADD': {
      const z = store.zsets.get(key) || new Map();
      z.set(rest[1], Number(rest[0])); store.zsets.set(key, z); return 1;
    }
    case 'ZREM': { const z = store.zsets.get(key); if (z) z.delete(rest[0]); return 1; }
    case 'ZCARD': return (store.zsets.get(key) || new Map()).size;
    case 'ZRANGEBYSCORE': {
      const z = store.zsets.get(key) || new Map();
      const lo = rest[0] === '-inf' ? -Infinity : Number(rest[0]);
      const hi = rest[1] === '+inf' ? Infinity : Number(rest[1]);
      let out = [...z.entries()].filter(([, sc]) => sc >= lo && sc <= hi)
        .sort((a, b) => a[1] - b[1]).map(([m]) => m);
      const li = rest.findIndex(r => String(r).toUpperCase() === 'LIMIT');
      if (li >= 0) {
        const off = Number(rest[li + 1]) || 0;
        out = out.slice(off, off + (Number(rest[li + 2]) || out.length));
      }
      return out;
    }
    case 'ZREVRANGE': {
      const z = store.zsets.get(key) || new Map();
      const all = [...z.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
      const start = Number(rest[0]) || 0;
      const stop = Number(rest[1]);
      return all.slice(start, stop === -1 ? undefined : stop + 1);
    }
    default: throw new Error('commande KV non simulée : ' + op);
  }
}

module.exports = { createStore, kvExec };
