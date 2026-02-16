#!/usr/bin/env node
'use strict';

// Scheduled ownership refresh: backs up ledger, then runs refresh
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = __dirname;
const LEDGER = path.join(BASE, 'ledger.json');
const BACKUP_DIR = path.join(BASE, 'ledger-backups');

// Ensure backup dir exists
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);

// Backup current ledger with timestamp
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(BACKUP_DIR, `ledger-${ts}.json`);
fs.copyFileSync(LEDGER, backupPath);
console.log(`Backed up ledger to ${backupPath}`);

// Clean old backups (keep last 30)
const backups = fs.readdirSync(BACKUP_DIR)
  .filter(f => f.startsWith('ledger-') && f.endsWith('.json'))
  .sort()
  .reverse();

if (backups.length > 30) {
  backups.slice(30).forEach(f => {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`Removed old backup: ${f}`);
  });
}

// Run refresh
console.log('\nStarting ownership refresh...\n');
try {
  execSync(`node ${path.join(BASE, 'refresh-owners.cjs')}`, { stdio: 'inherit', timeout: 3600000 });
} catch (e) {
  console.error('Refresh failed:', e.message);
  process.exit(1);
}
