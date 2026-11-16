/**
 * Weekly registers: create / open, save, SOP validation and the sign-off workflow
 *   Draft --(OM completes)--> Completed --(AM checks)--> Checked --(NM approves)--> Approved
 *   AM / NM can return a register to Draft with a note; Admin can reopen an approved one.
 */

const EDIT_ROLES = ['OM', 'SL', 'ADMIN'];

// ---------------------------------------------------------------- data shape

function rowSpec_() {
  const out = [];
  CATEGORIES.forEach(c => SHIFTS.forEach(s => out.push({ cat: c, shift: s })));
  return out;
}

function blankData_(dates) {
  return {
    dates: dates,
    rows: rowSpec_().map(r => ({ cat: r.cat, shift: r.shift, p: Array(7).fill(''), a: Array(7).fill('') })),
    absences: [],
  };
}

/** Accept only the expected structure and values from the browser. */
function sanitizeData_(input, dates) {
  const d = blankData_(dates);
  const rows = (input && Array.isArray(input.rows)) ? input.rows : [];
  d.rows.forEach((r, i) => {
    const src = rows[i] || {};
    ['p', 'a'].forEach(k => {
      for (let j = 0; j < 7; j++) {
        const raw = src[k] && src[k][j] !== undefined && src[k][j] !== null ? String(src[k][j]).trim().replace(',', '.') : '';
        if (raw === '') { r[k][j] = ''; continue; }
        const n = Number(raw);
        if (isNaN(n) || n < 0 || n > 500 || Math.round(n * 2) !== n * 2) {
          throw appError_(r.cat + ' ' + r.shift + ', ' + DAYS[j] + ': "' + raw + '" is not valid. Use whole numbers or halves (0.5 for 7–1 / 1–7 shifts).');
        }
        r[k][j] = String(n);
      }
    });
  });
  const abs = (input && Array.isArray(input.absences)) ? input.absences.slice(0, 300) : [];
  d.absences = abs.map(a => ({
    date: dates.indexOf(a.date) >= 0 ? a.date : '',
    name: clip_(a.name, 100),
    cat: CATEGORIES.indexOf(a.cat) >= 0 ? a.cat : '',
    shift: SHIFTS.indexOf(a.shift) >= 0 ? a.shift : 'Day',
    reason: REASONS.indexOf(a.reason) >= 0 ? a.reason : '',
    relief: ['Yes', 'No'].indexOf(a.relief) >= 0 ? a.relief : '',
    days: (function (v) { const n = Number(String(v || '').replace(',', '.')); return isNaN(n) || n < 0 || n > 31 ? '' : String(n); })(a.days),
  }));
  return d;
}

// ---------------------------------------------------------------- calculations & SOP checks

/** SOP 5.3 + 7. Returns totals and the check list; `errors` block sign-off. */
function evaluate_(data, comments) {
  let P = 0, A = 0, blanks = 0;
  const dp = Array(7).fill(0), da = Array(7).fill(0), overs = [], rowTotals = [];
  data.rows.forEach(r => {
    let p = 0, a = 0;
    for (let d = 0; d < 7; d++) {
      const pv = num_(r.p[d]), av = num_(r.a[d]);
      p += pv; a += av; dp[d] += pv; da[d] += av;
      if (r.p[d] === '') blanks++;
      if (r.a[d] === '') blanks++;
      if (av > pv) overs.push(r.cat + ' ' + r.shift + ', ' + DAYS[d]);
    }
    rowTotals.push({ p: r1_(p), a: r1_(a), x: r1_(p - a), pct: r1_(pct_(p, a)) });
    P += p; A += a;
  });
  const R = pct_(P, A);
  const shortfall = r1_(dp.reduce((s, v, i) => s + Math.max(0, v - da[i]), 0));
  const listedDays = data.absences.reduce((s, a) => s + (num_(a.days) || 1), 0);
  const com = String(comments || '').trim();

  const errors = [], warnings = [], ok = [];
  if (blanks) errors.push(blanks + ' blank cell(s) – enter 0 where no nurses were planned or on duty.');
  else ok.push('No blank cells.');
  if (overs.length) {
    const t = 'Actual higher than Plan (' + overs.length + '): ' + overs.slice(0, 4).join('; ') + (overs.length > 4 ? '…' : '') + ' – explain in Comments.';
    (com ? warnings : errors).push(t);
  }
  if (shortfall && !data.absences.length) errors.push('There is a shortfall of ' + shortfall + ' shift(s) but no nurses are listed in Absence details.');
  else if (shortfall && listedDays < shortfall) warnings.push('Absence details list ' + listedDays + ' day(s) against a daily shortfall of ' + shortfall + ' shift(s) – check every absent nurse is listed.');
  else if (shortfall) ok.push(data.absences.length + ' absence(s) listed against a shortfall of ' + shortfall + ' shift(s).');
  if (data.absences.some(a => !a.date || !a.name || !a.cat || !a.reason)) errors.push('Some absence rows are missing the date, name, category or reason.');
  if (R > RULES.absThreshold) {
    if (com.length >= RULES.minCommentLength) ok.push('Absenteeism ' + R.toFixed(1) + '% is above ' + RULES.absThreshold + '% – explanation provided.');
    else errors.push('Absenteeism ' + R.toFixed(1) + '% is above ' + RULES.absThreshold + '% – explain in Comments with the action taken.');
  }
  // SOP 5.3.5 – category totals must equal daily totals (always true when computed, kept as an explicit check)
  const catSum = r1_(rowTotals.reduce((s, t) => s + t.p, 0)), daySum = r1_(dp.reduce((s, v) => s + v, 0));
  if (catSum !== daySum) errors.push('Category totals (' + catSum + ') do not equal daily totals (' + daySum + ').');

  return {
    totals: { plan: r1_(P), actual: r1_(A), absent: r1_(P - A), pct: r1_(R) },
    rowTotals: rowTotals,
    daily: { plan: dp.map(r1_), actual: da.map(r1_) },
    shortfall: shortfall,
    errors: errors, warnings: warnings, ok: ok,
  };
}

// ---------------------------------------------------------------- loading

function findRegister_(id) {
  const r = readAll_('Registers').find(x => x.RegisterID === id);
  if (!r) throw appError_('Register not found.', 'NOT_FOUND');
  return r;
}

/** Current area of the register's unit (falls back to the area stored when it was created). */
function regArea_(r) {
  return areaOf_(r.Facility, r.Unit) || r.Area || '';
}

function parseData_(reg) {
  try {
    const d = JSON.parse(reg.Data || '{}');
    if (!d.rows) throw 0;
    return d;
  } catch (e) {
    return blankData_(weekInfo_(reg.WeekFrom).dates);
  }
}

function permissions_(user, reg) {
  const role = user.Role, s = reg.Status;
  return {
    canEdit: s === STATUS.DRAFT && EDIT_ROLES.indexOf(role) >= 0,
    canComplete: s === STATUS.DRAFT && role === 'OM',
    canCheck: s === STATUS.COMPLETED && role === 'AM',
    canApprove: s === STATUS.CHECKED && role === 'NM',
    canReturn: (s === STATUS.COMPLETED && role === 'AM') || (s === STATUS.CHECKED && role === 'NM'),
    canReopen: s !== STATUS.DRAFT && role === 'ADMIN',
    canPrintSheet: role === 'ADMIN' || role === 'INFO',
  };
}

function toClient_(user, reg) {
  const data = parseData_(reg);
  const w = weekInfo_(reg.WeekFrom);
  return {
    id: reg.RegisterID, facility: reg.Facility, area: regArea_(reg), unit: reg.Unit, year: reg.Year, month: reg.Month,
    monthLabel: reg.MonthLabel, weekNo: reg.WeekNo, weekFrom: reg.WeekFrom, weekTo: reg.WeekTo, due: w.due,
    status: reg.Status, data: data, comments: reg.Comments,
    completedBy: reg.CompletedBy, completedAt: reg.CompletedAt,
    checkedBy: reg.CheckedBy, checkedAt: reg.CheckedAt,
    approvedBy: reg.ApprovedBy, approvedAt: reg.ApprovedAt,
    submittedAt: reg.SubmittedAt, submittedLate: reg.SubmittedLate,
    returnNote: reg.ReturnNote, updatedBy: reg.UpdatedBy, updatedAt: reg.UpdatedAt, version: reg.Version,
    evaluation: evaluate_(data, reg.Comments),
    perms: permissions_(user, reg),
  };
}

function summary_(r) {
  return {
    id: r.RegisterID, facility: r.Facility, area: regArea_(r), unit: r.Unit, month: r.Month, monthLabel: r.MonthLabel,
    weekNo: r.WeekNo, weekFrom: r.WeekFrom, weekTo: r.WeekTo, status: r.Status,
    plan: r.TotalPlan, actual: r.TotalActual, absent: r.Absent, pct: r.PctAbsent,
    completedBy: r.CompletedBy, checkedBy: r.CheckedBy, approvedBy: r.ApprovedBy,
    submittedAt: r.SubmittedAt, submittedLate: r.SubmittedLate, returnNote: r.ReturnNote, updatedAt: r.UpdatedAt,
  };
}

// ---------------------------------------------------------------- API: list / open

function apiListRegisters_(user, p) {
  let list = readAll_('Registers').filter(r => canSeeUnit_(user, r.Facility, r.Unit, regArea_(r)));
  if (p.month) list = list.filter(r => r.Month === p.month);
  if (p.facility) list = list.filter(r => r.Facility === p.facility);
  if (p.status) list = list.filter(r => r.Status === p.status);
  list.sort((a, b) => (b.WeekFrom.localeCompare(a.WeekFrom)) || (a.Unit.localeCompare(b.Unit)));

  const all = readAll_('Registers').filter(r => canSeeUnit_(user, r.Facility, r.Unit, regArea_(r)));
  const mine = all.filter(r => {
    const pm = permissions_(user, r);
    return pm.canComplete || pm.canCheck || pm.canApprove || (user.Role === 'SL' && r.Status === STATUS.DRAFT);
  }).sort((a, b) => a.WeekFrom.localeCompare(b.WeekFrom));

  return { registers: list.slice(0, 500).map(summary_), todo: mine.slice(0, 100).map(summary_) };
}

function apiGetRegister_(user, p) {
  const reg = findRegister_(p.id);
  assertUnit_(user, reg.Facility, reg.Unit, regArea_(reg));
  return toClient_(user, reg);
}

/** Open the register for a unit/week, creating it if it does not exist yet. */
function apiOpenRegister_(user, p) {
  const facility = clip_(p.facility, 120), unit = clip_(p.unit, 120);
  assertUnit_(user, facility, unit);
  const w = weekInfo_(p.weekFrom);
  const find = () => readAll_('Registers').find(r => r.Facility === facility && r.Unit === unit && r.WeekFrom === w.weekFrom);
  let reg = find();
  if (reg) return toClient_(user, reg);

  if (EDIT_ROLES.indexOf(user.Role) < 0) throw appError_('No register has been started for ' + unit + ', week of ' + fmtDmy_(w.weekFrom) + '.', 'NOT_FOUND');
  const unitRow = readAll_('Units').find(u => u.Facility === facility && u.Unit === unit && u.Active);
  if (!unitRow) throw appError_('Unit not found or inactive.');

  return withLock_(() => {
    reg = find(); // re-check inside the lock
    if (reg) return toClient_(user, reg);
    const id = 'REG-' + Utilities.getUuid().slice(0, 8).toUpperCase();
    const data = blankData_(w.dates);
    const row = {
      RegisterID: id, Facility: facility, Unit: unit, Year: w.year, Month: w.month, MonthLabel: w.monthLabel,
      WeekNo: w.weekNo, WeekFrom: w.weekFrom, WeekTo: w.weekTo, Status: STATUS.DRAFT, Data: JSON.stringify(data),
      Comments: '', TotalPlan: 0, TotalActual: 0, Absent: 0, PctAbsent: 0,
      CreatedBy: user.Username, CreatedAt: now_(), UpdatedBy: user.Username, UpdatedAt: now_(), Version: 1,
      Area: unitRow.Area || '',
    };
    appendObj_('Registers', row);
    audit_(user.Username, 'REGISTER_CREATED', id, unit + ' ' + w.weekFrom);
    return toClient_(user, findRegister_(id));
  });
}

// ---------------------------------------------------------------- API: save

function checkVersion_(reg, version) {
  if (version !== undefined && Number(version) !== Number(reg.Version)) {
    throw appError_('This register was changed by ' + (reg.UpdatedBy || 'someone else') + ' at ' + reg.UpdatedAt +
                    '. Reload it before saving so their changes are not lost.', 'CONFLICT');
  }
}

/** Write data + totals + flat reporting rows. Caller holds the lock. */
function persist_(user, reg, data, comments, action) {
  const ev = evaluate_(data, comments);
  Object.assign(reg, {
    Data: JSON.stringify(data), Comments: clip_(comments, 5000),
    TotalPlan: ev.totals.plan, TotalActual: ev.totals.actual, Absent: ev.totals.absent, PctAbsent: ev.totals.pct,
    UpdatedBy: user.Username, UpdatedAt: now_(), Version: Number(reg.Version || 0) + 1, Area: regArea_(reg),
  });
  updateObj_('Registers', reg);

  const base = { RegisterID: reg.RegisterID, Facility: reg.Facility, Area: reg.Area, Unit: reg.Unit, Month: reg.Month, WeekNo: reg.WeekNo };
  const daily = [];
  data.rows.forEach(r => data.dates.forEach((dt, i) => daily.push(Object.assign({}, base, {
    Date: dt, Day: DAYS[i], Category: r.cat, Shift: r.shift, Plan: r.p[i] === '' ? '' : Number(r.p[i]), Actual: r.a[i] === '' ? '' : Number(r.a[i]),
  }))));
  replaceFor_('DailyData', 'RegisterID', reg.RegisterID, daily);
  replaceFor_('Absences', 'RegisterID', reg.RegisterID, data.absences.map(a => Object.assign({}, base, {
    Date: a.date, Name: a.name, Category: a.cat, Shift: a.shift, Reason: a.reason, Relief: a.relief, Days: a.days === '' ? '' : Number(a.days),
  })));
  if (action) audit_(user.Username, action, reg.RegisterID, 'P=' + ev.totals.plan + ' A=' + ev.totals.actual + ' (' + ev.totals.pct + '%)');
  return ev;
}

function apiSaveRegister_(user, p) {
  return withLock_(() => {
    const reg = findRegister_(p.id);
    assertUnit_(user, reg.Facility, reg.Unit, regArea_(reg));
    if (!permissions_(user, reg).canEdit) throw appError_('This register is ' + reg.Status + ' and can no longer be edited by you.', 'FORBIDDEN');
    checkVersion_(reg, p.version);
    const data = sanitizeData_(p.data, weekInfo_(reg.WeekFrom).dates);
    persist_(user, reg, data, p.comments, 'REGISTER_SAVED');
    return toClient_(user, findRegister_(reg.RegisterID));
  });
}

// ---------------------------------------------------------------- API: workflow

function apiSignRegister_(user, p) {
  const result = withLock_(() => {
    const reg = findRegister_(p.id);
    assertUnit_(user, reg.Facility, reg.Unit, regArea_(reg));
    checkVersion_(reg, p.version);
    const perms = permissions_(user, reg);
    const signer = user.FullName;
    const stamp = now_();

    if (p.step === 'complete') {
      if (!perms.canComplete) throw appError_('Only the Operational Manager can complete a draft register.', 'FORBIDDEN');
      const data = sanitizeData_(p.data || parseData_(reg), weekInfo_(reg.WeekFrom).dates);
      const comments = p.comments !== undefined ? p.comments : reg.Comments;
      const ev = evaluate_(data, comments);
      if (ev.errors.length) {
        persist_(user, reg, data, comments, 'REGISTER_SAVED'); // keep their work
        throw appError_('Saved, but cannot sign yet:\n• ' + ev.errors.join('\n• '), 'VALIDATION');
      }
      Object.assign(reg, { Status: STATUS.COMPLETED, CompletedBy: signer, CompletedAt: stamp, ReturnNote: '' });
      persist_(user, reg, data, comments, 'SIGNED_COMPLETED');
    } else if (p.step === 'check') {
      if (!perms.canCheck) throw appError_('Only the Area Manager can check a completed register.', 'FORBIDDEN');
      Object.assign(reg, { Status: STATUS.CHECKED, CheckedBy: signer, CheckedAt: stamp,
        UpdatedBy: user.Username, UpdatedAt: stamp, Version: reg.Version + 1 });
      updateObj_('Registers', reg);
      audit_(user.Username, 'SIGNED_CHECKED', reg.RegisterID, '');
    } else if (p.step === 'approve') {
      if (!perms.canApprove) throw appError_('Only the Nursing Manager can approve a checked register.', 'FORBIDDEN');
      const due = weekInfo_(reg.WeekFrom).due;
      Object.assign(reg, { Status: STATUS.APPROVED, ApprovedBy: signer, ApprovedAt: stamp, SubmittedAt: stamp,
        SubmittedLate: stamp > due ? 'Yes' : 'No', UpdatedBy: user.Username, UpdatedAt: stamp, Version: reg.Version + 1 });
      updateObj_('Registers', reg);
      audit_(user.Username, 'SIGNED_APPROVED', reg.RegisterID, stamp > due ? 'late (due ' + due + ')' : 'on time');
    } else {
      throw appError_('Unknown sign-off step.');
    }
    return findRegister_(reg.RegisterID);
  });

  // Archive copy in the monthly printout spreadsheet once approved (best effort).
  if (result.Status === STATUS.APPROVED) {
    try { buildRegisterTab_(result); } catch (e) { console.error('Archive failed: ' + e); }
  }
  return toClient_(user, result);
}

function apiReturnRegister_(user, p) {
  const note = clip_(p.note, 1000);
  if (note.length < 5) throw appError_('Write what needs to be corrected.');
  return withLock_(() => {
    const reg = findRegister_(p.id);
    assertUnit_(user, reg.Facility, reg.Unit, regArea_(reg));
    if (!permissions_(user, reg).canReturn) throw appError_('You cannot return this register.', 'FORBIDDEN');
    const stamp = now_();
    Object.assign(reg, {
      Status: STATUS.DRAFT, CompletedBy: '', CompletedAt: '', CheckedBy: '', CheckedAt: '',
      ReturnNote: note + ' — ' + user.FullName + ' (' + (ROLES[user.Role] || user.Role) + '), ' + stamp,
      UpdatedBy: user.Username, UpdatedAt: stamp, Version: reg.Version + 1,
    });
    updateObj_('Registers', reg);
    audit_(user.Username, 'RETURNED', reg.RegisterID, note);
    return toClient_(user, reg);
  });
}

function apiReopenRegister_(user, p) {
  requireRole_(user, ['ADMIN']);
  const note = clip_(p.note, 1000);
  if (note.length < 5) throw appError_('Give a reason for reopening.');
  return withLock_(() => {
    const reg = findRegister_(p.id);
    const stamp = now_();
    Object.assign(reg, {
      Status: STATUS.DRAFT, CompletedBy: '', CompletedAt: '', CheckedBy: '', CheckedAt: '', ApprovedBy: '', ApprovedAt: '',
      SubmittedAt: '', SubmittedLate: '', ReturnNote: 'Reopened: ' + note + ' — ' + user.FullName + ', ' + stamp,
      UpdatedBy: user.Username, UpdatedAt: stamp, Version: reg.Version + 1,
    });
    updateObj_('Registers', reg);
    audit_(user.Username, 'REOPENED', reg.RegisterID, note);
    return toClient_(user, reg);
  });
}
