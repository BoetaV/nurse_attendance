/**
 * Monthly roll-up and generated Google Sheets.
 *
 * Printable registers are written to one spreadsheet per facility per month,
 * "Absenteeism – <Facility> – <yyyy-MM>", kept in a "Register printouts" folder
 * next to the database spreadsheet. Each approved register gets its own tab with
 * live formulas (week totals, absent, % absent, daily totals), and a
 * "Monthly summary" tab can be generated for the facility.
 */

const GREEN = '#0B6B3A', LIGHT = '#E8F3EC', YELLOW = '#F2B705', BAD = '#F8D7DA', WARN = '#FDEFC3';

// ---------------------------------------------------------------- monthly roll-up (data)

function rollup_(user, month, facility, areaFilter) {
  const weeks = weeksOfMonth_(month);
  const unitArea = {};
  readAll_('Units').filter(u => u.Active && u.Facility === facility && canSeeUnit_(user, u.Facility, u.Unit, u.Area))
    .forEach(u => unitArea[u.Unit] = u.Area || 'General');
  const regs = readAll_('Registers').filter(r => r.Month === month && r.Facility === facility && canSeeUnit_(user, r.Facility, r.Unit, regArea_(r)));
  regs.forEach(r => { if (!unitArea[r.Unit]) unitArea[r.Unit] = regArea_(r) || 'General'; });

  let names = Object.keys(unitArea);
  if (areaFilter) names = names.filter(n => unitArea[n] === areaFilter);
  names.sort((x, y) => unitArea[x].localeCompare(unitArea[y]) || x.localeCompare(y));

  let GP = 0, GA = 0, approved = 0, expected = 0;
  const areaTot = {};
  const units = names.map(unit => {
    let UP = 0, UA = 0;
    const rows = weeks.map(w => {
      expected++;
      const r = regs.find(x => x.Unit === unit && x.WeekFrom === w.weekFrom);
      if (!r) return { weekNo: w.weekNo, weekFrom: w.weekFrom, weekTo: w.weekTo, missing: true };
      UP += r.TotalPlan; UA += r.TotalActual;
      if (r.Status === STATUS.APPROVED) approved++;
      return Object.assign(summary_(r), { absences: parseData_(r).absences.length });
    });
    GP += UP; GA += UA;
    const area = unitArea[unit];
    const t = areaTot[area] = areaTot[area] || { area: area, p: 0, a: 0, units: 0 };
    t.p += UP; t.a += UA; t.units++;
    return { area: area, unit: unit, weeks: rows, plan: r1_(UP), actual: r1_(UA), absent: r1_(UP - UA), pct: r1_(pct_(UP, UA)) };
  });
  const areas = Object.keys(areaTot).sort().map(k => {
    const t = areaTot[k];
    return { area: k, units: t.units, plan: r1_(t.p), actual: r1_(t.a), absent: r1_(t.p - t.a), pct: r1_(pct_(t.p, t.a)) };
  });
  return {
    month: month, monthLabel: weeks.length ? weeks[0].monthLabel : month, facility: facility, area: areaFilter || '',
    weeks: weeks.map(w => ({ weekNo: w.weekNo, weekFrom: w.weekFrom, weekTo: w.weekTo })),
    units: units, areas: areas,
    total: { plan: r1_(GP), actual: r1_(GA), absent: r1_(GP - GA), pct: r1_(pct_(GP, GA)) },
    approved: approved, expected: expected,
  };
}

function apiMonthlyRollup_(user, p) {
  requireRole_(user, ['ADMIN', 'INFO', 'NM', 'AM', 'OM']);
  if (!p.facility) throw appError_('Choose a facility.');
  return rollup_(user, p.month, p.facility, clip_(p.area, 120));
}

// ---------------------------------------------------------------- archive spreadsheets

function archiveFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ARCHIVE_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate */ } }
  const parents = DriveApp.getFileById(db_().getId()).getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const folder = parent.createFolder('Register printouts');
  props.setProperty('ARCHIVE_FOLDER_ID', folder.getId());
  return folder;
}

function archiveSpreadsheet_(facility, month) {
  const props = PropertiesService.getScriptProperties();
  const key = 'ARCH_' + Utilities.base64EncodeWebSafe(facility + '|' + month);
  const id = props.getProperty(key);
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* deleted – recreate */ } }
  const ss = SpreadsheetApp.create('Absenteeism – ' + facility + ' – ' + month);
  DriveApp.getFileById(ss.getId()).moveTo(archiveFolder_());
  ss.getSheets()[0].setName('Monthly summary');
  props.setProperty(key, ss.getId());
  return ss;
}

function safeTabName_(s) {
  return String(s).replace(/[\[\]\*\?\/\\:']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
}

function colL_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---------------------------------------------------------------- register tab (live formulas)

/** Build/refresh the printable tab for one register. Returns { ss, sheet }. */
function buildRegisterTab_(reg) {
  const data = parseData_(reg);
  const ss = archiveSpreadsheet_(reg.Facility, reg.Month);
  const name = safeTabName_(reg.Unit + ' – Wk' + reg.WeekNo + ' (' + reg.WeekFrom + ')');
  let sh = ss.getSheetByName(name);
  if (sh) { sh.clear(); sh.clearConditionalFormatRules(); sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart(); }
  else sh = ss.insertSheet(name);

  const NC = 20; // A..T
  if (sh.getMaxRows() < 400) sh.insertRowsAfter(sh.getMaxRows(), 400 - sh.getMaxRows()); // room for up to 300 absences
  if (sh.getMaxColumns() > NC) sh.deleteColumns(NC + 1, sh.getMaxColumns() - NC);
  sh.setColumnWidth(1, 150); sh.setColumnWidth(2, 55);
  for (let c = 3; c <= 16; c++) sh.setColumnWidth(c, 46);
  sh.setColumnWidths(17, 4, 64);
  const all = sh.getRange(1, 1, sh.getMaxRows(), NC);
  all.setFontFamily('Arial').setFontSize(9).setVerticalAlignment('middle');

  const merge = (r, c, w, v, opts) => {
    const rg = sh.getRange(r, c, 1, w);
    if (w > 1) rg.merge();
    if (opts && opts.formula) rg.setFormula(v); else rg.setValue(safeText_(v));
    if (opts) {
      if (opts.bold) rg.setFontWeight('bold');
      if (opts.bg) rg.setBackground(opts.bg);
      if (opts.color) rg.setFontColor(opts.color);
      if (opts.size) rg.setFontSize(opts.size);
      if (opts.align) rg.setHorizontalAlignment(opts.align);
      if (opts.wrap) rg.setWrap(true);
    }
    return rg;
  };

  // Title + header
  merge(1, 1, NC, 'WEEKLY NURSING ATTENDANCE & ABSENTEEISM REGISTER', { bold: true, size: 13, color: GREEN });
  merge(2, 1, NC, APP.org + '  |  Nursing Services  |  Register ' + reg.RegisterID + '  |  Status: ' + reg.Status, { color: '#5f6b66' });
  sh.getRange(2, 1, 1, NC).setBorder(null, null, true, null, null, null, YELLOW, SpreadsheetApp.BorderStyle.SOLID_THICK);
  const lab = { bold: true, color: GREEN, bg: LIGHT };
  merge(3, 1, 1, 'Hospital / Facility', lab); merge(3, 2, 7, reg.Facility);
  merge(3, 9, 3, 'Area / Unit', lab); merge(3, 12, 5, (regArea_(reg) ? regArea_(reg) + ' – ' : '') + reg.Unit);
  merge(3, 17, 2, 'Week number', lab); merge(3, 19, 2, reg.WeekNo, { align: 'center' });
  merge(4, 1, 1, 'Month', lab); merge(4, 2, 7, reg.MonthLabel);
  merge(4, 9, 3, 'Week from (Mon)', lab); merge(4, 12, 5, fmtDmy_(reg.WeekFrom));
  merge(4, 17, 2, 'Week to (Sun)', lab); merge(4, 19, 2, fmtDmy_(reg.WeekTo), { align: 'center' });

  // Section 1 – daily register
  let r = 6;
  merge(r, 1, NC, '1. Daily register (number of nurses)', { bold: true, color: GREEN, size: 11 });
  r = 7;
  const th = { bold: true, bg: GREEN, color: '#ffffff', align: 'center' };
  merge(r, 1, 1, 'Category', th); merge(r, 2, 1, 'Shift', th);
  DAYS.forEach((d, i) => merge(r, 3 + 2 * i, 2, d.toUpperCase(), th));
  merge(r, 17, 2, 'WEEK TOTAL', th); merge(r, 19, 1, 'Absent (P−A)', th); merge(r, 20, 1, '% Absent', th);
  sh.getRange(r, 19, 1, 2).setWrap(true);
  const sub = { bold: true, bg: LIGHT, color: GREEN, align: 'center' };
  merge(r + 1, 1, 2, '', sub);
  DAYS.forEach((d, i) => merge(r + 1, 3 + 2 * i, 2, fmtDmy_(data.dates[i]), sub));
  merge(r + 1, 17, 4, '', sub);
  const subRow = [['', '']];
  for (let i = 0; i < 8; i++) subRow[0].push('Plan', 'Actual');
  subRow[0].push('', '');
  sh.getRange(r + 2, 1, 1, NC).setValues(subRow).setFontWeight('bold').setBackground(LIGHT).setFontColor(GREEN).setHorizontalAlignment('center');

  const first = r + 3, last = first + data.rows.length - 1, totRow = last + 1;
  const vals = data.rows.map(row => {
    const out = [row.cat, row.shift];
    for (let d = 0; d < 7; d++) out.push(row.p[d] === '' ? '' : Number(row.p[d]), row.a[d] === '' ? '' : Number(row.a[d]));
    return out;
  });
  sh.getRange(first, 1, vals.length, 16).setValues(vals);
  const planCols = DAYS.map((_, i) => colL_(3 + 2 * i)), actCols = DAYS.map((_, i) => colL_(4 + 2 * i));
  const f = [];
  for (let rr = first; rr <= last; rr++) {
    f.push([
      '=' + planCols.map(c => c + rr).join('+'),
      '=' + actCols.map(c => c + rr).join('+'),
      '=Q' + rr + '-R' + rr,
      '=IF(Q' + rr + '=0,"–",S' + rr + '/Q' + rr + ')',
    ]);
  }
  sh.getRange(first, 17, f.length, 4).setFormulas(f);
  const tot = [['DAILY TOTAL', '']];
  for (let c = 3; c <= 18; c++) tot[0].push('=SUM(' + colL_(c) + first + ':' + colL_(c) + last + ')');
  tot[0].push('=Q' + totRow + '-R' + totRow, '=IF(Q' + totRow + '=0,"–",S' + totRow + '/Q' + totRow + ')');
  sh.getRange(totRow, 1, 1, NC).setValues(tot).setFontWeight('bold').setBackground('#f6f9f7');
  sh.getRange(first, 3, totRow - first + 1, 18).setHorizontalAlignment('center');
  sh.getRange(first, 17, totRow - first + 1, 4).setBackground(LIGHT).setFontWeight('bold');
  sh.getRange(first, 20, totRow - first + 1, 1).setNumberFormat('0.0%');
  sh.getRange(r, 1, totRow - r + 1, NC).setBorder(true, true, true, true, true, true, '#cfd8d3', SpreadsheetApp.BorderStyle.SOLID);
  merge(totRow + 1, 1, NC,
    '=IF(SUM(Q' + first + ':Q' + last + ')=SUM(' + planCols.map(c => c + totRow).join(',') + '),"✔ Category totals equal daily totals","✖ Category totals do not equal daily totals – correct before signing")',
    { color: '#5f6b66', formula: true });
  merge(totRow + 2, 1, NC, 'Counting: 7–7 day/night shifts = 1 · 7–1 or 1–7 shifts = 0.5 · Students not counted · Relief/agency only when covering a rostered post', { color: '#5f6b66' });

  // Section 2 – weekly summary
  r = totRow + 4;
  merge(r, 1, NC, '2. Weekly summary', { bold: true, color: GREEN, size: 11 });
  const kp = [['Total planned (P)', '=Q' + totRow], ['Total actual (A)', '=R' + totRow],
              ['Shifts absent (X = P − A)', '=Q' + totRow + '-R' + totRow],
              ['% Absent (X ÷ P × 100)', '=IF(Q' + totRow + '=0,0,(Q' + totRow + '-R' + totRow + ')/Q' + totRow + ')']];
  kp.forEach((k, i) => { merge(r + 1 + i, 1, 4, k[0], lab); merge(r + 1 + i, 5, 2, k[1], { bold: true, align: 'center', formula: true }); });
  const pctCell = sh.getRange(r + 4, 5);
  pctCell.setNumberFormat('0.0%');
  sh.getRange(r + 1, 1, 4, 6).setBorder(true, true, true, true, true, true, '#cfd8d3', SpreadsheetApp.BorderStyle.SOLID);

  // Conditional formatting for % absent (>15% red, >10% amber)
  const pctRanges = [sh.getRange(first, 20, totRow - first + 1, 1), pctCell];
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0.15).setBackground(BAD).setFontColor('#a12a2a').setRanges(pctRanges).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0.10).setBackground(WARN).setRanges(pctRanges).build(),
  ]);

  // Section 3 – absences
  r = r + 6;
  merge(r, 1, NC, '3. Absence details', { bold: true, color: GREEN, size: 11 });
  const cols = [[1, 1, 'Date'], [2, 5, 'Name & surname'], [7, 3, 'Category'], [10, 2, 'Shift'], [12, 3, 'Reason'], [15, 3, 'Relief arranged?'], [18, 3, 'Days']];
  cols.forEach(c => merge(r + 1, c[0], c[1], c[2], th));
  const abs = data.absences.length ? data.absences : [{ date: '', name: 'No absences recorded', cat: '', shift: '', reason: '', relief: '', days: '' }];
  abs.forEach((a, i) => {
    const vals2 = [fmtDmy_(a.date), a.name, a.cat, a.shift, a.reason, a.relief, a.days === '' ? '' : Number(a.days)];
    cols.forEach((c, j) => merge(r + 2 + i, c[0], c[1], vals2[j], j === 1 ? null : { align: 'center' }));
  });
  sh.getRange(r + 1, 1, abs.length + 1, NC).setBorder(true, true, true, true, true, true, '#cfd8d3', SpreadsheetApp.BorderStyle.SOLID);

  // Section 4 – comments
  r = r + abs.length + 3;
  merge(r, 1, NC, '4. Comments', { bold: true, color: GREEN, size: 11 });
  merge(r + 1, 1, NC, reg.Comments || '', { wrap: true });
  sh.setRowHeight(r + 1, Math.min(200, 30 + 15 * Math.ceil(String(reg.Comments || '').length / 160)));
  sh.getRange(r + 1, 1, 1, NC).setBorder(true, true, true, true, null, null, '#cfd8d3', SpreadsheetApp.BorderStyle.SOLID).setVerticalAlignment('top');

  // Section 5 – sign-off
  r = r + 3;
  merge(r, 1, NC, '5. Sign-off', { bold: true, color: GREEN, size: 11 });
  const sig = [
    ['Completed by (Operational Manager)', reg.CompletedBy, reg.CompletedAt],
    ['Checked by (Area Manager)', reg.CheckedBy, reg.CheckedAt],
    ['Approved by (Nursing Manager)', reg.ApprovedBy, reg.ApprovedAt],
    ['Date submitted', reg.SubmittedAt ? (reg.SubmittedLate === 'Yes' ? 'LATE' : 'On time') : '', reg.SubmittedAt],
  ];
  merge(r + 1, 1, 6, 'Role', th); merge(r + 1, 7, 8, 'Name (electronic sign-off)', th); merge(r + 1, 15, 6, 'Date & time', th);
  sig.forEach((s, i) => { merge(r + 2 + i, 1, 6, s[0], lab); merge(r + 2 + i, 7, 8, s[1] || ''); merge(r + 2 + i, 15, 6, s[2] || '', { align: 'center' }); });
  sh.getRange(r + 1, 1, 5, NC).setBorder(true, true, true, true, true, true, '#cfd8d3', SpreadsheetApp.BorderStyle.SOLID);
  merge(r + 7, 1, NC, 'Due at nursing administration by 12:00 on the Tuesday after the week ends (' + fmtDmy_(addDaysIso_(reg.WeekTo, 2)) + ').  Generated ' + now_() + '.', { color: '#5f6b66' });
  merge(r + 8, 1, NC, 'Together, moving the health system forward  |  ' + APP.org, { color: '#5f6b66' });
  sh.getRange(r + 8, 1, 1, NC).setBorder(true, null, null, null, null, null, YELLOW, SpreadsheetApp.BorderStyle.SOLID_THICK);

  const lastRow = r + 8;
  if (sh.getMaxRows() > lastRow + 2) sh.deleteRows(lastRow + 3, sh.getMaxRows() - lastRow - 2);
  sh.setHiddenGridlines(true);
  SpreadsheetApp.flush();
  return { ss: ss, sheet: sh };
}

// ---------------------------------------------------------------- monthly summary tab

function buildMonthlyTab_(user, facility, month) {
  const R = rollup_(user, month, facility);
  const ss = archiveSpreadsheet_(facility, month);
  let sh = ss.getSheetByName('Monthly summary');
  if (sh) { sh.clear(); sh.clearConditionalFormatRules(); sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart(); }
  else sh = ss.insertSheet('Monthly summary', 0);

  // A Area | B Unit | C Week | D From | E To | F Planned | G Actual | H Absent | I % | J Absences | K Status | L–N sign-off | O Submitted | P Late
  const H = ['Area', 'Unit', 'Week', 'From', 'To', 'Planned', 'Actual', 'Absent', '% Absent', 'Absences listed', 'Status',
             'Completed by', 'Checked by', 'Approved by', 'Submitted', 'Late'];
  const NC = H.length, FIRST = 5;
  const blank = () => Array(NC).fill('');
  const calcCols = r => ['=F' + r + '-G' + r, '=IF(F' + r + '=0,"",H' + r + '/F' + r + ')'];
  const rows = [], styles = []; // styles: [rowIndex, kind]
  const unitTotalRows = {}, areaTotalRows = [];

  R.units.forEach((u, i) => {
    const start = FIRST + rows.length;
    u.weeks.forEach(w => {
      const r = FIRST + rows.length, v = blank();
      v[0] = safeText_(u.area); v[1] = safeText_(u.unit); v[2] = w.weekNo; v[3] = fmtDmy_(w.weekFrom); v[4] = fmtDmy_(w.weekTo);
      if (w.missing) { v[10] = 'NOT CAPTURED'; styles.push([r, 'missing']); }
      else {
        v[5] = w.plan; v[6] = w.actual; [v[7], v[8]] = calcCols(r); v[9] = w.absences; v[10] = w.status;
        v[11] = safeText_(w.completedBy); v[12] = safeText_(w.checkedBy); v[13] = safeText_(w.approvedBy);
        v[14] = w.submittedAt; v[15] = w.submittedLate;
      }
      rows.push(v);
    });
    const r = FIRST + rows.length, end = r - 1, v = blank();
    v[0] = safeText_(u.area); v[1] = safeText_(u.unit) + ' – month total';
    v[5] = '=SUM(F' + start + ':F' + end + ')'; v[6] = '=SUM(G' + start + ':G' + end + ')'; [v[7], v[8]] = calcCols(r);
    rows.push(v); styles.push([r, 'unit']);
    (unitTotalRows[u.area] = unitTotalRows[u.area] || []).push(r);

    const next = R.units[i + 1];
    if (!next || next.area !== u.area) { // close the area
      const ar = FIRST + rows.length, av = blank(), list = unitTotalRows[u.area];
      av[0] = safeText_(u.area) + ' – AREA TOTAL';
      av[5] = '=' + list.map(x => 'F' + x).join('+'); av[6] = '=' + list.map(x => 'G' + x).join('+'); [av[7], av[8]] = calcCols(ar);
      rows.push(av); styles.push([ar, 'area']); areaTotalRows.push(ar);
    }
  });
  if (areaTotalRows.length) {
    const r = FIRST + rows.length, v = blank();
    v[0] = 'ALL AREAS – ' + safeText_(facility);
    v[5] = '=' + areaTotalRows.map(x => 'F' + x).join('+'); v[6] = '=' + areaTotalRows.map(x => 'G' + x).join('+'); [v[7], v[8]] = calcCols(r);
    rows.push(v); styles.push([r, 'all']);
  }

  const needRows = FIRST + rows.length + 5;
  if (sh.getMaxRows() < needRows) sh.insertRowsAfter(sh.getMaxRows(), needRows - sh.getMaxRows());
  if (sh.getMaxColumns() < NC) sh.insertColumnsAfter(sh.getMaxColumns(), NC - sh.getMaxColumns());
  sh.getRange(1, 1).setValue('MONTHLY UNIT ABSENTEEISM REPORT – ' + facility + ' – ' + R.monthLabel).setFontWeight('bold').setFontSize(13).setFontColor(GREEN);
  sh.getRange(2, 1).setValue(APP.org + ' | Weeks are Monday–Sunday and belong to the month of their Thursday | Generated ' + now_()).setFontColor('#5f6b66');
  sh.getRange(4, 1, 1, NC).setValues([H]).setFontWeight('bold').setBackground(GREEN).setFontColor('#ffffff').setWrap(true);
  if (!rows.length) {
    sh.getRange(FIRST, 1).setValue('No units or registers for this month.');
  } else {
    sh.getRange(FIRST, 4, rows.length, 2).setNumberFormat('@');
    sh.getRange(FIRST, 1, rows.length, NC).setValues(rows).setFontSize(9);
    styles.forEach(([r, kind]) => {
      const rg = sh.getRange(r, 1, 1, NC);
      if (kind === 'missing') sh.getRange(r, 11).setFontColor('#a12a2a').setFontWeight('bold');
      if (kind === 'unit') rg.setFontWeight('bold').setBackground(LIGHT);
      if (kind === 'area') rg.setFontWeight('bold').setBackground('#d6eadd');
      if (kind === 'all') rg.setFontWeight('bold').setBackground('#b9dcc5');
    });
    const pr = [sh.getRange(FIRST, 9, rows.length, 1)];
    pr[0].setNumberFormat('0.0%');
    sh.setConditionalFormatRules([
      SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0.15).setBackground(BAD).setRanges(pr).build(),
      SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0.10).setBackground(WARN).setRanges(pr).build(),
    ]);
    sh.getRange(4, 1, rows.length + 1, NC).setBorder(true, true, true, true, true, true, '#cfd8d3', SpreadsheetApp.BorderStyle.SOLID);
  }
  sh.setColumnWidth(1, 110);
  sh.setColumnWidth(2, 220);
  sh.setColumnWidths(3, 9, 70);
  sh.setColumnWidths(12, 3, 140);
  sh.setColumnWidths(15, 2, 110);
  sh.setFrozenRows(4);
  SpreadsheetApp.flush();
  return { ss: ss, sheet: sh };
}

// ---------------------------------------------------------------- API

function sheetUrl_(ss, sh) {
  return ss.getUrl() + '#gid=' + sh.getSheetId();
}

/** Admin / Info office: (re)build the register tab and return its link. */
function apiRegisterSheet_(user, p) {
  requireRole_(user, ['ADMIN', 'INFO']);
  const reg = findRegister_(p.id);
  assertUnit_(user, reg.Facility, reg.Unit);
  const t = buildRegisterTab_(reg);
  return { url: sheetUrl_(t.ss, t.sheet), name: t.ss.getName() + ' › ' + t.sheet.getName() };
}

/** Anyone who can see the register: A4 landscape PDF of the formatted sheet. */
function apiRegisterPdf_(user, p) {
  const reg = findRegister_(p.id);
  assertUnit_(user, reg.Facility, reg.Unit);
  const t = buildRegisterTab_(reg);
  const url = 'https://docs.google.com/spreadsheets/d/' + t.ss.getId() + '/export?format=pdf&gid=' + t.sheet.getSheetId() +
    '&size=A4&portrait=false&fitw=true&gridlines=false&printtitle=false&sheetnames=false&pagenum=UNDEFINED' +
    '&top_margin=0.3&bottom_margin=0.3&left_margin=0.3&right_margin=0.3&horizontal_alignment=CENTER';
  const resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw appError_('Could not create the PDF (HTTP ' + resp.getResponseCode() + '). Try again.');
  audit_(user.Username, 'PDF', reg.RegisterID, '');
  return {
    base64: Utilities.base64Encode(resp.getContent()),
    filename: ('Absenteeism_' + reg.Unit + '_Wk' + reg.WeekNo + '_' + reg.WeekFrom).replace(/[^\w\-]+/g, '_') + '.pdf',
  };
}

function apiMonthlySheet_(user, p) {
  requireRole_(user, ['ADMIN', 'INFO']);
  if (!p.facility) throw appError_('Choose a facility.');
  const t = buildMonthlyTab_(user, p.facility, p.month);
  audit_(user.Username, 'MONTHLY_SHEET', '', p.facility + ' ' + p.month);
  return { url: sheetUrl_(t.ss, t.sheet), name: t.ss.getName() };
}
