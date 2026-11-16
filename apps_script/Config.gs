/**
 * Weekly Nursing Attendance & Absenteeism Register – ECDoH
 * Configuration and constants (single source of truth for the SOP rules).
 */

const APP = {
  name: 'Weekly Nursing Attendance & Absenteeism Register',
  org: 'Eastern Cape Department of Health',
  version: '1.0.0',
};

/** Roles. Keys are stored in the Users sheet. */
const ROLES = {
  ADMIN: 'Administrator',
  OM: 'Operational Manager',
  SL: 'Shift Leader (delegated)',
  AM: 'Area Manager',
  NM: 'Nursing Manager',
  INFO: 'Nursing Admin / Information Office',
};

/**
 * Hospitals offered in the Hospital dropdown (admin unit screen, user set-up).
 * Hospitals that already have units in the Units sheet are added automatically,
 * so new hospitals can also be added from the app ("+ Add hospital…").
 */
const HOSPITALS = ['Livingstone Hospital'];

/** SOP 4.1 – three categories, each with a Day and a Night row (six rows). */
const CATEGORIES = ['Registered Nurses', 'Staff Nurses', 'Auxiliary Nurses'];
const SHIFTS = ['Day', 'Night'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const REASONS = ['Sick leave', 'Annual leave', 'Family responsibility', 'AWOL', 'Study leave', 'Other'];

/** Register workflow (SOP 5.4). */
const STATUS = {
  DRAFT: 'Draft',
  COMPLETED: 'Completed',
  CHECKED: 'Checked',
  APPROVED: 'Approved',
};

const RULES = {
  absThreshold: 10,        // % above which Comments must explain action taken (SOP 5.4.5)
  minCommentLength: 15,    // a "real" explanation
  dueDaysAfterWeekEnd: 2,  // Tuesday after Sunday
  dueTime: '12:00',
};

const SECURITY = {
  sessionSeconds: 6 * 60 * 60, // CacheService maximum
  maxLoginAttempts: 5,
  lockoutSeconds: 15 * 60,
  hashRounds: 500,
  minPasswordLength: 8,
};

/**
 * Database sheets and their columns. New columns are only ever appended at the
 * end, so "Set up / repair sheets" can upgrade an existing database in place.
 */
const SCHEMA = {
  Users: ['Username', 'FullName', 'Email', 'Role', 'Facility', 'Units', 'PasswordHash', 'Salt',
          'Active', 'MustChange', 'CreatedAt', 'LastLogin'],
  Units: ['Facility', 'Unit', 'Active', 'Area'],
  Registers: ['RegisterID', 'Facility', 'Unit', 'Year', 'Month', 'MonthLabel', 'WeekNo', 'WeekFrom', 'WeekTo',
              'Status', 'Data', 'Comments', 'TotalPlan', 'TotalActual', 'Absent', 'PctAbsent',
              'CompletedBy', 'CompletedAt', 'CheckedBy', 'CheckedAt', 'ApprovedBy', 'ApprovedAt',
              'SubmittedAt', 'SubmittedLate', 'ReturnNote', 'CreatedBy', 'CreatedAt', 'UpdatedBy', 'UpdatedAt',
              'Version', 'Area'],
  DailyData: ['RegisterID', 'Facility', 'Unit', 'Month', 'WeekNo', 'Date', 'Day', 'Category', 'Shift',
              'Plan', 'Actual', 'Area'],
  Absences: ['RegisterID', 'Facility', 'Unit', 'Month', 'WeekNo', 'Date', 'Name', 'Category', 'Shift',
             'Reason', 'Relief', 'Days', 'Area'],
  AuditLog: ['Timestamp', 'Username', 'Action', 'RegisterID', 'Detail'],
};

/** Columns kept as plain text so Sheets never turns them into dates/numbers. */
const TEXT_COLS = ['Username', 'PasswordHash', 'Salt', 'Units', 'Month', 'WeekFrom', 'WeekTo', 'Date',
                   'CreatedAt', 'UpdatedAt', 'CompletedAt', 'CheckedAt', 'ApprovedAt', 'SubmittedAt',
                   'LastLogin', 'Timestamp', 'Data'];
const DATETIME_COLS = ['CreatedAt', 'UpdatedAt', 'CompletedAt', 'CheckedAt', 'ApprovedAt', 'SubmittedAt',
                       'LastLogin', 'Timestamp'];
const NUM_COLS = ['Year', 'WeekNo', 'TotalPlan', 'TotalActual', 'Absent', 'PctAbsent', 'Version',
                  'Plan', 'Actual', 'Days'];

/** Prefix in Users.Units meaning "every unit in this area" (e.g. "Area: Ward"). */
const AREA_PREFIX = 'Area: ';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                     'September', 'October', 'November', 'December'];
