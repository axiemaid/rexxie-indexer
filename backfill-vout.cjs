#!/usr/bin/env node
'use strict';

// One-time backfill: resolve and store lastVout for every NFT in ledger.json

const https = require('https');
const fs = require('fs');
const path = require('path');

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const agent = new https.Agent({ keepAlive: false });
const LEDGER_PATH = path.join(__dirname, 'ledger.json');

let ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
console.log(`Loaded ledger: ${Object.keys(ledger.nfts).length} NFTs`);

function saveLedger() {
  ledger.collection.lastUpdated = new Date().toISOString();
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function wocGet(ep) {
  return new Promise((resolve, reject) => {
    const req = https.get(WOC + ep, { headers: { Accept: 'application/json' }, timeout: 15000, agent }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) try { resolve(JSON.parse(d)); } catch { resolve(d); }
        else if (res.statusCode === 404) resolve(null);
        else if (res.statusCode === 429) {
          setTimeout(() => wocGet(ep).then(resolve).catch(reject), 5000);
        }
        else reject(new Error(`WoC ${res.statusCode}: ${d.slice(0,100)}`));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('WoC timeout: ' + ep)); });
    req.on('error', reject);
  });
}

function findJigVout(tx) {
  for (const vout of tx.vout) {
    if (vout.scriptPubKey?.asm?.includes('OP_RETURN')) continue;
    if (vout.scriptPubKey?.type === 'nonstandard' && vout.value <= 0.001) {
      return vout.n;
    }
  }
  for (const vout of tx.vout) {
    if (vout.scriptPubKey?.asm?.includes('OP_RETURN')) continue;
    const addr = vout.scriptPubKey?.addresses?.[0];
    if (addr && vout.value > 0 && vout.value <= 0.00001) {
      return vout.n;
    }
  }
  return null;
}

(async () => {
  const nums = Object.keys(ledger.nfts).map(Number).sort((a, b) => a - b);
  const need = nums.filter(n => ledger.nfts[n].lastTx && ledger.nfts[n].lastVout === undefined);
  console.log(`${need.length} NFTs need lastVout backfill\n`);

  let done = 0;
  for (const num of need) {
    const nft = ledger.nfts[num];
    try {
      const tx = await wocGet(`/tx/hash/${nft.lastTx}`);
      await new Promise(r => setTimeout(r, 300));
      if (!tx) { console.log(`#${num}: tx not found`); continue; }
      const vout = findJigVout(tx);
      if (vout === null) { console.log(`#${num}: jig vout not found`); continue; }
      nft.lastVout = vout;
      done++;
      if (done % 50 === 0) {
        saveLedger();
        console.log(`--- Saved. ${done}/${need.length} ---`);
      }
    } catch (e) {
      console.error(`#${num} error: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  saveLedger();
  console.log(`\nDone. ${done} backfilled.`);
})();
