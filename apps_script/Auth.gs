/**
 * Login, sessions, access scope and user / unit administration.
 *
 * Passwords are stored as salted, iterated SHA-256 hashes. Sessions are random
 * tokens kept in the script cache (6 hours, sliding). Every API call re-reads the
 * user row, so deactivating a user takes effect immediately.
 */

// ---------------------------------------------------------------- passwords

function hashPassword_(password, salt) {
  let h = salt + '|' + password;
  for (let i = 0; i < SECURITY.hashRounds; i++) {
    h = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + '|' + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function newSalt_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function tempPassword_() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const seed = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  let out = '';
  for (let i = 0; i < 10; i++) {
    const n = parseInt(seed.substr(i * 2, 2), 16) + Math.floor(Math.random() * 256);
    out += alphabet[n % alphabet.length];
  }
  return out.slice(0, 8) + Math.floor(Math.random() * 90 + 10); // always contains digits
}

function checkPasswordPolicy_(pw) {
  if (!pw || pw.length < SECURITY.minPasswordLength) throw appError_('Password must be at least ' + SECURITY.minPasswordLength + ' characters.');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw appError_('Password must contain letters and numbers.');
}

// ---------------------------------------------------------------- users

function findUser_(username) {
  const u = String(username || '').trim().toLowerCase();
  return readAll_('Users').find(x => x.Username.toLowerCase() === u) || null;
}

function publicUser_(u) {
  return {
    username: u.Username,
    fullName: u.FullName,
    email: u.Email,
    role: u.Role,
    roleLabel: ROLES[u.Role] || u.Role,
    facility: u.Facility,
    units: u.Units,
    mustChange: !!u.MustChange,
  };
}

// ---------------------------------------------------------------- login / session (public endpoints)

function login(username, password) {
  try {
    const cache = CacheService.getScriptCache();
    const key = 'lf_' + String(username || '').trim().toLowerCase();
    const fails = Number(cache.get(key) || 0);
    if (fails >= SECURITY.maxLoginAttempts) {
      throw appError_('Too many failed attempts. Try again in 15 minutes.', 'LOCKED');
    }
    const u = findUser_(username);
    const ok = u && u.Active && u.PasswordHash && hashPassword_(String(password || ''), u.Salt) === u.PasswordHash;
    if (!ok) {
      cache.put(key, String(fails + 1), SECURITY.lockoutSeconds);
      audit_(String(username || ''), 'LOGIN_FAILED', '', '');
      throw appError_('Incorrect username or password, or the account is inactive.', 'LOGIN');
    }
    cache.remove(key);
    const token = Utilities.getUuid() + Utilities.getUuid();
    cache.put('sess_' + token, u.Username, SECURITY.sessionSeconds);
    u.LastLogin = now_();
    updateObj_('Users', u);
    audit_(u.Username, 'LOGIN', '', '');
    return { ok: true, data: { token: token, user: publicUser_(u) } };
  } catch (e) {
    return errOut_(e);
  }
}

function logout(token) {
  try { CacheService.getScriptCache().remove('sess_' + token); } catch (e) { /* ignore */ }
  return { ok: true, data: true };
}

function requireSession_(token) {
  if (!token) throw appError_('Please sign in.', 'AUTH');
  const cache = CacheService.getScriptCache();
  const username = cache.get('sess_' + token);
  if (!username) throw appError_('Your session has expired. Please sign in again.', 'AUTH');
  const u = findUser_(username);
  if (!u || !u.Active) {
    cache.remove('sess_' + token);
    throw appError_('Your account is no longer active.', 'AUTH');
  }
  cache.put('sess_' + token, u.Username, SECURITY.sessionSeconds); // sliding expiry
  return u;
}

function apiChangePassword_(user, p) {
  if (hashPassword_(String(p.oldPassword || ''), user.Salt) !== user.PasswordHash) throw appError_('Current password is incorrect.');
  checkPasswordPolicy_(String(p.newPassword || ''));
  if (p.newPassword === p.oldPassword) throw appError_('Choose a password different from the current one.');
  return withLock_(() => {
    const u = findUser_(user.Username);
    u.Salt = newSalt_();
    u.PasswordHash = hashPassword_(p.newPassword, u.Salt);
    u.MustChange = false;
    updateObj_('Users', u);
    audit_(u.Username, 'PASSWORD_CHANGED', '', '');
    return publicUser_(u);
  });
}

// ---------------------------------------------------------------- access scope

function unitList_(u) {
  return u.Units === '*' ? '*' : String(u.Units || '').split(',').map(s => s.trim()).filter(String);
}

/** Area of a unit, from the Units sheet (memoised for the current request). */
let AREA_MAP_ = null;
function areaOf_(facility, unit) {
  if (!AREA_MAP_) {
    AREA_MAP_ = {};
    readAll_('Units').forEach(x => AREA_MAP_[x.Facility + '|' + x.Unit] = x.Area);
  }
  return AREA_MAP_[facility + '|' + unit] || '';
}

/**
 * Users.Units holds "*" (all units), unit names, and/or "Area: <name>" entries
 * that cover every unit in that area – including units added later.
 */
function canSeeUnit_(u, facility, unit, area) {
  if (u.Role === 'ADMIN') return true;
  if (u.Facility !== '*' && u.Facility !== facility) return false;
  const list = unitList_(u);
  if (list === '*' || list.indexOf(unit) >= 0) return true;
  const a = area || areaOf_(facility, unit);
  return !!a && list.indexOf(AREA_PREFIX + a) >= 0;
}

function assertUnit_(u, facility, unit, area) {
  if (!canSeeUnit_(u, facility, unit, area)) throw appError_('You do not have access to ' + unit + ' (' + facility + ').', 'FORBIDDEN');
}

function requireRole_(u, roles) {
  if (roles.indexOf(u.Role) < 0) throw appError_('Your role (' + (ROLES[u.Role] || u.Role) + ') cannot do this.', 'FORBIDDEN');
}

function unitsInScope_(u) {
  return readAll_('Units')
    .filter(x => x.Active && canSeeUnit_(u, x.Facility, x.Unit, x.Area))
    .map(x => ({ facility: x.Facility, area: x.Area || 'General', unit: x.Unit }))
    .sort((a, b) => a.facility.localeCompare(b.facility) || a.area.localeCompare(b.area) || a.unit.localeCompare(b.unit));
}

// ---------------------------------------------------------------- admin: users

function apiListUsers_(user) {
  requireRole_(user, ['ADMIN']);
  return readAll_('Users').map(u => ({
    username: u.Username, fullName: u.FullName, email: u.Email, role: u.Role, facility: u.Facility,
    units: u.Units, active: u.Active, mustChange: u.MustChange, lastLogin: u.LastLogin, createdAt: u.CreatedAt,
  }));
}

function apiSaveUser_(user, p) {
  requireRole_(user, ['ADMIN']);
  const username = clip_(p.username, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw appError_('Username: 3–40 characters, letters, numbers, dot, dash or underscore.');
  if (!ROLES[p.role]) throw appError_('Choose a valid role.');
  const fullName = clip_(p.fullName, 100);
  if (!fullName) throw appError_('Full name is required (it is used for sign-off).');
  const facility = clip_(p.facility, 120) || '*';
  const units = p.units === '*' ? '*' : (Array.isArray(p.units) ? p.units : String(p.units || '').split(','))
    .map(s => clip_(s, 120)).filter(String).join(', ');
  if (!units) throw appError_('Choose at least one unit (or all units).');
  if (facility === '*' && ['OM', 'SL'].indexOf(p.role) >= 0) throw appError_('Operational Managers and Shift Leaders must belong to one facility.');

  return withLock_(() => {
    const existing = findUser_(username);
    let temp = null;
    if (p.isNew) {
      if (existing) throw appError_('Username "' + username + '" already exists.');
      temp = tempPassword_();
      const salt = newSalt_();
      appendObj_('Users', {
        Username: username, FullName: fullName, Email: clip_(p.email, 120), Role: p.role, Facility: facility,
        Units: units, PasswordHash: hashPassword_(temp, salt), Salt: salt, Active: p.active !== false,
        MustChange: true, CreatedAt: now_(), LastLogin: '',
      });
      audit_(user.Username, 'USER_CREATED', '', username + ' as ' + p.role);
    } else {
      if (!existing) throw appError_('User not found.');
      if (existing.Username === user.Username && (p.role !== 'ADMIN' || p.active === false)) {
        throw appError_('You cannot remove your own administrator access.');
      }
      Object.assign(existing, { FullName: fullName, Email: clip_(p.email, 120), Role: p.role, Facility: facility,
        Units: units, Active: p.active !== false });
      updateObj_('Users', existing);
      audit_(user.Username, 'USER_UPDATED', '', username);
    }
    return { tempPassword: temp, users: apiListUsers_(user) };
  });
}

function apiResetPassword_(user, p) {
  requireRole_(user, ['ADMIN']);
  return withLock_(() => {
    const u = findUser_(p.username);
    if (!u) throw appError_('User not found.');
    const temp = tempPassword_();
    u.Salt = newSalt_();
    u.PasswordHash = hashPassword_(temp, u.Salt);
    u.MustChange = true;
    updateObj_('Users', u);
    CacheService.getScriptCache().remove('lf_' + u.Username.toLowerCase());
    audit_(user.Username, 'PASSWORD_RESET', '', u.Username);
    return { tempPassword: temp };
  });
}

// ---------------------------------------------------------------- admin: units

function apiListUnits_(user) {
  requireRole_(user, ['ADMIN']);
  return readAll_('Units')
    .map(u => ({ facility: u.Facility, area: u.Area, unit: u.Unit, active: u.Active }))
    .sort((a, b) => a.facility.localeCompare(b.facility) || a.area.localeCompare(b.area) || a.unit.localeCompare(b.unit));
}

function cleanName_(v, what) {
  const s = clip_(v, 120).replace(/\s+/g, ' ');
  if (!s) throw appError_(what + ' is required.');
  if (/[,*]/.test(s) || s.indexOf(AREA_PREFIX) === 0) throw appError_(what + ' "' + s + '" cannot contain "," or "*" or start with "' + AREA_PREFIX + '".');
  return s;
}

/**
 * Add or update units. rows: [{area, unit, active}]. Matching is on facility + unit
 * (case-insensitive); an existing unit gets its area and active flag updated.
 * Caller holds the lock. Returns { added, updated }.
 */
function upsertUnits_(facility, rows) {
  const sh = sheet_('Units'), all = readAll_('Units');
  const idx = {};
  all.forEach(x => idx[(x.Facility + '|' + x.Unit).toLowerCase()] = x);
  let added = 0, updated = 0;
  const fresh = [];
  rows.forEach(r => {
    const area = cleanName_(r.area, 'Area'), unit = cleanName_(r.unit, 'Unit');
    const key = (facility + '|' + unit).toLowerCase();
    const ex = idx[key];
    if (ex) {
      if (ex.Area !== area || ex.Active !== (r.active !== false)) {
        ex.Area = area; ex.Active = r.active !== false; updateObj_('Units', ex); updated++;
      }
    } else {
      const o = { Facility: facility, Area: area, Unit: unit, Active: r.active !== false };
      idx[key] = o; fresh.push(toRow_('Units', o)); added++;
    }
  });
  if (fresh.length) writeRows_(sh, sh.getLastRow() + 1, fresh, SCHEMA.Units);
  AREA_MAP_ = null;
  return { added: added, updated: updated };
}

function apiSaveUnit_(user, p) {
  requireRole_(user, ['ADMIN']);
  const facility = cleanName_(p.facility, 'Facility');
  return withLock_(() => {
    const res = upsertUnits_(facility, [{ area: p.area, unit: p.unit, active: p.active }]);
    audit_(user.Username, 'UNIT_SAVED', '', facility + ' / ' + p.area + ' / ' + p.unit + (p.active === false ? ' (inactive)' : ''));
    return { units: apiListUnits_(user), result: res };
  });
}

/** Admin: import a reporting-units list (Area;Unit Name) into one facility. */
/**
 * Admin: import a reporting-units list. Each row may carry its own hospital
 * (CSV with a Hospital column); rows without one go to p.facility.
 */
function apiImportUnits_(user, p) {
  requireRole_(user, ['ADMIN']);
  const fallback = clip_(p.facility, 120);
  const rows = (Array.isArray(p.rows) ? p.rows : []).slice(0, 2000)
    .filter(r => r && r.area && r.unit)
    .map(r => ({ facility: clip_(r.facility, 120) || fallback, area: r.area, unit: r.unit }));
  if (!rows.length) throw appError_('No units found in the file. Expected columns: Hospital (optional), Area and Unit Name.');
  if (rows.some(r => !r.facility)) throw appError_('Some rows have no hospital – choose the hospital before importing.');
  return withLock_(() => {
    const total = { added: 0, updated: 0 };
    Array.from(new Set(rows.map(r => r.facility))).forEach(fac => {
      const facility = cleanName_(fac, 'Hospital');
      const res = upsertUnits_(facility, rows.filter(r => r.facility === fac).map(r => ({ area: r.area, unit: r.unit, active: true })));
      total.added += res.added; total.updated += res.updated;
      audit_(user.Username, 'UNITS_IMPORTED', '', facility + ': ' + res.added + ' added, ' + res.updated + ' updated');
    });
    return { units: apiListUnits_(user), result: total };
  });
}
