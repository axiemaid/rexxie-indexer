#!/usr/bin/env node
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const COLLECTION = JSON.parse(fs.readFileSync(path.join(__dirname, 'rexxie-collection.json'), 'utf8'));
const IMG_DIR = path.join(__dirname, 'images');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', e => {
      file.close();
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      reject(e);
    });
  });
}

(async () => {
  let downloaded = 0;
  let skipped = 0;
  let errors = 0;

  for (const nft of COLLECTION) {
    const num = parseInt(nft.number);
    const dest = path.join(IMG_DIR, `${num}.png`);

    if (fs.existsSync(dest)) {
      skipped++;
      continue;
    }

    try {
      await download(nft.img, dest);
      downloaded++;
      if (downloaded % 100 === 0) {
        console.log(`Downloaded ${downloaded} (skipped ${skipped}, errors ${errors})`);
      }
      // ~150ms delay to be polite
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      errors++;
      console.error(`#${num} failed: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`\nDone. ${downloaded} downloaded, ${skipped} skipped, ${errors} errors.`);
})();
