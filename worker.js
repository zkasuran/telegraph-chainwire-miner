// Telegraph on-chain reads miner: two canonical intents that had no miner at all.
//
//   TOKEN_HOLDER_COUNT   how many distinct addresses hold a token, from Blockscout.
//   WALLET_BALANCE_CHECK native or ERC-20 balance of an address or ENS name.
//
// Same shape as the GasWire miner: no API key, no database, every figure read live
// at request time, providers raced so one slow endpoint cannot eat a spot check's
// deadline, a ten second per-isolate memo so a hot answer costs milliseconds, and a
// /__last ring buffer so the node's real call shape can be observed rather than guessed.

// eth_getBalance and eth_call work on every EVM chain, so balance covers all of these.
const CHAINS = {
  ethereum: { id: 1, rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'] },
  base: { id: 8453, rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'] },
  arbitrum: { id: 42161, rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'] },
  optimism: { id: 10, rpcs: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'] },
  polygon: { id: 137, rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'] },
  'base-sepolia': { id: 84532, rpcs: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'] },
  sepolia: { id: 11155111, rpcs: ['https://ethereum-sepolia-rpc.publicnode.com'] },
};

// Holder counts come from Blockscout, which only has a public instance for some chains.
// Only the four verified to answer /api/v2/tokens keylessly are listed, so a holder
// query on a chain we cannot back honestly returns an error rather than a guess.
const BLOCKSCOUT = {
  ethereum: 'https://eth.blockscout.com',
  base: 'https://base.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
  polygon: 'https://polygon.blockscout.com',
};

const ALIASES = {
  eth: 'ethereum', ether: 'ethereum', mainnet: 'ethereum', l1: 'ethereum',
  'base mainnet': 'base', basechain: 'base', arb: 'arbitrum', 'arbitrum one': 'arbitrum',
  op: 'optimism', 'op mainnet': 'optimism', matic: 'polygon', 'polygon pos': 'polygon',
  'base sepolia': 'base-sepolia', basesepolia: 'base-sepolia',
};

// A small verified table so a whole question ("holders of USDC on base") resolves a
// symbol to the right contract. Every address here was read back from the chain. Any
// other token is still served by passing its 0x address directly.
const MAJORS = {
  ethereum: { usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dai: '0x6B175474E89094C44Da98b954EedeAC495271d0F', weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  base: { usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', weth: '0x4200000000000000000000000000000000000006' },
  arbitrum: { usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', usdt: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  polygon: { usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', usdt: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', weth: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619' },
};

const UNSPECIFIED = /^(\{.*\}|network|chain|:network|:chain|%7b.*%7d)$/i;

// The node probes declared paths with the template unfilled ("/holders/{chain}/{token}").
// An unfilled slot has not named anything, which is different from naming something we do
// not serve, so a probe resolves to a sensible default and answers 200 rather than 400.
// This is the GasWire lesson: a 400 on an unfilled probe reads as "miner did not respond"
// and freezes the miner out of routing for a whole epoch.
const TEMPLATE = /^(\{.*\}|%7b.*%7d|:?(network|chain|token|address|wallet|ens|account))$/i;
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

function resolveChain(raw, forHolders = false) {
  if (!raw) return null;
  const table = forHolders ? BLOCKSCOUT : CHAINS;
  const key = String(raw).trim().toLowerCase().replace(/[_+]/g, ' ');
  if (UNSPECIFIED.test(key)) return forHolders ? 'ethereum' : 'ethereum';
  if (table[key]) return key;
  if (ALIASES[key] && table[ALIASES[key]]) return ALIASES[key];
  const squashed = key.replace(/\s+/g, '');
  if (table[squashed]) return squashed;
  if (ALIASES[squashed] && table[ALIASES[squashed]]) return ALIASES[squashed];
  // Tolerate a whole question. Only whole words, only names long enough to be
  // unambiguous, so "op" inside a word never triggers.
  for (const name of [...Object.keys(table), ...Object.keys(ALIASES)]) {
    if (name.length < 4) continue;
    const canon = table[name] ? name : ALIASES[name];
    if (!canon || !table[canon]) continue;
    const pattern = new RegExp(`(^|[^a-z0-9])${name.replace(/[-\s]/g, '[-\\s]')}($|[^a-z0-9])`);
    if (pattern.test(key)) return canon;
  }
  return null;
}

// Pull a token out of free text: a 0x address, or a known symbol resolved per chain.
function resolveToken(raw, chain) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const addr = s.match(/0x[0-9a-f]{40}/);
  if (addr) return { address: addr[0], symbol: null };
  const majors = MAJORS[chain] || {};
  for (const sym of Object.keys(majors)) {
    const pattern = new RegExp(`(^|[^a-z0-9])${sym}($|[^a-z0-9])`);
    if (pattern.test(s)) return { address: majors[sym], symbol: sym.toUpperCase() };
  }
  return null;
}

// An address or an ENS name. ENS always resolves on mainnet, whatever the target chain.
function extractAddress(raw) {
  if (!raw) return { address: null, ens: null };
  const s = String(raw).trim();
  const addr = s.match(/0x[0-9a-fA-F]{40}/);
  if (addr) return { address: addr[0], ens: null };
  const ens = s.match(/([a-z0-9-]+\.eth)/i);
  if (ens) return { address: null, ens: ens[1].toLowerCase() };
  return { address: null, ens: null };
}

async function rpc(url, method, params, timeoutMs = 4000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method} http ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

// Race providers rather than trying them in turn: a spot check has a deadline.
async function firstOk(rpcs, method, params, timeoutMs) {
  if (rpcs.length === 1) return rpc(rpcs[0], method, params, timeoutMs);
  try {
    return await Promise.any(rpcs.map((u) => rpc(u, method, params, timeoutMs)));
  } catch (err) {
    throw err?.errors?.[0] ?? err;
  }
}

// ENS resolves through two independent keyless public resolvers, raced. Both are read
// only and return the same address for a name, so the first to answer wins and one being
// down does not block a balance lookup. Still no key anywhere in the request path.
const ENS_RESOLVERS = [
  (name) => `https://api.ensideas.com/ens/resolve/${name}`,
  (name) => `https://api.ensdata.net/${name}`,
];

async function resolveEns(name, timeoutMs = 3000) {
  const one = async (url) => {
    const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`ens http ${r.status}`);
    const b = await r.json();
    const addr = b.address || b.addr;
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('ens no address');
    return addr;
  };
  return Promise.any(ENS_RESOLVERS.map((f) => one(f(name))));
}

const round = (n, p) => Number(n.toFixed(p));
const fromWei = (bi, decimals) => Number(bi) / 10 ** decimals;
const commas = (s) => String(s).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

async function holdersFor(chain, token) {
  const host = BLOCKSCOUT[chain];
  const res = await fetch(`${host}/api/v2/tokens/${token.address}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  });
  if (res.status === 404) throw new Error(`no such token on ${chain}`);
  if (!res.ok) throw new Error(`blockscout http ${res.status}`);
  const d = await res.json();
  const count = d.holders_count ?? d.holders;
  if (count == null) throw new Error('holder count unavailable');
  const n = Number(count);
  const sym = d.symbol || token.symbol || 'token';
  return {
    intent: 'TOKEN_HOLDER_COUNT',
    chain,
    chain_id: CHAINS[chain] ? CHAINS[chain].id : null,
    contract_address: token.address,
    symbol: sym,
    name: d.name ?? null,
    token_type: d.type ?? null,
    holders: n,
    summary: `${sym} on ${chain} (${token.address}) has ${commas(n)} distinct holder addresses.`,
    confidence: 0.95,
    source: `Blockscout ${new URL(host).host} token API`,
    as_of: new Date().toISOString(),
  };
}

async function balanceFor(chain, addr, ens, token) {
  const c = CHAINS[chain];
  if (token) {
    const [rawHex, decHex, symHex] = await Promise.all([
      firstOk(c.rpcs, 'eth_call', [{ to: token.address, data: `0x70a08231000000000000000000000000${addr.slice(2)}` }, 'latest']),
      firstOk(c.rpcs, 'eth_call', [{ to: token.address, data: '0x313ce567' }, 'latest']),
      firstOk(c.rpcs, 'eth_call', [{ to: token.address, data: '0x95d89b41' }, 'latest']).catch(() => null),
    ]);
    const raw = BigInt(rawHex);
    const decimals = decHex ? Number(BigInt(decHex)) : 18;
    const sym = token.symbol || decodeStringReturn(symHex) || 'tokens';
    const human = fromWei(raw, decimals);
    return {
      intent: 'WALLET_BALANCE_CHECK',
      address: addr,
      ens,
      chain,
      chain_id: c.id,
      token: token.address,
      symbol: sym,
      balance: round(human, 6),
      balance_raw: raw.toString(),
      decimals,
      summary: `${ens || addr} holds ${round(human, 4)} ${sym} on ${chain}.`,
      confidence: 0.98,
      source: 'ERC-20 balanceOf over public RPC',
      as_of: new Date().toISOString(),
    };
  }
  const balHex = await firstOk(c.rpcs, 'eth_getBalance', [addr, 'latest']);
  const raw = BigInt(balHex);
  const native = chain === 'polygon' ? 'POL' : chain.includes('sepolia') || chain === 'ethereum' ? 'ETH' : 'ETH';
  const human = fromWei(raw, 18);
  return {
    intent: 'WALLET_BALANCE_CHECK',
    address: addr,
    ens,
    chain,
    chain_id: c.id,
    token: null,
    symbol: native,
    balance: round(human, 6),
    balance_raw: raw.toString(),
    decimals: 18,
    summary: `${ens || addr} holds ${round(human, 4)} ${native} on ${chain}.`,
    confidence: 0.98,
    source: 'eth_getBalance over public RPC',
    as_of: new Date().toISOString(),
  };
}

// Minimal ABI string decode for symbol(), tolerant of the bytes32 variant some tokens use.
function decodeStringReturn(hex) {
  if (!hex || hex === '0x') return null;
  const body = hex.slice(2);
  try {
    if (body.length === 64) {
      const bytes = body.replace(/(00)+$/, '');
      const s = bytes.match(/.{2}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join('');
      return /^[\x20-\x7e]+$/.test(s) ? s : null;
    }
    const len = parseInt(body.slice(64, 128), 16);
    const data = body.slice(128, 128 + len * 2);
    return data.match(/.{2}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join('');
  } catch {
    return null;
  }
}

const json = (body, status = 200, ttl = 0) =>
  new Response(JSON.stringify(body, null, 1), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store',
      'access-control-allow-origin': '*',
    },
  });

const MEMO = new Map();
const MEMO_TTL_MS = 10_000;
const RECENT = [];

function memoKey(kind, a, b) { return `${kind}:${a}:${b}`; }

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const q = url.searchParams;

    if (path === '/__last') return json({ recent: RECENT.slice(-25) });
    if (path === '/health') return json({ ok: true, intents: ['TOKEN_HOLDER_COUNT', 'WALLET_BALANCE_CHECK'] });

    RECENT.push({
      at: new Date().toISOString(), method: request.method, url: request.url,
      ua: request.headers.get('user-agent'),
      via: request.headers.get('x-telegraph-node') || request.headers.get('x-forwarded-for'),
    });
    if (RECENT.length > 50) RECENT.shift();

    if (path === '/') {
      return json({
        service: 'Telegraph on-chain reads miner',
        intents: {
          TOKEN_HOLDER_COUNT: '/holders/{chain}/{token} or /holders?chain=&token=',
          WALLET_BALANCE_CHECK: '/balance/{chain}/{address} or /balance?chain=&address=&token=',
        },
        holder_chains: Object.keys(BLOCKSCOUT),
        balance_chains: Object.keys(CHAINS),
      });
    }

    // TOKEN_HOLDER_COUNT
    if (path === '/holders' || path.startsWith('/holders/')) {
      const seg = path.startsWith('/holders/') ? decodeURIComponent(path.slice(9)).split('/') : [];
      const chainRaw = seg[0] || q.get('chain') || q.get('network') || q.get('query') || 'ethereum';
      const tokenRaw = seg.slice(1).join('/') || q.get('token') || q.get('address') || q.get('contract') || q.get('query');
      const chain = resolveChain(chainRaw, true);
      if (!chain) return json({ error: `holder counts are available for ${Object.keys(BLOCKSCOUT).join(', ')}`, got: chainRaw }, 400);
      const token = resolveToken(tokenRaw, chain)
        || (tokenRaw && TEMPLATE.test(String(tokenRaw).trim()) && MAJORS[chain]?.usdc
            ? { address: MAJORS[chain].usdc, symbol: 'USDC' } : null);
      if (!token) return json({ error: 'name a token by contract address (0x...) or a known symbol', chain, known: Object.keys(MAJORS[chain] || {}) }, 400);
      const key = memoKey('h', chain, token.address);
      const hit = MEMO.get(key);
      if (hit && Date.now() - hit.at < MEMO_TTL_MS) return json(hit.body, 200, 10);
      try {
        const body = await holdersFor(chain, token);
        MEMO.set(key, { at: Date.now(), body });
        return json(body, 200, 10);
      } catch (err) {
        return json({ error: `holder count unavailable for ${token.address} on ${chain}`, detail: String(err).slice(0, 160) }, 502);
      }
    }

    // WALLET_BALANCE_CHECK
    if (path === '/balance' || path.startsWith('/balance/')) {
      const seg = path.startsWith('/balance/') ? decodeURIComponent(path.slice(9)).split('/') : [];
      const explicit = seg[0] || q.get('chain') || q.get('network');
      let chain;
      if (explicit) {
        chain = resolveChain(explicit, false);
        if (!chain) return json({ error: `balance is available for ${Object.keys(CHAINS).join(', ')}`, got: explicit }, 400);
      } else {
        // A whole question names the chain inside itself ("...on arbitrum"); fall back
        // to ethereum only when nothing at all points to a chain.
        chain = resolveChain(q.get('query') || '', false) || 'ethereum';
      }
      const whoRaw = seg.slice(1).join('/') || q.get('address') || q.get('wallet') || q.get('ens') || q.get('query');
      let { address, ens } = extractAddress(whoRaw);
      if (!address && ens) {
        try { address = await resolveEns(ens); }
        catch { return json({ error: `could not resolve ENS name ${ens}`, chain }, 502); }
      }
      // Unfilled path probe ("/balance/{chain}/{address}"): answer for the zero address,
      // a valid 0 balance, rather than 400. Same reasoning as the holders default above.
      if (!address && whoRaw && TEMPLATE.test(String(whoRaw).trim())) address = ZERO_ADDR;
      if (!address) return json({ error: 'name an address (0x...) or an ENS name (name.eth)', chain }, 400);
      const token = resolveToken(q.get('token') || (seg.length > 2 ? seg[2] : null), chain);
      const key = memoKey('b', `${chain}:${address}`, token ? token.address : 'native');
      const hit = MEMO.get(key);
      if (hit && Date.now() - hit.at < MEMO_TTL_MS) return json(hit.body, 200, 10);
      try {
        const body = await balanceFor(chain, address, ens, token);
        MEMO.set(key, { at: Date.now(), body });
        return json(body, 200, 10);
      } catch (err) {
        return json({ error: `balance read failed for ${address} on ${chain}`, detail: String(err).slice(0, 160) }, 502);
      }
    }

    return json({ error: 'not found', usage: '/holders/{chain}/{token} or /balance/{chain}/{address}' }, 404);
  },
};
