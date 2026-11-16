#!/usr/bin/env node
/**
 * CI helper: writes ~/.clasprc.json for clasp 2.4.2 from the CLASPRC_JSON secret.
 * Accepts the file from either clasp 2.x ({"token":…,"oauth2ClientSettings":…})
 * or clasp 3.x ({"tokens":{"default":{client_id, client_secret, refresh_token…}}}).
 * Never prints secret values – only what is missing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const fail = msg => { console.log('::error::' + msg); process.exit(1); };
const raw = (process.env.CLASPRC_JSON || '').trim();
if (!raw) fail('CLASPRC_JSON secret is empty.');

let j;
try { j = JSON.parse(raw); } catch (e) {
  fail('CLASPRC_JSON is not valid JSON. Copy the WHOLE file (it starts with { and ends with }), e.g. ' +
       'PowerShell: Get-Content "$env:USERPROFILE\\.clasprc.json" -Raw | Set-Clipboard');
}

let out;
if (j.token && j.oauth2ClientSettings) {                     // clasp 2.x
  if (!j.token.refresh_token) fail('CLASPRC_JSON (clasp 2 format) has no refresh_token – run "clasp login" again and re-copy.');
  out = j;
  console.log('Credentials: clasp 2.x format.');
} else if (j.tokens && (j.tokens.default || Object.values(j.tokens)[0])) { // clasp 3.x
  const t = j.tokens.default || Object.values(j.tokens)[0];
  const missing = ['client_id', 'client_secret', 'refresh_token'].filter(k => !t[k]);
  if (missing.length) fail('CLASPRC_JSON (clasp 3 format) is missing: ' + missing.join(', ') + '. Run "clasp login" again and re-copy.');
  out = {
    token: { access_token: t.access_token || '', refresh_token: t.refresh_token, token_type: 'Bearer', expiry_date: 1 },
    oauth2ClientSettings: { clientId: t.client_id, clientSecret: t.client_secret, redirectUri: 'http://localhost' },
    isLocalCreds: false,
  };
  console.log('Credentials: clasp 3.x format – converted for clasp 2.4.2.');
} else {
  fail('CLASPRC_JSON does not look like a .clasprc.json file (no "token" or "tokens" key). ' +
       'Make sure you pasted the contents of .clasprc.json from your user folder, not .clasp.json.');
}

const sid = (process.env.SCRIPT_ID || '').trim();
if (!/^[\w-]{20,}$/.test(sid)) fail('SCRIPT_ID does not look right. Copy it from Apps Script > Project Settings > IDs > Script ID (not the Sheet ID, not the deployment ID).');

fs.writeFileSync(path.join(os.homedir(), '.clasprc.json'), JSON.stringify(out));
fs.writeFileSync('.clasp.json', JSON.stringify({ scriptId: sid, rootDir: 'apps_script' }));
console.log('Wrote ~/.clasprc.json and .clasp.json (script ' + sid.slice(0, 6) + '…).');
