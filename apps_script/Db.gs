/**
 * Sheet-as-database helpers, date/week helpers and small utilities.
 */

// ---------------------------------------------------------------- errors

function appError_(message, code) {
  const e = new Error(message);
  e.code = code || 'APP';
  return e;
}

// ---------------------------------------------------------------- spreadsheet access

function db_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw appError_('The database spreadsheet is not set up. Run "Set up / repair sheets" from the spreadsheet menu.');
  return ss;
}

function sheet_(name) {
  const sh = db_().getSheetByName(name);
  if (!sh) throw appError_('Sheet "' + name + '" is missing. Run "Set up / repair sheets".');
  return sh;
}

function tz_() {
  return Session.getScriptTimeZone() || 'Africa/Johannesburg';
}

function now_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm');
}

/** Create the sheet if missing and make sure the header row matches SCHEMA. */
function ensureSheet_(ss, name) {
  const headers = SCHEMA[name];
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  const current = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  if (current.join('|') !== headers.join('|')) {
    // Allowed: empty sheet, or an older version whose columns are a prefix of the new ones.
    const isPrefix = current.every((h, i) => h === headers[i]);
    if (sh.getLastRow() > 1 && !isPrefix) {
      throw appError_('Sheet "' + name + '" has unexpected columns – fix it by hand before running setup.');
    }
    if (sh.getMaxColumns() < headers.length) sh.insertColumnsAfter(sh.getMaxColumns(), headers.length - sh.getMaxColumns());
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sh.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold').setBackground('#0B6B3A').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  headers.forEach((h, i) => {
    if (TEXT_COLS.indexOf(h) >= 0) sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  });
  return sh;
}

/** Normalise a raw cell value for a given column. */
function norm_(h, v) {
  if (v instanceof Date) {
    if (DATETIME_COLS.indexOf(h) >= 0) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd HH:mm');
    if (h === 'Month') return Utilities.formatDate(v, tz_(), 'yyyy-MM');
    return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  }
  if (NUM_COLS.indexOf(h) >= 0) {
    if (v === '' || v === null) return h === 'Plan' || h === 'Actual' ? '' : 0;
    const n = Number(v);
    return isNaN(n) ? 0 : n;
  }
  if (h === 'Active' || h === 'MustChange') return v === true || String(v).toUpperCase() === 'TRUE';
  return v === null || v === undefined ? '' : String(v);
}

/** Read a whole table as objects. Each object carries _row (1-based sheet row). */
function readAll_(name) {
  const sh = sheet_(name), headers = SCHEMA[name], last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  const out = [];
  values.forEach((r, i) => {
    if (r.every(c => c === '' || c === null)) return;
    const o = { _row: i + 2 };
    headers.forEach((h, j) => o[h] = norm_(h, r[j]));
    out.push(o);
  });
  return out;
}

/** Stop user text such as "=HYPERLINK(...)" being stored as a formula. */
function safeText_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

function toRow_(name, obj) {
  return SCHEMA[name].map(h => {
    const v = obj[h];
    if (v === undefined || v === null) return '';
    return safeText_(v);
  });
}

/** Write a 2D block, forcing text columns to plain text first. */
function writeRows_(sh, startRow, rows, headers) {
  if (!rows.length) return;
  const need = startRow + rows.length - 1;
  if (need > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
  headers.forEach((h, i) => {
    if (TEXT_COLS.indexOf(h) >= 0) sh.getRange(startRow, i + 1, rows.length, 1).setNumberFormat('@');
  });
  sh.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
}

function appendObj_(name, obj) {
  const sh = sheet_(name);
  writeRows_(sh, sh.getLastRow() + 1, [toRow_(name, obj)], SCHEMA[name]);
}

function updateObj_(name, obj) {
  if (!obj._row) throw appError_('Internal: row number missing for update.');
  writeRows_(sheet_(name), obj._row, [toRow_(name, obj)], SCHEMA[name]);
}

/** Replace every row where `key` == `value` with `newObjs` (used for the flat reporting sheets). */
function replaceFor_(name, key, value, newObjs) {
  const sh = sheet_(name), headers = SCHEMA[name], ki = headers.indexOf(key), last = sh.getLastRow();
  let keep = [];
  if (last > 1) {
    keep = sh.getRange(2, 1, last - 1, headers.length).getValues()
      .filter(r => String(r[ki]) !== String(value) && !r.every(c => c === ''));
  }
  const all = keep.concat(newObjs.map(o => toRow_(name, o)));
  if (last > 1) sh.getRange(2, 1, last - 1, headers.length).clearContent();
  writeRows_(sh, 2, all, headers);
}

function audit_(username, action, registerId, detail) {
  try {
    appendObj_('AuditLog', { Timestamp: now_(), Username: username, Action: action,
      RegisterID: registerId || '', Detail: detail || '' });
  } catch (e) {
    console.error('Audit failed: ' + e);
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw appError_('The system is busy – please try again in a moment.');
  try { return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}

// ---------------------------------------------------------------- dates & weeks
// All dates are ISO strings (yyyy-MM-dd). Arithmetic is done in UTC so the
// server time zone can never shift a day.

function isoToUtc_(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) throw appError_('Invalid date: ' + iso);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function utcToIso_(d) {
  return d.toISOString().slice(0, 10);
}

function addDaysIso_(iso, n) {
  const d = isoToUtc_(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return utcToIso_(d);
}

function fmtDmy_(iso) {
  if (!iso) return '';
  const p = String(iso).slice(0, 10).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso;
}

/**
 * Everything about the Monday–Sunday week containing `iso`.
 * A week belongs to the month of its Thursday, so every week sits in exactly
 * one month (4 or 5 weeks per month) and week numbers run 1–5.
 */
function weekInfo_(iso) {
  const d = isoToUtc_(iso);
  const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
  const monday = utcToIso_(new Date(d.getTime() - dow * 86400000));
  const thu = isoToUtc_(addDaysIso_(monday, 3));
  const year = thu.getUTCFullYear(), mon = thu.getUTCMonth();
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(addDaysIso_(monday, i));
  return {
    weekFrom: monday,
    weekTo: dates[6],
    dates: dates,
    year: year,
    month: year + '-' + ('0' + (mon + 1)).slice(-2),
    monthLabel: MONTH_NAMES[mon] + ' ' + year,
    weekNo: Math.floor((thu.getUTCDate() - 1) / 7) + 1,
    due: addDaysIso_(dates[6], RULES.dueDaysAfterWeekEnd) + ' ' + RULES.dueTime,
  };
}

/** All register weeks belonging to a month (yyyy-MM). */
function weeksOfMonth_(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) throw appError_('Invalid month: ' + ym);
  let info = weekInfo_(ym + '-01');
  if (info.month !== ym) info = weekInfo_(addDaysIso_(info.weekFrom, 7));
  const out = [];
  while (info.month === ym) {
    out.push(info);
    info = weekInfo_(addDaysIso_(info.weekFrom, 7));
  }
  return out;
}

// ---------------------------------------------------------------- misc

function toHex_(bytes) {
  return bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

function num_(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function r1_(n) {
  return Math.round(n * 10) / 10;
}

function pct_(p, a) {
  return p ? (p - a) / p * 100 : 0;
}

function clip_(s, n) {
  return String(s === undefined || s === null ? '' : s).trim().slice(0, n);
}
