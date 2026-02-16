#!/usr/bin/env node
'use strict';

// Ownership indexer for Rexxie NFTs
// Uses WoC's /tx/{txid}/{vout}/spent endpoint to follow the UTXO chain

const https = require('https');
const fs = require('fs');
const path = require('path');

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const agent = new https.Agent({ keepAlive: false });
const LEDGER_PATH = path.join(__dirname, 'ledger.json');
const MINTING_ADDR = '12nG9uFESfdyE9SdYHVXQeCGFdfYLcdYZG';
const NFT_VOUT = 3; // NFT jig at vout 3

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
        else if (res.statusCode === 404) resolve(null); // unspent
        else if (res.statusCode === 429) {
          setTimeout(() => wocGet(ep).then(resolve).catch(reject), 5000);
        }
        else reject(new Error(`WoC ${res.statusCode}: ${d.slice(0, 100)}`));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('WoC timeout: ' + ep)); });
    req.on('error', reject);
  });
}

// Check if a specific output is spent, returns spending txid or null
async function getSpender(txid, vout) {
  const result = await wocGet(`/tx/${txid}/${vout}/spent`);
  if (result && result.txid) return result.txid;
  return null; // unspent
}

// Get tx details
async function getTx(txid) {
  return wocGet(`/tx/hash/${txid}`);
}

// Trace a single NFT from mint to current owner
async function traceNFT(num) {
  const nft = ledger.nfts[num];
  if (!nft?.mintTxid) return null;

  let currentTxid = nft.mintTxid;
  let currentVout = NFT_VOUT;
  let currentAddr = MINTING_ADDR;
  let transfers = [{ txid: currentTxid, type: 'mint', to: currentAddr }];
  let hops = 0;

  while (hops < 100) {
    // Check if current output is spent
    const spendingTxid = await getSpender(currentTxid, currentVout);
    await new Promise(r => setTimeout(r, 300));

    if (!spendingTxid) break; // unspent = current holder

    hops++;

    // Get the spending tx to find where the NFT jig moved
    const spendTx = await getTx(spendingTxid);
    await new Promise(r => setTimeout(r, 300));

    if (!spendTx) break;

    // Find the NFT jig in outputs
    // OrderLock = marketplace listing (NFT in escrow). Check Run payload to decide.
    // If send uses $arb, NFT is in OrderLock. Otherwise dust P2PKH.
    let newAddr = null;
    let newVout = null;
    let isOrderLock = false;

    // Check for nonstandard outputs first (OrderLock marketplace listing)
    for (const vout of spendTx.vout) {
      if (vout.scriptPubKey?.asm?.includes('OP_RETURN')) continue;
      if (vout.scriptPubKey?.type === 'nonstandard' && vout.value <= 0.001) {
        newVout = vout.n;
        isOrderLock = true;
        break;
      }
    }

    // If no OrderLock, find dust P2PKH (normal send/transfer)
    if (!isOrderLock) {
      for (const vout of spendTx.vout) {
        if (vout.scriptPubKey?.asm?.includes('OP_RETURN')) continue;
        const addr = vout.scriptPubKey?.addresses?.[0];
        if (addr && vout.value > 0 && vout.value <= 0.00001) {
          newAddr = addr;
          newVout = vout.n;
          break;
        }
      }
    }

    if (newVout === null) break;

    if (!isOrderLock && newAddr && newAddr !== currentAddr) {
      transfers.push({
        txid: spendingTxid,
        type: 'send',
        from: currentAddr,
        to: newAddr,
        blockHeight: spendTx.blockheight,
      });
      currentAddr = newAddr;
    }
    // OrderLock: don't update currentAddr — the NFT is in escrow

    currentVout = newVout;
    currentTxid = spendingTxid;
  }

  return { owner: currentAddr, transfers, hops };
}

// Main
(async () => {
  const startNum = parseInt(process.argv[2]) || 1;
  const batchSize = parseInt(process.argv[3]) || 2222;

  const nums = Object.keys(ledger.nfts)
    .map(Number)
    .filter(n => n >= startNum && !ledger.nfts[n].owner)
    .sort((a, b) => a - b)
    .slice(0, batchSize);

  console.log(`${nums.length} NFTs to index\n`);

  let indexed = 0;
  for (const num of nums) {
    try {
      process.stdout.write(`Tracing #${num}... `);
      const result = await traceNFT(num);
      if (result) {
        const nft = ledger.nfts[num];
        nft.owner = result.owner;
        nft.lastTx = result.transfers[result.transfers.length - 1]?.txid;
        nft.transfers = result.transfers;

        if (!ledger.owners[result.owner]) ledger.owners[result.owner] = [];
        if (!ledger.owners[result.owner].includes(num)) ledger.owners[result.owner].push(num);

        indexed++;

        const isTransferred = result.owner !== MINTING_ADDR;
        if (isTransferred) {
          console.log(`${result.hops} hops → ${result.owner}`);
        } else {
          console.log(`still at minting addr (${result.hops} hops)`);
        }

        if (indexed % 10 === 0) {
          ledger.ownershipIndexed = Object.values(ledger.nfts).filter(n => n.owner).length;
          saveLedger();
          const uniqueOwners = new Set(Object.values(ledger.nfts).map(n => n.owner).filter(Boolean)).size;
          console.log(`--- Saved. ${indexed}/${nums.length} done, ${uniqueOwners} unique owners ---`);
        }
      }
    } catch (e) {
      console.error(`#${num} error: ${e.message}`);
      // Retry once on timeout
      if (e.message.includes('timeout')) {
        try {
          console.log(`#${num}: retrying...`);
          await new Promise(r => setTimeout(r, 2000));
          const result = await traceNFT(num);
          if (result) {
            const nft = ledger.nfts[num];
            nft.owner = result.owner;
            nft.lastTx = result.transfers[result.transfers.length - 1]?.txid;
            nft.transfers = result.transfers;
            if (!ledger.owners[result.owner]) ledger.owners[result.owner] = [];
            if (!ledger.owners[result.owner].includes(num)) ledger.owners[result.owner].push(num);
            indexed++;
            if (result.owner !== MINTING_ADDR) console.log(`#${num}: ${result.transfers.length - 1} sends → ${result.owner}`);
          }
        } catch (e2) { console.error(`#${num} retry failed: ${e2.message}`); }
      }
    }
  }

  ledger.ownershipIndexed = Object.values(ledger.nfts).filter(n => n.owner).length;
  saveLedger();
  const uniqueOwners = new Set(Object.values(ledger.nfts).map(n => n.owner).filter(Boolean)).size;
  console.log(`\nDone. ${indexed} indexed. ${uniqueOwners} unique owners.`);
})();
