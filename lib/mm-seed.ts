// Written by scripts/mm-discover.ts: market-maker-like accounts on Hyperliquid.
export const MM_SEED: { found: string; makers: { addr: string; name: string | null; maker: number; vol14: number; quoted: number; acct: number }[] } = {
  "found": "2026-11-07",
  "makers": [
    {
      "addr": "0x399965e15d4e61ec3529cc98b7f7ebb93b733336",
      "name": null,
      "maker": 0.839,
      "vol14": 9202820172,
      "quoted": 11,
      "acct": 27410478
    },
    {
      "addr": "0x7b7f72a28fe109fa703eeed7984f2a8a68fedee2",
      "name": null,
      "maker": 0.845,
      "vol14": 2545693532,
      "quoted": 9,
      "acct": 7577332
    },
    {
      "addr": "0xc179e03922afe8fa9533d3f896338b9fb87ce0c8",
      "name": null,
      "maker": 0.975,
      "vol14": 1306912810,
      "quoted": 20,
      "acct": 7083139
    },
    {
      "addr": "0x023a3d058020fb76cca98f01b3c48c8938a22355",
      "name": "Auros",
      "maker": 0.899,
      "vol14": 804436278,
      "quoted": 39,
      "acct": 17418006
    },
    {
      "addr": "0x7717a7a245d9f950e586822b8c9b46863ed7bd7e",
      "name": null,
      "maker": 0.826,
      "vol14": 620479205,
      "quoted": 165,
      "acct": 8128061
    }
  ]
};
