#!/usr/bin/env node
'use strict';

// Standalone discovery script: finds all Rexxie mint txids and saves them
const https = require('https');
const fs = require('fs');
const path = require('path');

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const MINTING_ADDR = '12nG9uFESfdyE9SdYHVXQeCGFdfYLcdYZG';
const COL_DEPLOY_BLOCK = 771246;
const OUTPUT_FILE = path.join(__dirname, 'rexxie-mints.json');

function wocGet(ep) {
  return new Promise((resolve, reject) => {
    https.get(WOC + ep, { headers: { Accept: 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) try { resolve(JSON.parse(d)); } catch { resolve(d); }
        else if (res.statusCode === 429) setTimeout(() => wocGet(ep).then(resolve).catch(reject), 3000);
        else reject(new Error(`WoC ${res.statusCode}: ${d.slice(0, 100)}`));
      });
    }).on('error', reject);
  });
}

function decodeRunPayload(tx) {
  for (const vout of (tx.vout || [])) {
    const asm = vout.scriptPubKey?.asm || '';
    if (!asm.includes('OP_RETURN')) continue;
    try {
      const parts = asm.split(' ');
      const ri = parts.indexOf('OP_RETURN');
      if (ri < 0) continue;
      const dp = parts.slice(ri + 1).filter(p => !p.startsWith('OP_'));
      if (dp[0] !== '7239026' && dp[0] !== '72756e') continue;
      for (let i = 2; i < dp.length; i++) {
        try {
          const txt = Buffer.from(dp[i], 'hex').toString('utf8');
          if (txt.startsWith('{')) return JSON.parse(txt);
        } catch {}
      }
    } catch {}
  }
  return null;
}

(async () => {
  console.log('Fetching address history...');
  const history = await wocGet(`/address/${MINTING_ADDR}/history`);
  history.sort((a, b) => (a.height || 0) - (b.height || 0));
  
  const candidates = history.filter(h => h.height >= COL_DEPLOY_BLOCK);
  console.log(`${candidates.length} txs after COL deploy (block ${COL_DEPLOY_BLOCK})`);

  const mints = [];
  let scanned = 0;

  for (const h of candidates) {
    scanned++;
    try {
      const tx = await wocGet(`/tx/hash/${h.tx_hash}`);
      const payload = decodeRunPayload(tx);
      if (!payload) { await new Promise(r => setTimeout(r, 200)); continue; }

      const exec = payload.exec || [];
      const isMint = exec.some(e => e?.op === 'CALL' && e?.data?.[1] === 'mint');
      if (isMint && payload.in === 1) {
        mints.push({
          txid: h.tx_hash,
          block: h.height,
        });
        if (mints.length % 100 === 0) {
          console.log(`  ${mints.length} mints found (scanned ${scanned}/${candidates.length})`);
          // Save progress
          fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ total: mints.length, mints }, null, 2));
        }
      }
      await new Promise(r => setTimeout(r, 250));
    } catch (e) {
      console.error(`  Error at ${h.tx_hash.slice(0, 12)}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ total: mints.length, mints }, null, 2));
  console.log(`\nDone. ${mints.length} mints found. Saved to ${OUTPUT_FILE}`);
})();
