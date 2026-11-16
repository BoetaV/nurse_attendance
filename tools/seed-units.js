#!/usr/bin/env node
/**
 * Regenerates apps_script/SeedUnits.gs from reporting_units.csv.
 * Columns (header row required, ";" or ","): Hospital;Area;Unit Name
 * (Hospital is optional – without it setup asks for the hospital name).
 * The seed list is loaded by "Set up / repair sheets" when the Units sheet is empty.
 * Later changes are best imported in the app: Users & units > Import CSV.
 *
 *   node tools/seed-units.js [path/to/reporting_units.csv]
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const csvPath = process.argv[2] || path.join(root, 'reporting_units.csv');
const lines = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
const sep = lines[0].includes(';') ? ';' : ',';
const head = lines[0].split(sep).map(h => h.trim().toLowerCase());
const hi = head.findIndex(h => h === 'hospital' || h === 'facility');
const ai = head.indexOf('area'), ui = head.findIndex(h => h.startsWith('unit'));
if (ai < 0 || ui < 0) { console.error('Header must contain "Area" and "Unit Name" (and optionally "Hospital").'); process.exit(1); }

const seen = new Set();
const rows = lines.slice(1).map(l => l.split(sep).map(c => c.trim().replace(/^"|"$/g, '')))
  .map(c => [hi >= 0 ? c[hi] : '', c[ai], c[ui]]).filter(([h, a, u]) => a && u && (hi < 0 || h))
  .filter(([h, , u]) => { const k = (h + '|' + u).toLowerCase(); if (seen.has(k)) { console.warn('Duplicate unit skipped: ' + h + ' / ' + u); return false; } seen.add(k); return true; });

const body = rows.map(r => '  ' + JSON.stringify(r)).join(',\n');
fs.writeFileSync(path.join(root, 'apps_script', 'SeedUnits.gs'),
  '/**\n * Reporting units loaded by setup() when the Units sheet is empty: [Hospital, Area, Unit].\n' +
  ' * Source: reporting_units.csv (Hospital;Area;Unit Name). Regenerate with: node tools/seed-units.js\n */\n' +
  'const SEED_UNITS = [\n' + body + '\n];\n');
const hosp = [...new Set(rows.map(r => r[0]).filter(Boolean))];
console.log('Wrote apps_script/SeedUnits.gs: ' + rows.length + ' units in ' + new Set(rows.map(r => r[1])).size +
  ' areas, hospital(s): ' + (hosp.join(', ') || '(none – asked at setup)'));
