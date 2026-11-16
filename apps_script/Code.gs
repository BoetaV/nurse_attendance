/**
 * Entry points: web app, API dispatcher, setup and spreadsheet menu.
 */

function doGet() {
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Weekly Nursing Attendance & Absenteeism Register – ECDoH')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ---------------------------------------------------------------- API

const ACTIONS = {
  bootstrap: apiBootstrap_,
  changePassword: apiChangePassword_,
  listRegisters: apiListRegisters_,
  openRegister: apiOpenRegister_,
  getRegister: apiGetRegister_,
  saveRegister: apiSaveRegister_,
  signRegister: apiSignRegister_,
  returnRegister: apiReturnRegister_,
  reopenRegister: apiReopenRegister_,
  registerPdf: apiRegisterPdf_,
  registerSheet: apiRegisterSheet_,
  monthlyRollup: apiMonthlyRollup_,
  monthlySheet: apiMonthlySheet_,
  listUsers: apiListUsers_,
  saveUser: apiSaveUser_,
  resetPassword: apiResetPassword_,
  listUnits: apiListUnits_,
  saveUnit: apiSaveUnit_,
  importUnits: apiImportUnits_,
};

/**
 * JSON endpoint for the GitHub Pages front end (same functions as google.script.run).
 * Body is sent as text/plain to avoid a CORS pre-flight: {"fn":"login|logout|api","args":[...]}
 */
function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e && e.postData ? e.postData.contents : '{}');
    const a = Array.isArray(req.args) ? req.args : [];
    if (req.fn === 'login') out = login(a[0], a[1]);
    else if (req.fn === 'logout') out = logout(a[0]);
    else if (req.fn === 'api') out = api(a[0], a[1], a[2]);
    else out = { ok: false, code: 'ERROR', error: 'Unknown function.' };
  } catch (err) {
    out = { ok: false, code: 'ERROR', error: 'Bad request.' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Single endpoint used by the web page: google.script.run.api(token, action, payload). */
function api(token, action, payload) {
  try {
    const user = requireSession_(token);
    const fn = ACTIONS[action];
    if (!fn) throw appError_('Unknown action: ' + action);
    if (user.MustChange && action !== 'changePassword' && action !== 'bootstrap') {
      throw appError_('Please change your temporary password first.', 'MUST_CHANGE');
    }
    return { ok: true, data: fn(user, payload || {}) };
  } catch (e) {
    return errOut_(e);
  }
}

function errOut_(e) {
  const known = !!e.code;
  if (!known) console.error(e && e.stack ? e.stack : e);
  return { ok: false, code: e.code || 'ERROR', error: known ? e.message : 'Unexpected error: ' + (e && e.message ? e.message : e) };
}

function apiBootstrap_(user) {
  const units = unitsInScope_(user);
  return {
    user: publicUser_(user),
    units: units,
    facilities: Array.from(new Set(units.map(u => u.facility))),
    config: {
      hospitals: HOSPITALS, categories: CATEGORIES, shifts: SHIFTS, days: DAYS, reasons: REASONS, roles: ROLES,
      status: STATUS, rules: RULES, app: APP,
    },
    today: Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd'),
  };
}

// ---------------------------------------------------------------- setup
// Every public function can also be reached through google.script.run from the
// web page, so setup / reset are guarded: only the owner (in the Sheet or the
// script editor) may run them. Anonymous web-app visitors have no active user.

function ownerOnly_() {
  const active = Session.getActiveUser().getEmail();
  const effective = Session.getEffectiveUser().getEmail();
  if (!active || active !== effective) {
    throw new Error('Only the spreadsheet owner can run this, from the spreadsheet menu or the script editor.');
  }
}

/**
 * Creates / repairs all database sheets and the first administrator.
 * Run once from the spreadsheet menu (Absenteeism > Set up / repair sheets)
 * or from the script editor. Returns a message with the temporary password.
 */
function setup(facilityName) {
  ownerOnly_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open the script from the Google Sheet (Extensions > Apps Script) so it is bound to it.');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  Object.keys(SCHEMA).forEach(name => ensureSheet_(ss, name));
  const sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sheet1);

  let msg = 'Sheets are ready.';
  const admins = readAll_('Users').filter(u => u.Role === 'ADMIN' && u.Active);
  if (!admins.length) {
    const temp = tempPassword_(), salt = newSalt_();
    if (findUser_('admin')) throw new Error('A user called "admin" exists but is not an active administrator. Use "Reset admin password".');
    appendObj_('Users', {
      Username: 'admin', FullName: 'System Administrator', Email: '', Role: 'ADMIN', Facility: '*', Units: '*',
      PasswordHash: hashPassword_(temp, salt), Salt: salt, Active: true, MustChange: true,
      CreatedAt: now_(), LastLogin: '',
    });
    audit_('setup', 'USER_CREATED', '', 'admin');
    msg += '\n\nAdministrator created.\nUsername: admin\nTemporary password: ' + temp +
           '\n\nYou will be asked to change it at first login.';
  }
  if (!readAll_('Units').length) {
    // SEED_UNITS rows are [Hospital, Area, Unit]; a blank hospital uses the name typed at setup.
    const fallback = String(facilityName || '').trim();
    const seed = (typeof SEED_UNITS !== 'undefined' ? SEED_UNITS : [])
      .map(r => ({ facility: String(r[0] || fallback).trim(), area: r[1], unit: r[2] })).filter(r => r.facility);
    if (seed.length) {
      Array.from(new Set(seed.map(r => r.facility))).forEach(fac => {
        const rows = seed.filter(r => r.facility === fac);
        const res = upsertUnits_(fac, rows.map(r => ({ area: r.area, unit: r.unit, active: true })));
        audit_('setup', 'UNITS_IMPORTED', '', fac + ': ' + res.added + ' added');
        msg += '\n\n' + res.added + ' reporting units loaded for "' + fac + '" (areas: ' +
               Array.from(new Set(rows.map(r => r.area))).join(', ') + ').';
      });
    } else {
      msg += '\n\nNext: sign in to the web app as admin and add or import units under "Users & units".';
    }
  }
  console.log(msg);
  return msg;
}

/** Emergency: reset the "admin" user's password and restore its admin role. */
function resetAdminPassword() {
  ownerOnly_();
  const u = findUser_('admin');
  if (!u) return setup();
  const temp = tempPassword_();
  u.Salt = newSalt_();
  u.PasswordHash = hashPassword_(temp, u.Salt);
  u.MustChange = true;
  u.Active = true;
  u.Role = 'ADMIN';
  updateObj_('Users', u);
  CacheService.getScriptCache().remove('lf_admin');
  audit_('owner', 'PASSWORD_RESET', '', 'admin');
  const msg = 'Username: admin\nTemporary password: ' + temp;
  console.log(msg);
  return msg;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Absenteeism')
    .addItem('Set up / repair sheets', 'menuSetup')
    .addItem('Reset "admin" password', 'menuResetAdmin')
    .addItem('Show web app link', 'menuLink')
    .addToUi();
}

function menuSetup() {
  const ui = SpreadsheetApp.getUi();
  let facility = '';
  const units = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Units');
  const seedHasHospital = SEED_UNITS.length && SEED_UNITS.every(r => r[0]);
  if ((!units || units.getLastRow() < 2) && !seedHasHospital) {
    const r = ui.prompt('Setup', 'Hospital / facility name for the ' + SEED_UNITS.length +
      ' reporting units (OPD, Theatre, Ward). Leave blank to add units later.', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) return;
    facility = r.getResponseText();
  }
  ui.alert('Setup', setup(facility), ui.ButtonSet.OK);
}
function menuResetAdmin() { const ui = SpreadsheetApp.getUi(); ui.alert('Admin password', resetAdminPassword(), ui.ButtonSet.OK); }
function menuLink() {
  const ui = SpreadsheetApp.getUi();
  const url = ScriptApp.getService().getUrl();
  ui.alert('Web app', url ? url : 'Not deployed yet: Deploy > New deployment > Web app.', ui.ButtonSet.OK);
}
