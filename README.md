# ChainWire: on-chain reads for Telegraph

Two Telegraph canonical intents that had no miner at all, served by one Cloudflare
Worker with no API key and no database. Every figure is read live at request time from
public sources, so nothing can silently go stale.

- **TOKEN_HOLDER_COUNT** — how many distinct addresses hold a token, from the public
  Blockscout API. Ethereum, Base, Arbitrum, Polygon.
- **WALLET_BALANCE_CHECK** — the native-coin balance of an address or ENS name, from
  `eth_getBalance` over public RPCs. Ethereum, Base, Arbitrum, Optimism, Polygon and the
  Base Sepolia and Sepolia testnets. ENS names resolve on mainnet.

Live: <https://telegraph-chain.margyn.workers.dev>

```bash
curl -s https://telegraph-chain.margyn.workers.dev/holders/base/usdc
curl -s https://telegraph-chain.margyn.workers.dev/balance/ethereum/vitalik.eth
curl -s "https://telegraph-chain.margyn.workers.dev/balance/arbitrum/vitalik.eth"
curl -s "https://telegraph-chain.margyn.workers.dev/holders?chain=ethereum&token=0xdAC17F958D2ee523a2206206994597C13D831ec7"
```

## Why these two intents

Both were canonical on the network with zero miners, so an agent asking either question
got nothing back. Filling an unserved intent is rank 1 for that intent by default, which
is the honest way to earn routed demand rather than fighting ten wrappers for a crowded
one. Both are on-chain reads, which the program calls its highest-value area, and both
return a single figure a validator can score against ground truth.

## How it answers

Same shape as the sibling GasWire miner, built on the lessons that miner learned the hard
way against the live node:

- **Providers are raced, not tried in turn.** A validator spot check has a deadline, so
  one slow public RPC must not spend it. `Promise.any` across two endpoints per chain.
- **A ten second per-isolate memo.** A hot answer costs milliseconds, and staleness is
  bounded at the same ten seconds the response advertises.
- **An unfilled path template answers rather than errors.** The node probes declared
  paths with the template left in (`/holders/{chain}/{token}`), and a 400 on that probe
  reads as "miner did not respond" and freezes the miner out of routing for a whole
  epoch. So `{token}` resolves to USDC and `{address}` to the zero address, each a valid
  200, while a genuinely unknown input still 400s.
- **A whole question resolves, not just a bare parameter.** "how many holders does USDC
  have on polygon" and "what is in vitalik.eth on arbitrum" both parse.
- **`/__last`** is a per-isolate ring buffer of recent requests, which is how the node's
  real call shape gets observed rather than guessed.

## Endpoints

| Path | Intent | Example |
| --- | --- | --- |
| `/holders/{chain}/{token}` | TOKEN_HOLDER_COUNT | `/holders/base/usdc` |
| `/holders?chain=&token=` | TOKEN_HOLDER_COUNT | `?chain=ethereum&token=0xdAC1…` |
| `/balance/{chain}/{address}` | WALLET_BALANCE_CHECK | `/balance/ethereum/vitalik.eth` |
| `/balance?chain=&address=` | WALLET_BALANCE_CHECK | `?chain=base&address=0x…` |
| `/health`, `/`, `/__last` | diagnostics | |

Token is a `0x` contract address or a known symbol (USDC, USDT, DAI, WETH). Address is a
`0x` account or an ENS name ending in `.eth`. Holder counts are limited to the chains
with a public Blockscout instance, so a chain we cannot back honestly returns an error
rather than a guess.

## On-chain

Registered on Base Sepolia against the Telegraph registry
`0x5a2324aA18613FAD4e44bDF0d6c73Ec1f6D87ff8` from
`0x8b224783FE5b3c52B7DB0cb9B1754f8812b75287`:

- TOKEN_HOLDER_COUNT, miner id 105, descriptor `chainwire-holder-count.yaml`
- WALLET_BALANCE_CHECK, miner id 106, descriptor `chainwire-wallet-balance.yaml`

## Layout

- `worker.js` — the whole miner, one Cloudflare Worker module.
- `chainwire-holder-count.yaml`, `chainwire-wallet-balance.yaml` — the two descriptors.

Written for Telegraph Hackathon Season I, Track 1, by
[zkasuran](https://github.com/zkasuran) with AI assistance (Claude, Anthropic). Every
figure in this README came out of the live endpoint.

## Licence

MIT.
