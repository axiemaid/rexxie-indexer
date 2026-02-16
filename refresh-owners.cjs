#!/usr/bin/env node
'use strict';

// Refresh ownership for Rexxie NFTs
// Picks up from lastTx instead of re-tracing from mint.
// Most NFTs will need just 1 API call (check if lastTx output is spent).

const https = require('https');
const fs = require('fs');
const path = require('path');

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const agent = new https.Agent({ keepAlive: false });
const LEDGER_PATH = path.join(__dirname, 'ledger.json');

// --- Logging: auto-log every run to logs/ ---
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
const logFile = path.join(LOG_DIR, `refresh-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
const logStream = fs.createWriteStream(logFile, { flags: 'a' });
const _origLog = console.log;
const _origErr = console.error;
const _origWrite = process.stdout.write.bind(process.stdout);
console.log = (...args) => { const line = args.join(' '); _origLog(line); logStream.write(line + '\n'); };
console.error = (...args) => { const line = args.join(' '); _origErr(line); logStream.write('[ERROR] ' + line + '\n'); };
process.stdout.write = (chunk, ...rest) => { logStream.write(chunk); return _origWrite(chunk, ...rest); };

// --- Resilience config ---
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;   // 2s → 4s → 8s
const HTTP_TIMEOUT_MS = 30000;  // 30s timeout
let callDelayMs = 300;          // adaptive: increases on errors, decreases on success
const MIN_DELAY_MS = 200;
const MAX_DELAY_MS = 3000;

let ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
const totalNFTs = Object.keys(ledger.nfts).length;
console.log(`Loaded ledger: ${totalNFTs} NFTs, ${Object.keys(ledger.owners).length} owners`);
console.log(`Log: ${logFile}\n`);

function saveLedger() {
  ledger.collection.lastUpdated = new Date().toISOString();
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Adaptive delay: slow down on errors, speed up on success
function onSuccess() {
  if (callDelayMs > MIN_DELAY_MS) callDelayMs = Math.max(MIN_DELAY_MS, callDelayMs - 50);
}
function onThrottle() {
  callDelayMs = Math.min(MAX_DELAY_MS, callDelayMs * 2);
  console.log(`[throttle] delay increased to ${callDelayMs}ms`);
}

// WoC GET with retries + exponential backoff
async function wocGet(ep, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = https.get(WOC + ep, { headers: { Accept: 'application/json' }, timeout: HTTP_TIMEOUT_MS, agent }, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            if (res.statusCode === 200) {
              onSuccess();
              try { resolve(JSON.parse(d)); } catch { resolve(d); }
            }
            else if (res.statusCode === 404) { onSuccess(); resolve(null); }
            else if (res.statusCode === 429) {
              onThrottle();
              reject(new Error('rate-limited'));
            }
            else reject(new Error(`WoC ${res.statusCode}: ${d.slice(0, 100)}`));
          });
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.on('error', reject);
      });
      return result;
    } catch (e) {
      if (attempt < retries) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(backoff);
      } else {
        throw e;
      }
    }
  }
}

async function getSpender(txid, vout) {
  const result = await wocGet(`/tx/${txid}/${vout}/spent`);
  if (result && result.txid) return result.txid;
  return null;
}

async function getTx(txid) {
  return wocGet(`/tx/hash/${txid}`);
}

// Find the NFT jig vout in a tx (orderlock-first logic)
function findJigVout(tx) {
  for (const vout of tx.vout) {
    if (vout.scriptPubKey?.asm?.includes('OP_RETURN')) continue;
    if (vout.scriptPubKey?.type === 'nonstandard' && vout.value <= 0.001) {
      return { vout: vout.n, addr: null, isOrderLock: true };
    }
  }
  for (const vout of tx.vout) {
    if (vout.scriptPubKey?.asm?.includes('OP_RETURN')) continue;
    const addr = vout.scriptPubKey?.addresses?.[0];
    if (addr && vout.value > 0 && vout.value <= 0.00001) {
      return { vout: vout.n, addr, isOrderLock: false };
    }
  }
  return null;
}

// Resolve the vout of the jig in lastTx (only if not cached)
async function resolveLastVout(nft) {
  if (nft.lastVout !== undefined) return nft.lastVout;
  const tx = await getTx(nft.lastTx);
  await sleep(callDelayMs);
  if (!tx) return null;
  const result = findJigVout(tx);
  if (result) nft.lastVout = result.vout;
  return result ? result.vout : null;
}

// Follow chain forward from a known txid+vout
async function traceForward(startTxid, startVout, currentOwner) {
  let txid = startTxid;
  let vout = startVout;
  let owner = currentOwner;
  let newTransfers = [];
  let hops = 0;

  while (hops < 100) {
    const spendingTxid = await getSpender(txid, vout);
    await sleep(callDelayMs);

    if (!spendingTxid) break;

    hops++;
    const spendTx = await getTx(spendingTxid);
    await sleep(callDelayMs);
    if (!spendTx) break;

    const jig = findJigVout(spendTx);
    if (!jig) break;

    if (!jig.isOrderLock && jig.addr && jig.addr !== owner) {
      newTransfers.push({
        txid: spendingTxid,
        type: 'send',
        from: owner,
        to: jig.addr,
        blockHeight: spendTx.blockheight,
      });
      owner = jig.addr;
    }

    txid = spendingTxid;
    vout = jig.vout;
  }

  return { owner, lastTx: txid, lastVout: vout, newTransfers, hops };
}

function removeFromOwnerIndex(addr, num) {
  if (!ledger.owners[addr]) return;
  ledger.owners[addr] = ledger.owners[addr].filter(n => n !== num);
  if (ledger.owners[addr].length === 0) delete ledger.owners[addr];
}

function addToOwnerIndex(addr, num) {
  if (!ledger.owners[addr]) ledger.owners[addr] = [];
  if (!ledger.owners[addr].includes(num)) ledger.owners[addr].push(num);
}

// Process a single NFT — returns 'unchanged' | 'changed' | 'error'
async function processNFT(num) {
  const nft = ledger.nfts[num];
  if (!nft.lastTx) return 'skip';
  if (nft.burned) return 'unchanged'; // already marked burned, skip

  const lastVout = await resolveLastVout(nft);
  if (lastVout === null) throw new Error('could not resolve vout in lastTx');

  const spendingTxid = await getSpender(nft.lastTx, lastVout);
  await sleep(callDelayMs);

  if (!spendingTxid) return 'unchanged';

  // Output was spent — trace forward
  const spendTx = await getTx(spendingTxid);
  await sleep(callDelayMs);
  if (!spendTx) throw new Error('could not fetch spending tx');

  const jig = findJigVout(spendTx);
  if (!jig) {
    // No jig output = burn (consolidation sweep destroyed the jig)
    // Keep last known owner, mark as burned
    nft.burned = true;
    nft.burnTx = spendingTxid;
    nft.transfers.push({
      txid: spendingTxid,
      type: 'burn',
      from: nft.owner,
      blockHeight: spendTx.blockheight,
    });
    console.log(`#${num}: BURNED in ${spendingTxid.slice(0, 12)}… (owner unchanged: ${nft.owner})`);
    return 'burned';
  }

  const oldOwner = nft.owner;
  let currentOwner = oldOwner;
  let allNewTransfers = [];

  if (!jig.isOrderLock && jig.addr && jig.addr !== currentOwner) {
    allNewTransfers.push({
      txid: spendingTxid,
      type: 'send',
      from: currentOwner,
      to: jig.addr,
      blockHeight: spendTx.blockheight,
    });
    currentOwner = jig.addr;
  }

  const result = await traceForward(spendingTxid, jig.vout, currentOwner);
  allNewTransfers.push(...result.newTransfers);

  nft.transfers.push(...allNewTransfers);
  nft.owner = result.owner;
  nft.lastTx = result.lastTx;
  nft.lastVout = result.lastVout;

  if (oldOwner !== result.owner) {
    removeFromOwnerIndex(oldOwner, num);
    addToOwnerIndex(result.owner, num);
  }

  const totalHops = allNewTransfers.length + result.hops;
  console.log(`#${num}: moved! ${totalHops} hops → ${result.owner}`);
  return 'changed';
}

(async () => {
  const nums = Object.keys(ledger.nfts).map(Number).sort((a, b) => a - b);
  let checked = 0;
  let changed = 0;
  let burned = 0;
  let errors = 0;
  const failedNFTs = []; // retry queue

  console.log(`Checking ${nums.length} NFTs for ownership changes...\n`);

  // --- Main pass ---
  for (const num of nums) {
    checked++;
    try {
      const result = await processNFT(num);
      if (result === 'changed') {
        changed++;
        if (changed % 10 === 0) {
          saveLedger();
          console.log(`[${new Date().toISOString()}] SAVED | ${checked}/${nums.length} checked, ${changed} changed, ${Object.keys(ledger.owners).length} owners`);
        }
      } else if (result === 'burned') {
        burned++;
        if (burned % 10 === 0) saveLedger();
      } else if (checked % 50 === 0) {
        console.log(`[${new Date().toISOString()}] checked ${checked}/${nums.length} | ${changed} changed | ${burned} burned | ${errors} errors | #${num} unchanged`);
      }
    } catch (e) {
      console.error(`#${num} error: ${e.message}`);
      errors++;
      failedNFTs.push(num);
    }
  }

  saveLedger();
  console.log(`\nMain pass done. ${checked} checked, ${changed} changed, ${errors} errors.`);

  // --- Retry pass (up to 2 rounds) ---
  for (let round = 1; round <= 2 && failedNFTs.length > 0; round++) {
    const retryList = [...failedNFTs];
    failedNFTs.length = 0;
    console.log(`\n--- Retry round ${round}: ${retryList.length} NFTs ---`);
    await sleep(5000); // cool down before retries

    for (const num of retryList) {
      try {
        const result = await processNFT(num);
        if (result === 'changed') {
          changed++;
          console.log(`  #${num}: resolved (changed)`);
        } else {
          console.log(`  #${num}: resolved (unchanged)`);
        }
        errors--;
      } catch (e) {
        console.error(`  #${num} retry error: ${e.message}`);
        failedNFTs.push(num);
      }
    }
    saveLedger();
  }

  // --- Final summary ---
  const uniqueOwners = Object.keys(ledger.owners).length;
  console.log(`\n${'='.repeat(60)}`);
  const totalBurned = Object.values(ledger.nfts).filter(n => n.burned).length;
  console.log(`REFRESH COMPLETE`);
  console.log(`  Checked: ${checked}`);
  console.log(`  Changed: ${changed}`);
  console.log(`  Burned (this run): ${burned}`);
  console.log(`  Burned (total): ${totalBurned}`);
  console.log(`  Errors:  ${failedNFTs.length}`);
  console.log(`  Owners:  ${uniqueOwners}`);
  if (failedNFTs.length > 0) {
    console.log(`  UNRESOLVED: ${failedNFTs.join(', ')}`);
  }
  console.log(`${'='.repeat(60)}`);

  saveLedger();
})();
