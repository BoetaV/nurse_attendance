#!/usr/bin/env node
/**
 * Builds the GitHub Pages front end (dist/index.html) from the Apps Script HTML files.
 * The page talks to the Apps Script web app through doPost(), at API_URL.
 *
 *   API_URL=https://script.google.com/macros/s/XXXX/exec node tools/build-pages.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'apps_script');
const out = path.join(root, 'dist');
const api = (process.env.API_URL || '').trim();

if (api && !/^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/.test(api)) {
  console.error('API_URL must be the web app URL ending in /exec, e.g. https://script.google.com/macros/s/AKfy.../exec');
  process.exit(1);
}
if (!api) console.log('::warning::Repository variable API_URL is not set – the page will load but cannot sign in.');

let html = fs.readFileSync(path.join(src, 'Index.html'), 'utf8');
html = html.replace(/<\?!=\s*include\('(\w+)'\);\s*\?>/g, (m, name) => {
  let part = fs.readFileSync(path.join(src, name + '.html'), 'utf8');
  if (name === 'App') part = `<script>window.API_URL = ${JSON.stringify(api)};</script>\n` + part;
  return part;
});
if (/<\?/.test(html)) throw new Error('Unresolved Apps Script scriptlet left in Index.html');

// Apps Script adds these via HtmlOutput; a static page needs them in the markup.
html = html.replace('<meta charset="UTF-8">',
  '<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<meta name="referrer" content="no-referrer">\n' +
  '<title>Weekly Nursing Attendance &amp; Absenteeism Register – ECDoH</title>');

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log('Built dist/index.html (' + Math.round(html.length / 1024) + ' KB), API_URL ' + (api ? 'set' : 'NOT set'));
