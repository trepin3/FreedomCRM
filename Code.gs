/**
 * FreedomCRM — Google Apps Script Backend
 * Deploy as Web App: Execute as "Me", Access: "Anyone"
 * Then paste the Web App URL into index.html CONFIG.APPS_SCRIPT_URL
 */

// ══════════════════════════════════════════════════════════════════
// CONFIGURATION — 3 state sheet IDs
// ══════════════════════════════════════════════════════════════════
// The three that already exist. Anything else is created on first upload and
// recorded in Script Properties — 50 empty spreadsheets would mean 50
// openById calls on every stats run, which does not fit in the execution
// limit. States nobody has uploaded to simply do not exist yet.
// Set the instant the script body begins running. Comparing this with the
// time doGet is entered separates our top-level cost from container startup.
const BOOT_T0 = Date.now();

// Production's first three spreadsheets, from before the registry existed.
const SHEET_SEED_PROD = {
  AZ: '16XtlVoT_4XxtPzfH9THF0f9eWnpN4-g6LSJ7Jkeqdic',
  VA: '1Rofg1YZwb1l7RN2pZ9_LbBoP28_zOLeakYGJqSqaFoc',
  OH: '1Z8qf3oprwWpek3LdDCEJnEjOs2OE1eJdJc2mqsVoB4M'
};

// Set ENV_LABEL to STAGING in the staging project's Script Properties. It is
// the only difference between the two projects — this file stays identical.
function envLabel_() {
  return String(PropertiesService.getScriptProperties()
    .getProperty('ENV_LABEL') || '').trim();
}

// Spreadsheet names carry the label so Drive and the tab bar say which world
// you are in. Production leaves ENV_LABEL unset and its names never change.
function envPrefix_() {
  const l = envLabel_();
  return l ? '[' + l + '] ' : '';
}

// Critically, a labelled project inherits none of production's spreadsheets.
// Without this, staging would skip creating AZ/VA/OH — ensureStateSheet_ sees
// them already registered — and read and write the live lead books instead.
// Staging keeps its whole registry in Script Properties.
function seedRegistry_() {
  return envLabel_() ? {} : SHEET_SEED_PROD;
}

function stateRegistry_() {
  let extra = {};
  try {
    extra = JSON.parse(PropertiesService.getScriptProperties().getProperty('STATE_SHEETS') || '{}');
  } catch (e) {}
  return Object.assign({}, seedRegistry_(), extra);
}

// Read on first use, not at script load. Every execution parses this file,
// so anything at the top level is paid by every request — including the ping
// whose whole purpose is to be cheap. Cached per execution.
let _sheets = null;
function sheets_() {
  if (!_sheets) _sheets = stateRegistry_();
  return _sheets;
}

const US_STATES = {
  AL:'Alabama', AK:'Alaska', AZ:'Arizona', AR:'Arkansas', CA:'California',
  CO:'Colorado', CT:'Connecticut', DE:'Delaware', DC:'District of Columbia',
  FL:'Florida', GA:'Georgia', HI:'Hawaii', ID:'Idaho', IL:'Illinois',
  IN:'Indiana', IA:'Iowa', KS:'Kansas', KY:'Kentucky', LA:'Louisiana',
  ME:'Maine', MD:'Maryland', MA:'Massachusetts', MI:'Michigan', MN:'Minnesota',
  MS:'Mississippi', MO:'Missouri', MT:'Montana', NE:'Nebraska', NV:'Nevada',
  NH:'New Hampshire', NJ:'New Jersey', NM:'New Mexico', NY:'New York',
  NC:'North Carolina', ND:'North Dakota', OH:'Ohio', OK:'Oklahoma', OR:'Oregon',
  PA:'Pennsylvania', RI:'Rhode Island', SC:'South Carolina', SD:'South Dakota',
  TN:'Tennessee', TX:'Texas', UT:'Utah', VT:'Vermont', VA:'Virginia',
  WA:'Washington', WV:'West Virginia', WI:'Wisconsin', WY:'Wyoming'
};

// Creates a state's spreadsheet the first time leads arrive for it.
function ensureStateSheet_(code) {
  code = String(code || '').toUpperCase();
  if (!US_STATES[code]) return '';
  if (sheets_()[code]) return sheets_()[code];

  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { return ''; }
  try {
    // Re-read: another request may have created it while we waited.
    const fresh = stateRegistry_();
    if (fresh[code]) { sheets_()[code] = fresh[code]; return fresh[code]; }

    const ss = SpreadsheetApp.create(
      envPrefix_() + 'FreedomCRM Leads — ' + US_STATES[code] + ' (' + code + ')');
    setupTabs(ss, code);

    const reg = {};
    const seeded = seedRegistry_();
    Object.keys(fresh).forEach(function(k) { if (!seeded[k]) reg[k] = fresh[k]; });
    reg[code] = ss.getId();
    PropertiesService.getScriptProperties().setProperty('STATE_SHEETS', JSON.stringify(reg));
    sheets_()[code] = ss.getId();
    return ss.getId();
  } finally {
    lock.releaseLock();
  }
}

// Row count per state, kept in Script Properties. Opening a spreadsheet
// costs about a second; with every state created that is a minute per stats
// run. Counts only change on upload, so they are cheap to keep accurate.
function stateCounts_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty('STATE_ROWS');
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function bumpStateCount_(code, delta) {
  const counts = stateCounts_() || {};
  counts[code] = Math.max(0, (counts[code] || 0) + delta);
  PropertiesService.getScriptProperties().setProperty('STATE_ROWS', JSON.stringify(counts));
}

// States worth opening. Without counts yet, every registered state — being
// slow is survivable, silently skipping a state with leads in it is not.
function activeStates_() {
  const counts = stateCounts_();
  const all = Object.keys(sheets_());
  if (!counts) return all;
  return all.filter(function(code) { return (counts[code] || 0) > 0; });
}

// Recount from the sheets themselves. Run after creating states in bulk, or
// any time the counts look wrong.
function recountStates() {
  const counts = {};
  Object.keys(sheets_()).forEach(function(code) {
    try {
      const sh = SpreadsheetApp.openById(sheets_()[code]).getSheetByName('Leads');
      counts[code] = sh ? Math.max(0, sh.getLastRow() - 1) : 0;
    } catch (e) { counts[code] = 0; }
  });
  PropertiesService.getScriptProperties().setProperty('STATE_ROWS', JSON.stringify(counts));
  const withLeads = Object.keys(counts).filter(function(k) { return counts[k] > 0; });
  const msg = 'Counted ' + Object.keys(counts).length + ' states. With leads: ' +
              withLeads.map(function(k) { return k + '(' + counts[k] + ')'; }).join(', ');
  Logger.log(msg);
  return msg;
}

// Creates every remaining state up front. Safe because the hot loops skip
// states with no rows — without that this would put a minute of spreadsheet
// opens into every stats call.
function createAllStateSheets() {
  if (envLabel_()) {
    const msg = envLabel_() + ' does not need 51 spreadsheets cluttering Drive.' +
                '\nRun createTestStateSheets() instead — Ohio and Arizona only.';
    Logger.log(msg);
    return msg;
  }
  const made = [];
  Object.keys(US_STATES).forEach(function(code) {
    if (sheets_()[code]) return;
    const id = ensureStateSheet_(code);
    if (id) made.push(code);
    Utilities.sleep(200);   // Drive dislikes 48 creations back to back
  });
  recountStates();
  const msg = made.length
    ? 'Created ' + made.length + ' state sheets: ' + made.join(', ')
    : 'Every state already had a sheet.';
  Logger.log(msg);
  return msg;
}

// Run this first in any project you are unsure about. Getting ENV_LABEL wrong
// is silent — staging without it reads the live lead books — so this says out
// loud which world the editor you are sitting in belongs to.
function whereAmI() {
  const props = PropertiesService.getScriptProperties();
  const label = envLabel_();
  const reg   = stateRegistry_();
  const auth  = props.getProperty('AUTH_SHEET_ID');

  const lines = [
    label ? '=== ' + label + ' ===' : '=== PRODUCTION ===',
    label
      ? 'ENV_LABEL is set. New spreadsheets are named "' + envPrefix_() + '…".'
      : 'ENV_LABEL is NOT set. This project owns the real agents\' leads.',
    '',
    'States registered: ' + (Object.keys(reg).length
      ? Object.keys(reg).sort().join(', ') : 'none yet'),
    'Auth spreadsheet:  ' + (auth || 'none yet — run setupAuth()')
  ];

  // The failure worth catching: a labelled project holding production's ids.
  const inherited = Object.keys(reg).filter(function(c) {
    return SHEET_SEED_PROD[c] && reg[c] === SHEET_SEED_PROD[c];
  });
  if (label && inherited.length) {
    lines.push('',
      '*** STOP — this project points at PRODUCTION sheets for ' +
      inherited.join(', ') + '.',
      '*** ENV_LABEL was set after those states were registered.',
      '*** Delete this project and its spreadsheets and start again.');
  }
  if (auth) {
    try {
      lines.push('Auth sheet name:   ' + SpreadsheetApp.openById(auth).getName());
    } catch (e) { lines.push('Auth sheet:        unreadable (' + e.message + ')'); }
  }

  const msg = lines.join('\n');
  Logger.log(msg);
  return msg;
}

// Testing needs two states, not fifty-one: one to work in and a second to prove
// the picker, the mixed-file split and the wrong-state correction still behave.
const TEST_STATES = ['OH', 'AZ'];

function createTestStateSheets() {
  if (!envLabel_()) {
    const msg = 'Refusing: ENV_LABEL is not set, so this is production.' +
                '\nSet ENV_LABEL to STAGING in Script Properties first.';
    Logger.log(msg);
    return msg;
  }
  const made = [];
  TEST_STATES.forEach(function(code) {
    if (sheets_()[code]) return;
    if (ensureStateSheet_(code)) made.push(code);
    Utilities.sleep(200);
  });
  recountStates();
  const msg = made.length
    ? 'Created: ' + made.join(', ') + ' (named "' + envPrefix_() + 'FreedomCRM Leads — …")'
    : 'Ohio and Arizona already exist.';
  Logger.log(msg);
  return msg;
}

// States with leads this user can actually dial. Cached briefly: the picker
// is hit on every sign-in and this reads every registered spreadsheet.
function listStates_(me) {
  const cache = CacheService.getScriptCache();
  const key = 'states_' + (me ? me.id : 'anon') + '_' + statesVersion_();
  const hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  const states = [];
  activeStates_().forEach(function(code) {
    let available = 0, total = 0;
    try {
      const sheet = SpreadsheetApp.openById(sheets_()[code]).getSheetByName('Leads');
      const lr = sheet ? sheet.getLastRow() : 0;
      if (lr >= 2) {
        const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
        data.forEach(function(row) {
          if (!canSee_(row, me)) return;
          total++;
          const st = String(row[ix_('Status')] || '').toLowerCase();
          if (DIALABLE.indexOf(st) === -1) return;
          // A lead this user already holds still counts for them. Excluding
          // every locked row made a state disappear from the picker of the one
          // agent working it — reserve a stack, refresh, and your own leads
          // become unreachable.
          const lockedBy = String(row[ix_('Locked By')] || '');
          if (lockedBy && !lockOwnerIsMe_(lockedBy, me)) return;
          available++;
        });
      }
    } catch (e) { return; }
    states.push({ code: code, name: US_STATES[code] || code, available: available, total: total });
  });

  states.sort(function(a, b) { return b.available - a.available || a.name.localeCompare(b.name); });
  const out = { states: states, all: US_STATES };
  // Short: a release by one agent makes leads available to everyone else, and
  // nobody should stare at a stale picker waiting for it to catch up.
  cache.put(key, JSON.stringify(out), 30);
  return out;
}

// Cached counts are per user, but the thing they count is shared: unsharing a
// batch changes what someone else can see, and their cache key is not one this
// request could name. So the version forms part of every key and bumping it
// retires all of them at once.
function statesVersion_() {
  try {
    const c = CacheService.getScriptCache();
    let v = c.get('states_ver');
    if (!v) { v = String(Date.now()); c.put('states_ver', v, 21600); }
    return v;
  } catch (e) { return '0'; }
}

function invalidateStates_(me) {
  try { CacheService.getScriptCache().put('states_ver', String(Date.now()), 21600); } catch (e) {}
}
const BATCH_SIZE = 5;
const LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const CALLBACK_RESURRECT_MS = 24 * 60 * 60 * 1000; // 24 hours
const REVIEW_THRESHOLD = 30; // attempts before flagging for review
const TZ = 'America/Los_Angeles'; // Pacific Time

// ══════════════════════════════════════════════════════════════════
// LEAD SCHEMA — one Leads tab per state, rows never move.
//
// Disposition sets Status in place, so a lead keeps its Lead ID for life.
// That is what makes ?lead_id= addressable and gives Trellus something
// stable to write back against. The old design moved rows between six
// tabs, which meant a lead's identity was its row number — and row numbers
// shift under you the moment anything else is dispositioned.
//
// Column order is deliberate: choosing a dial batch only needs the HOT
// block, so the hot path reads 16 columns instead of 58.
//
// Names are kept from the old schema wherever the meaning survived.
// rowToObj derives front-end field names from these strings, so renaming
// a column silently renames a field the UI reads.
// ══════════════════════════════════════════════════════════════════

// Everything needed to filter, reserve and prioritise a batch.
const LEAD_HOT = [
  'Lead ID', 'Status', 'Owner ID', 'Visibility', 'Shared With',
  'Locked By', 'Locked At', 'Last Activity At', 'Call Open At',
  'Attempts', 'Last Call Start', 'Callback Hold Until',
  'Name', 'Phone', 'State', 'Date Added'
];

// Shown on the lead card.
const LEAD_WARM = [
  'Email', 'Address', 'City', 'Lead Type', 'Beneficiary', 'Hobby', 'Age', 'DOB'
];

// Provenance and disposition detail — read only when something needs it.
const LEAD_COLD = [
  'Lead Source', 'Batch ID', 'Uploaded By', 'Batch Status',
  'Status Reason', 'Status At', 'Status By',
  'Last Call Agent', 'Last Call End', 'Last Call Duration',
  'Callback Date', 'Callback Time', 'Scheduled By', 'Scheduled Date',
  'DCID Reason', 'DCID Date', 'DCID Agent',
  'DCID Review', 'DCID Reviewed By', 'DCID Reviewed At',
  'Monthly Premium', 'AP Amount', 'Carrier',
  'First Draft Date', 'Recurring Draft Date',
  'Reason for Policy', 'Sale Notes', 'Sold Date', 'Sold Agent', 'Follow Up At',
  'Wrong Number Date', 'Wrong Number Agent',
  'Archived At', 'Archived By',
  // Stored split because that is how lead vendors export. 'Name' above stays
  // the composed display value, written whenever these are, so every reader
  // that already asks for Name keeps working.
  'First Name', 'Last Name', 'Zip',
  // Provenance for a donated batch. Uploaded By stays the original agent, so
  // without these the receiving manager cannot tell a donation from anything
  // else that landed in their pool.
  'Donated By', 'Donated At',
  // Appended, never inserted. Existing sheets already hold Donated By and
  // Donated At at fixed positions, and putting anything before them would
  // shift every value in those columns by one without a word.
  //
  // Holds whatever a vendor sent that has no column of its own, as JSON. Lead
  // files differ by source and always will; a column per field would mean a
  // schema change for every new vendor, and until that change happened the
  // data would simply be dropped. This keeps the tail instead.
  'Extra Data',
  // The ERS appointment is where referrals come from, so it is tracked on the
  // sale that produced it rather than as a second lead. Appended after Extra
  // Data for the same reason Extra Data was appended after Donated At.
  'ERS At', 'ERS Status', 'ERS By', 'ERS Notes', 'Referral Count',
  // On a referral lead: the Lead ID of the sale it came from. This is the only
  // link between a policy and the leads it generated.
  'Referred By'
];

const LEAD_COLS = LEAD_HOT.concat(LEAD_WARM).concat(LEAD_COLD);
const HOT_LEN   = LEAD_HOT.length;

// 1-based column lookup for getRange.
const COL = (function() {
  const m = {};
  LEAD_COLS.forEach(function(n, i) { m[n] = i + 1; });
  return m;
})();
// 0-based, for indexing a row array.
function ix_(name) { return COL[name] - 1; }

// Rows carry these instead of moving between tabs.
const STATUS = {
  NEW:      'new',
  SOLD:     'sold',
  DCID:     'dcid',
  WRONG:    'wrong',
  CALLBACK: 'callback',
  REVIEW:   'review',
  ARCHIVED: 'archived',
  REMOVED:  'removed'      // batch pulled back — reversible, never deleted
};

// Statuses that put a lead back in the dialable pool.
const DIALABLE = [STATUS.NEW, ''];

const VISIBILITY = { POOL: 'pool', EXCLUSIVE: 'exclusive' };

const ERS = { BOOKED: 'booked', DONE: 'done', NO_SHOW: 'no_show' };

// Reservation: 15 minutes idle releases a lead, but an open call holds it —
// with a ceiling, so a crash mid-call cannot freeze 150 leads indefinitely.
const RESERVE_SIZE         = 150;
const IDLE_RELEASE_MS      = 15 * 60 * 1000;
const OPEN_CALL_CEILING_MS = 2 * 60 * 60 * 1000;
const CALLBACK_HOLD_MS     = 72 * 60 * 60 * 1000;  // booking agent keeps it this long
const SOLD_FOLLOWUP_DAYS   = 3;

const SEED_LEAD_SOURCES = ['$1 Bang Bang', '$1 Goat', 'DashlyPro', 'ERS Referral'];

// Dummy test leads (same 10 across all 3 states)
const DUMMY_LEADS = [
  ['John Anderson', '17757204202', 'john.a@test.com', '123 Test St', 'Phoenix', 'AZ', 'FE', 'Sarah Anderson', 'Fishing', 68, '05/12/1957'],
  ['Mary Baker', '16027895141', 'mary.b@test.com', '456 Elm Ave', 'Tucson', 'AZ', 'FE', 'Bob Baker', 'Gardening', 71, '08/24/1954'],
  ['Robert Chen', '17757204202', 'r.chen@test.com', '789 Oak Ln', 'Mesa', 'AZ', 'FE', 'Lily Chen', 'Golf', 65, '02/03/1960'],
  ['Linda Davis', '16027895141', 'linda.d@test.com', '321 Pine Rd', 'Scottsdale', 'AZ', 'FE', 'Mike Davis', 'Reading', 74, '11/15/1951'],
  ['James Evans', '17757204202', 'j.evans@test.com', '654 Maple Dr', 'Chandler', 'AZ', 'FE', 'Karen Evans', 'Woodworking', 69, '07/09/1956'],
  ['Patricia Foster', '16027895141', 'pat.f@test.com', '987 Cedar Ct', 'Gilbert', 'AZ', 'FE', 'Dan Foster', 'Cooking', 72, '01/22/1953'],
  ['Michael Green', '17757204202', 'm.green@test.com', '246 Birch St', 'Tempe', 'AZ', 'FE', 'Susan Green', 'Cycling', 66, '09/30/1959'],
  ['Barbara Harris', '16027895141', 'b.harris@test.com', '135 Walnut Ave', 'Peoria', 'AZ', 'FE', 'Tom Harris', 'Sewing', 78, '04/18/1947'],
  ['William Irving', '17757204202', 'w.irving@test.com', '864 Aspen Way', 'Glendale', 'AZ', 'FE', 'Jane Irving', 'Music', 63, '12/07/1962'],
  ['Nancy Jackson', '16027895141', 'n.jackson@test.com', '579 Willow Ln', 'Surprise', 'AZ', 'FE', 'Paul Jackson', 'Painting', 75, '06/14/1950']
];

// ══════════════════════════════════════════════════════════════════
// INITIAL SETUP — RUN ONCE from Apps Script editor
// ══════════════════════════════════════════════════════════════════
// Test data, in the new schema. Safe to re-run: it appends.
// Test data, in the new schema. Scoped to the three original states — with
// every state created, looping all of them would scatter dummy leads across
// 51 sheets. Safe to re-run: it appends.
function seedDummyLeads() {
  // Production carries real agents' leads now. Fake rows in the live pool
  // would be dialled by someone within the hour.
  if (!envLabel_()) {
    const msg = 'Refusing: ENV_LABEL is not set, so this is production.';
    Logger.log(msg);
    return msg;
  }
  // Whatever states this project actually has — not production's three.
  Object.keys(sheets_()).forEach(function(state) {
    const ss = SpreadsheetApp.openById(sheets_()[state]);
    const sheet = ss.getSheetByName('Leads') || setupTabs(ss, state);
    const rows = DUMMY_LEADS.map(function(d, n) {
      const row = new Array(LEAD_COLS.length).fill('');
      ['Name','Phone','Email','Address','City','State','Lead Type','Beneficiary','Hobby','Age','DOB']
        .forEach(function(name, i) { row[COL[name] - 1] = d[i]; });
      row[ix_('State')]      = state;
      row[ix_('Lead ID')]    = state + '-' + ('000000' + (n + 1)).slice(-6);
      row[ix_('Status')]     = STATUS.NEW;
      row[ix_('Visibility')] = VISIBILITY.POOL;
      row[ix_('Date Added')] = stamp_();
      row[ix_('Lead Source')] = SEED_LEAD_SOURCES[0];
      return row;
    });
    const at = sheet.getLastRow() + 1;
    sheet.getRange(at, COL['Phone'], rows.length, 1).setNumberFormat('@');
    sheet.getRange(at, 1, rows.length, LEAD_COLS.length).setValues(rows);
  });
  const msg = 'Seeded ' + DUMMY_LEADS.length + ' leads into: ' +
              Object.keys(sheets_()).join(', ');
  Logger.log(msg);
  return msg;
}

function initSetup() {
  Object.keys(sheets_()).forEach(state => {
    const ss = SpreadsheetApp.openById(sheets_()[state]);
    setupTabs(ss, state);
  });
  Logger.log('Setup complete for all 3 state sheets.');
}

function setupTabs(ss, stateCode) {
  // One tab. Dispositions set Status in place, so there is nowhere to move to.
  let sheet = ss.getSheetByName('Leads');
  if (!sheet) sheet = ss.insertSheet('Leads');

  sheet.getRange(1, 1, 1, LEAD_COLS.length)
       .setValues([LEAD_COLS]).setFontWeight('bold').setBackground('#e8f0fe');
  sheet.setFrozenRows(1);
  // Phone and the date-ish columns must not be re-parsed by Sheets.
  sheet.getRange(2, COL['Phone'], sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  sheet.getRange(2, COL['Callback Date'], sheet.getMaxRows() - 1, 2).setNumberFormat('@');

  const junk = ss.getSheetByName('Sheet1');
  if (junk && ss.getSheets().length > 1) ss.deleteSheet(junk);
  return sheet;
}

// ══════════════════════════════════════════════════════════════════
// doGet — API entry for GET requests
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
// AUTH — Google Sign-In, sessions, allowlist, activity log
//
// The page cannot be trusted: it is static, public, and anyone can call this
// endpoint directly. So identity is never taken from a parameter — it is proven
// by a Google-signed token, then carried in a session token this script signs.
// ══════════════════════════════════════════════════════════════════

const GOOGLE_CLIENT_ID = '416228276690-41m3pskc2ga2he06jvgusp23j1fvaepk.apps.googleusercontent.com';
const SESSION_HOURS    = 12;
const AGENTS_SHEET     = 'Agents';
const ACTIVITY_SHEET   = 'ActivityLog';
const SEED_ADMIN       = 'kepler.benefic.ins@gmail.com';
// Auth data is not per-state, so it gets its own spreadsheet — kept out of the
// lead books entirely. setupAuth() creates it once and records the id here.
function authSS_() {
  const id = PropertiesService.getScriptProperties().getProperty('AUTH_SHEET_ID');
  if (!id) throw new Error('Auth spreadsheet missing — run setupAuth() once from the editor.');
  return SpreadsheetApp.openById(id);
}

// Run once from the editor: creates the sheets, seeds the admin, mints the secret.
function setupAuth() {
  const props = PropertiesService.getScriptProperties();

  // Create the auth spreadsheet on first run only; re-running is safe.
  let id = props.getProperty('AUTH_SHEET_ID');
  let ss;
  if (id) {
    ss = SpreadsheetApp.openById(id);
  } else {
    ss = SpreadsheetApp.create(envPrefix_() + 'FreedomCRM \u2014 Auth & Activity');
    id = ss.getId();
    props.setProperty('AUTH_SHEET_ID', id);
    const first = ss.getSheets()[0];
    if (first && first.getName() === 'Sheet1') first.setName(AGENTS_SHEET);
  }

  let agents = ss.getSheetByName(AGENTS_SHEET);
  if (!agents) agents = ss.insertSheet(AGENTS_SHEET);
  if (agents.getLastRow() === 0) {
    agents.appendRow(['Email', 'Display Name', 'Role', 'Status', 'Last Login']);
    agents.setFrozenRows(1);
  }
  const emails = agents.getLastRow() > 1
    ? agents.getRange(2, 1, agents.getLastRow() - 1, 1).getValues().map(function(r) {
        return String(r[0]).trim().toLowerCase();
      })
    : [];
  if (emails.indexOf(SEED_ADMIN) === -1) {
    agents.appendRow([SEED_ADMIN, 'Kepler Wolsey', 'admin', 'active', '']);
  }

  let log = ss.getSheetByName(ACTIVITY_SHEET);
  if (!log) {
    log = ss.insertSheet(ACTIVITY_SHEET);
    log.appendRow(['Timestamp', 'Email', 'Name', 'Role', 'Action', 'Detail', 'State']);
    log.setFrozenRows(1);
  }

  if (!props.getProperty('SESSION_SECRET')) {
    props.setProperty('SESSION_SECRET', Utilities.getUuid() + Utilities.getUuid());
  }

  const msg = 'Auth ready.\nAdmin seeded: ' + SEED_ADMIN + '\nSpreadsheet: ' + ss.getUrl();
  Logger.log(msg);
  return msg;
}

function sessionSecret_() {
  const v = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET');
  if (!v) throw new Error('SESSION_SECRET missing — run setupAuth() once from the editor.');
  return v;
}

/**
 * Identifies a caller from a Google ACCESS token, for server-to-server requests
 * from another Apps Script project (Appointment Autopilot).
 *
 * Not the same path as sign-in: that verifies an ID token minted for this app's
 * client. An access token has no audience to check, so the real gate is the last
 * line — the email has to belong to an active user here. A valid Google token
 * from a stranger identifies them correctly and then gets nothing.
 *
 * The token travels in the body because Apps Script never exposes request
 * headers to doPost.
 */
function verifyAccessToken_(token) {
  if (!token) return null;
  const res = UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return null;
  let info;
  try { info = JSON.parse(res.getContentText()); } catch (e) { return null; }
  if (!info.email || String(info.email_verified) !== 'true') return null;
  const u = userByEmail_(info.email);
  return (u && u.status !== 'paused') ? u : null;
}

// Google signs the ID token; we verify it and, critically, that it was minted
// for THIS app. Without the aud check any valid Google token would be accepted.
function verifyGoogleToken_(idToken) {
  if (!idToken) return null;
  const res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;

  let info;
  try { info = JSON.parse(res.getContentText()); } catch (e) { return null; }

  if (info.aud !== GOOGLE_CLIENT_ID) return null;
  if (String(info.email_verified) !== 'true') return null;
  if (Number(info.exp) * 1000 < Date.now()) return null;
  if (!info.email) return null;

  return { email: String(info.email).trim().toLowerCase(), name: info.name || info.email };
}

function findAgent_(email) {
  const u = userByEmail_(email);
  if (u) return { row: u.row, email: u.email, name: u.name, role: u.role,
                  status: u.status, id: u.id, path: u.path };
  return findAgentLegacy_(email);
}

function findAgentLegacy_(email) {
  const sh = authSS_().getSheetByName(AGENTS_SHEET);
  if (!sh || sh.getLastRow() < 2) return null;
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === email) {
      return {
        row: i + 2,
        email: email,
        name: String(rows[i][1] || '').trim(),
        role: String(rows[i][2] || 'agent').trim().toLowerCase(),
        status: String(rows[i][3] || 'active').trim().toLowerCase()
      };
    }
  }
  return null;
}

function signSession_(payload) {
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const sig  = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, sessionSecret_()));
  return body + '.' + sig;
}

function verifySession_(token) {
  if (!token || token.indexOf('.') === -1) return null;
  const parts = token.split('.');
  const expected = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(parts[0], sessionSecret_()));
  if (parts[1] !== expected) return null;               // tampered or forged

  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (e) { return null; }
  if (!payload || !payload.e || Number(payload.x) < Date.now()) return null;

  // Re-read the sheet so disabling an agent takes effect immediately rather
  // than whenever their token happens to expire.
  const agent = findAgent_(payload.e);
  if (!agent || agent.status !== 'active') return null;

  // The id has to be here. Reservations key on it now, and without it the
  // heartbeat reported nothing held, dispositions were refused as lead_released
  // and sign-out released nothing — all while the rows were correctly locked.
  const rec = userByEmail_(agent.email);
  return {
    email: agent.email,
    name: agent.name || payload.n,
    role: agent.role,
    id: (rec && rec.id) || ''
  };
}


// ══════════════════════════════════════════════════════════════════
// USERS — hierarchy, permissions
//
// Every user carries a materialised path: their chain from the root, e.g.
// U001>U007>U042. One column answers all three questions we need:
//   downline?      target.path starts with actor.path
//   my downline    filter paths starting with mine
//   which leads?   owner_id appears in my own path (admin sits at the root of
//                  every path, so house leads reach everyone with no special case)
// ══════════════════════════════════════════════════════════════════

const USERS_SHEET = 'Users';
const USER_COLS   = ['User ID', 'Email', 'Display Name', 'Role', 'Parent ID', 'Path', 'Status', 'Last Login'];

function usersSheet_() {
  const ss = authSS_();
  let sh = ss.getSheetByName(USERS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(USERS_SHEET);
    sh.appendRow(USER_COLS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function usersAll_() {
  const sh = usersSheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, USER_COLS.length).getValues().map(function(r, i) {
    return {
      row: i + 2,
      id: String(r[0]).trim(),
      email: String(r[1]).trim().toLowerCase(),
      name: String(r[2]).trim(),
      role: String(r[3] || 'agent').trim().toLowerCase(),
      parentId: String(r[4] || '').trim(),
      path: String(r[5] || '').trim(),
      status: String(r[6] || 'active').trim().toLowerCase(),
      lastLogin: r[7]
    };
  });
}

function userByEmail_(email) {
  const e = String(email || '').trim().toLowerCase();
  const all = usersAll_();
  for (let i = 0; i < all.length; i++) if (all[i].email === e) return all[i];
  return null;
}

function userById_(id) {
  const all = usersAll_();
  for (let i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}

function nextUserId_() {
  const all = usersAll_();
  let max = 0;
  all.forEach(function(u) {
    const n = parseInt(String(u.id).replace(/^U/, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return 'U' + String(max + 1).padStart(3, '0');
}

// ── Permission primitives ────────────────────────────────────────────────────
// A path prefix must end on a separator, or U001>U0071 would look like a child
// of U001>U007.
function pathStartsWith_(childPath, ancestorPath) {
  if (!childPath || !ancestorPath) return false;
  return childPath === ancestorPath || childPath.indexOf(ancestorPath + '>') === 0;
}

function isInDownline_(actor, target) {
  return !!(actor && target) && actor.id !== target.id && pathStartsWith_(target.path, actor.path);
}

function canManage_(actor, target) {
  if (!actor || !target) return false;
  if (actor.role === 'admin') return actor.id !== target.id;   // admin manages all but itself
  return isInDownline_(actor, target);
}

function downlineOf_(actor, includeSelf) {
  return usersAll_().filter(function(u) {
    if (!pathStartsWith_(u.path, actor.path)) return false;
    return includeSelf ? true : u.id !== actor.id;
  });
}

// ── Mutations ────────────────────────────────────────────────────────────────
function createUser_(actor, opts) {
  const email = String(opts.email || '').trim().toLowerCase();
  const name  = String(opts.name || '').trim();
  const role  = String(opts.role || 'agent').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1) return { error: 'A valid email is required.' };
  if (!name) return { error: 'A display name is required.' };
  if (['manager', 'agent'].indexOf(role) === -1) return { error: 'Role must be manager or agent.' };
  if (userByEmail_(email)) return { error: 'That email already has an account.' };

  // Default to reporting to whoever is creating them.
  const parent = opts.parentId ? userById_(opts.parentId) : actor;
  if (!parent) return { error: 'That manager does not exist.' };
  if (parent.id !== actor.id && !canManage_(actor, parent)) {
    return { error: 'You can only add people under yourself or your downline.' };
  }
  if (parent.role === 'agent') return { error: 'Agents cannot have people reporting to them.' };

  const id = nextUserId_();
  usersSheet_().appendRow([id, email, name, role, parent.id, parent.path + '>' + id, 'active', '']);
  logActivity_(actor, 'createUser', role + ' ' + email + ' under ' + parent.email, '');
  return { ok: true, id: id };
}

// Moving a manager moves everyone beneath them, so the whole subtree is
// rewritten in one pass rather than row by row.
function reassignUser_(actor, userId, newParentId) {
  const target = userById_(userId);
  const parent = userById_(newParentId);
  if (!target || !parent) return { error: 'User not found.' };
  if (!canManage_(actor, target)) return { error: 'That person is not in your downline.' };
  if (parent.id !== actor.id && !canManage_(actor, parent)) {
    return { error: 'That manager is not in your downline.' };
  }
  if (parent.role === 'agent') return { error: 'Agents cannot have people reporting to them.' };
  if (target.id === parent.id || pathStartsWith_(parent.path, target.path)) {
    return { error: 'That would put someone inside their own downline.' };
  }

  const sh = usersSheet_();
  const oldPath = target.path;
  const newPath = parent.path + '>' + target.id;
  usersAll_().forEach(function(u) {
    if (!pathStartsWith_(u.path, oldPath)) return;
    sh.getRange(u.row, 6).setValue(newPath + u.path.slice(oldPath.length));
  });
  sh.getRange(target.row, 5).setValue(parent.id);
  logActivity_(actor, 'reassignUser', target.email + ' -> ' + parent.email, '');
  return { ok: true };
}

// Disabling a manager rolls their reports up to that manager's own parent, so
// nobody is orphaned under a disabled account.
function disableUser_(actor, userId) {
  const target = userById_(userId);
  if (!target) return { error: 'User not found.' };
  if (!canManage_(actor, target)) return { error: 'That person is not in your downline.' };
  if (target.role === 'admin') return { error: 'The admin account cannot be disabled.' };

  const grandparent = userById_(target.parentId);
  if (grandparent) {
    usersAll_().forEach(function(u) {
      if (u.parentId === target.id) reassignUser_(actor, u.id, grandparent.id);
    });
  }
  usersSheet_().getRange(userById_(userId).row, 7).setValue('disabled');
  logActivity_(actor, 'disableUser', target.email, '');
  return { ok: true };
}

// Promote an agent to manager. Position in the tree is unchanged — they simply
// gain the ability to have reports.
function promoteUser_(actor, userId) {
  const target = userById_(userId);
  if (!target) return { error: 'User not found.' };
  if (!canManage_(actor, target)) return { error: 'That person is not in your downline.' };
  if (target.role !== 'agent') return { error: 'Only agents can be promoted.' };
  usersSheet_().getRange(target.row, 4).setValue('manager');
  logActivity_(actor, 'promoteUser', target.email, '');
  return { ok: true };
}

// Demote and revoke both restructure: an agent cannot have reports, and a
// revoked account should not have a live downline hanging off it.
function demoteUser_(actor, userId) {
  if (actor.role !== 'admin') return { error: 'Only the admin can demote.' };
  const target = userById_(userId);
  if (!target) return { error: 'User not found.' };
  if (target.role !== 'manager') return { error: 'That account is not a manager.' };
  rollUpReports_(actor, target);
  usersSheet_().getRange(userById_(userId).row, 4).setValue('agent');
  logActivity_(actor, 'demoteUser', target.email, '');
  return { ok: true };
}

function revokeUser_(actor, userId) {
  if (actor.role !== 'admin') return { error: 'Only the admin can revoke access.' };
  const target = userById_(userId);
  if (!target) return { error: 'User not found.' };
  if (target.role === 'admin') return { error: 'The admin account cannot be revoked.' };
  rollUpReports_(actor, target);
  usersSheet_().getRange(userById_(userId).row, 7).setValue('revoked');
  releaseReservations_(target.name);
  logActivity_(actor, 'revokeUser', target.email, '');
  return { ok: true };
}

// Pause leaves the tree alone — it is temporary, and their agents keep working.
function setPaused_(actor, userId, paused) {
  if (actor.role !== 'admin') return { error: 'Only the admin can pause accounts.' };
  const target = userById_(userId);
  if (!target) return { error: 'User not found.' };
  if (target.role === 'admin') return { error: 'The admin account cannot be paused.' };
  usersSheet_().getRange(target.row, 7).setValue(paused ? 'paused' : 'active');
  if (paused) releaseReservations_(target.name);
  logActivity_(actor, paused ? 'pauseUser' : 'resumeUser', target.email, '');
  return { ok: true };
}

function rollUpReports_(actor, target) {
  const grandparent = userById_(target.parentId);
  if (!grandparent) return;
  usersAll_().forEach(function(u) {
    if (u.parentId === target.id) reassignUser_(actor, u.id, grandparent.id);
  });
}

// Locked leads must not sit frozen behind an account that can no longer sign in.
function releaseReservations_(agentName) {
  if (!agentName) return;
  const want = String(agentName).trim().toLowerCase();
  activeStates_().forEach(function(state) {
    const sh = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const lr = sh.getLastRow();
    if (lr < 2) return;
    const statusIdx = LEAD_COLS.indexOf('Status') + 1;
    const lockedIdx = LEAD_COLS.indexOf('Locked By') + 1;
    const vals = sh.getRange(2, lockedIdx, lr - 1, 1).getValues();
    vals.forEach(function(r, i) {
      if (String(r[0]).trim().toLowerCase() === want) {
        sh.getRange(i + 2, statusIdx).setValue('');
        sh.getRange(i + 2, lockedIdx).setValue('');
      }
    });
  });
}

// ── One-time migration from the flat Agents sheet ───────────────────────────
function migrateAgentsToUsers() {
  const ss = authSS_();
  const sh = usersSheet_();
  if (sh.getLastRow() > 1) return 'Users already populated — nothing to do.';

  const old = ss.getSheetByName(AGENTS_SHEET);
  const rows = (old && old.getLastRow() > 1)
    ? old.getRange(2, 1, old.getLastRow() - 1, 5).getValues() : [];

  // Admin first so it owns the root of every path.
  let n = 0;
  const adminId = 'U001';
  const adminRow = rows.filter(function(r) { return String(r[0]).trim().toLowerCase() === SEED_ADMIN; })[0];
  sh.appendRow([adminId, SEED_ADMIN, adminRow ? adminRow[1] : 'Kepler Wolsey',
                'admin', '', adminId, 'active', adminRow ? adminRow[4] : '']);
  n++;

  rows.forEach(function(r) {
    const email = String(r[0]).trim().toLowerCase();
    if (!email || email === SEED_ADMIN) return;
    const id = 'U' + String(++n).padStart(3, '0');
    const role = String(r[2] || 'agent').trim().toLowerCase() === 'admin' ? 'manager' : (r[2] || 'agent');
    sh.appendRow([id, email, r[1], String(role).toLowerCase(), adminId,
                  adminId + '>' + id, String(r[3] || 'active').toLowerCase(), r[4]]);
  });

  return 'Migrated ' + n + ' users. Everyone reports to admin — rearrange downlines from the portal.';
}

function actionLogin_(body) {
  const g = verifyGoogleToken_(body && body.idToken);
  if (!g) return { error: 'Google sign-in could not be verified.' };

  const agent = findAgent_(g.email);
  if (!agent)                      return { error: 'That account is not on the agent list.' };
  // Paused and revoked are different situations and deserve different words.
  // Paused is a probation an upline can lift; revoked is not.
  if (agent.status === 'paused') {
    return { error: 'Access restricted due to excessive inactivity. Call your upline to gain access.' };
  }
  if (agent.status !== 'active') {
    return { error: 'This account no longer has access. Contact your admin.' };
  }

  // Stamp Last Login on the Users row. This previously wrote column 5 of the
  // legacy Agents tab using a row index taken from Users — a different sheet
  // and a different column — so it dated an unrelated legacy row and left
  // Users.Last Login permanently blank.
  const u = userByEmail_(g.email);
  if (u) {
    authSS_().getSheetByName(USERS_SHEET)
      .getRange(u.row, USER_COLS.indexOf('Last Login') + 1)
      .setValue(Utilities.formatDate(new Date(), TZ, 'MM/dd/yyyy HH:mm:ss'));
  }

  const name = agent.name || g.name;
  logActivity_({ email: agent.email, name: name, role: agent.role }, 'login', '');

  return {
    token: signSession_({ e: agent.email, n: name, r: agent.role,
                          x: Date.now() + SESSION_HOURS * 3600 * 1000 }),
    email: agent.email, name: name, role: agent.role
  };
}

function logActivity_(user, action, detail, stateCode) {
  try {
    const sh = authSS_().getSheetByName(ACTIVITY_SHEET);
    if (!sh) return;
    sh.appendRow([
      Utilities.formatDate(new Date(), TZ, 'MM/dd/yyyy HH:mm:ss'),
      user.email, user.name, user.role, action, detail || '', stateCode || ''
    ]);
  } catch (e) { /* logging must never break a request */ }
}

// ══════════════════════════════════════════════════════════════════
// User management — shared by doGet and doPost
// ══════════════════════════════════════════════════════════════════
// These arrive as POSTs from the team portal, but answering on both verbs
// costs nothing and means a caller can't miss by picking the wrong one.
// Returns null when `action` isn't one of ours, so the caller falls through.
const USER_ACTIONS_ = ['createUser', 'reassignUser', 'disableUser', 'promoteUser',
                       'demoteUser', 'revokeUser', 'pauseUser', 'resumeUser',
                       'changeUserEmail'];

function userAction_(user, action, body) {
  if (USER_ACTIONS_.indexOf(action) === -1) return null;

  const me = userByEmail_(user.email);
  if (!me) return { error: 'No user record.' };
  body = body || {};

  switch (action) {
    case 'createUser':   return createUser_(me, body);
    case 'reassignUser': return reassignUser_(me, body.userId, body.parentId);
    case 'disableUser':  return disableUser_(me, body.userId);
    case 'promoteUser':  return promoteUser_(me, body.userId);
    case 'demoteUser':   return demoteUser_(me, body.userId);
    case 'revokeUser':   return revokeUser_(me, body.userId);
    case 'pauseUser':    return setPaused_(me, body.userId, true);
    case 'resumeUser':   return setPaused_(me, body.userId, false);
    case 'changeUserEmail': return changeUserEmail_(me, body.userId, body.email);
  }
}

function doGet(e) {
  try {
    const action = (e.parameter.action || 'getLeads');

    // Answered before anything else and deliberately empty. Apps Script
    // containers idle out, and a cold start costs 15-25 seconds — the client
    // fires this when the login page loads so the container is awake by the
    // time someone picks an account. It exposes nothing, so it needs no session.
    if (action === 'ping') {
      return jsonOut({
        ok: true,
        bootToHandlerMs: Date.now() - BOOT_T0,   // all of our top-level code
        note: 'registry is lazy; this request never reads Script Properties'
      });
    }

    const user = verifySession_(e.parameter.s);
    if (!user) return jsonOut({ error: 'auth_required' });

    const isAdmin = user.role === 'admin';
    // Managers see the same screen, scoped to their branch; agents get nothing.
    if ((action === 'adminStats' || action === 'adminLocks') &&
        user.role !== 'admin' && user.role !== 'manager') {
      return jsonOut({ error: 'not_permitted' });
    }

    const ua = userAction_(user, action, e.parameter);
    if (ua) return jsonOut(ua);

    let result;
    switch (action) {
      // The agent is whoever the token says, never e.parameter.agent.
      case 'leadById':    result = leadById_(userByEmail_(user.email), e.parameter.leadId); break;
      case 'getSold':     result = getSold(userByEmail_(user.email), e.parameter.range); break;
      case 'getLeads':    result = getLeads(e.parameter.state, user.name, userByEmail_(user.email), e.parameter.size);
                          logActivity_(user, 'getLeads', '', e.parameter.state); break;
      case 'search':      result = search(e.parameter.q, userByEmail_(user.email)); break;
      case 'myCallbacks': result = myCallbacks(user.name, userByEmail_(user.email)); break;
      case 'leaderboard': result = leaderboard(e.parameter.range); break;
      case 'adminStats': {
        const me = userByEmail_(user.email);
        result = adminStats(e.parameter.range, scopeNamesFor_(me)); break;
      }
      case 'adminLocks': {
        const me = userByEmail_(user.email);
        result = adminLocks(scopeNamesFor_(me)); break;
      }
      case 'listSources': result = listSources_(userByEmail_(user.email)); break;
      case 'listStates':  result = listStates_(userByEmail_(user.email)); break;
      case 'heartbeat':   result = heartbeat_(userByEmail_(user.email) || user, e.parameter.state); break;
      case 'myBatches':   result = myBatches_(userByEmail_(user.email)); break;
      case 'dcidQueue':   result = dcidQueue_(userByEmail_(user.email)); break;
      case 'roster':      result = rosterFor_(userByEmail_(user.email)); break;
      case 'donationInfo':result = donationInfo_(userByEmail_(user.email)); break;
      case 'myTeam': {
        const me = userByEmail_(user.email);
        if (!me) { result = { error: 'No user record.' }; break; }
        result = {
          me: { id: me.id, email: me.email, name: me.name, role: me.role },
          // Managers get their branch; admin's path is the root, so this is everyone.
          users: downlineOf_(me, true).map(function(u) {
            return { id: u.id, email: u.email, name: u.name, role: u.role,
                     parentId: u.parentId, depth: u.path.split('>').length - 1,
                     status: u.status, lastLogin: u.lastLogin };
          })
        };
        break;
      }
      default: result = { error: 'unknown action: ' + action };
    }
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ error: err.message, stack: err.stack });
  }
}

// ══════════════════════════════════════════════════════════════════
// doPost — API entry for POST requests (mutations)
// ══════════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;

    // Chicken and egg: this is how you get a session in the first place.
    if (action === 'login') return jsonOut(actionLogin_(body));

    // The Worker authenticates with a shared secret, not a user session, so this
    // is handled before session verification rather than inside the switch.
    if (action === 'trellusEvent') return jsonOut(actionTrellusEvent(body));

    const user = verifySession_(body.s);
    if (!user) return jsonOut({ error: 'auth_required' });
    body.agent = user.name;          // ignore whatever the client claimed
    body.agentId = user.id;          // locks key on this; the name is display
    // Any POST here can change what is dialable, so the caller's cached
    // picker counts are dropped rather than left to expire.
    invalidateStates_(userByEmail_(user.email));
    logActivity_(user, action, body.rowIndex ? ('row ' + body.rowIndex) : '', body.state);

    const ua = userAction_(user, action, body);
    if (ua) return jsonOut(ua);

    let result;
    switch (action) {
      case 'uploadLeads':    result = uploadLeads_(userByEmail_(user.email), body); break;
      case 'existingLeads':  result = existingLeads_(userByEmail_(user.email), body); break;
      case 'addSource':      result = addSource_(userByEmail_(user.email), body.name); break;
      case 'decideSource':   result = decideSource_(userByEmail_(user.email), body.name, body.decision, body.rename); break;
      case 'setBatchStatus': result = setBatchStatus_(userByEmail_(user.email), body.batchId, body.state, !!body.active); break;
      case 'setBatchVisibility': result = setBatchVisibility_(userByEmail_(user.email), body); break;
      case 'shareBatch':     result = shareBatch_(userByEmail_(user.email), body); break;
      case 'donateBatch':    result = donateBatch_(userByEmail_(user.email), body); break;
      case 'updateLead':     result = updateLead_(userByEmail_(user.email), body); break;
      case 'reviewDcid':     result = reviewDcid_(userByEmail_(user.email), body); break;
      case 'donateLead':     result = donateLead_(userByEmail_(user.email), body); break;
      case 'shareLead':      result = shareLead_(userByEmail_(user.email), body); break;
      case 'next': result = actionNext(body); break;
      case 'dcid': result = actionDCID(body); break;
      // Read-only surface for Appointment Autopilot. Authenticated by the
      // caller's own Google token and scoped by the same visibility rules the
      // UI uses, so an agent can only pull batches they can already see.
      case 'apiBatches': {
        const who = verifyAccessToken_(body.token);
        result = who ? { batches: myBatches_(who) } : { error: 'auth_required' };
        break;
      }
      case 'apiBatchLeads': {
        const who = verifyAccessToken_(body.token);
        result = who ? apiBatchLeads_(who, String(body.batchId || ''))
                     : { error: 'auth_required' };
        break;
      }
      case 'leadById':    result = leadById_(userByEmail_(user.email), body.leadId || e.parameter.leadId); break;
      case 'callStarted': result = actionCallStarted(userByEmail_(user.email), body); break;
      case 'sold': result = actionSold(body); break;
      case 'bookErs': result = actionBookErs(userByEmail_(user.email), body); break;
      case 'completeErs': result = actionCompleteErs(userByEmail_(user.email), body); break;
      case 'wrong': result = actionWrong(body); break;
      case 'callback': result = actionCallback(body); break;
      case 'releaseAll': result = actionReleaseAll(body); break;
      case 'forceRelease': result = actionForceRelease(userByEmail_(user.email), body); break;
      case 'returnToPool': result = actionReturnToPool(body); break;
      default: result = { error: 'unknown action: ' + action };
    }
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ error: err.message, stack: err.stack });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ══════════════════════════════════════════════════════════════════
// GET LEADS — fetch batch, lock rows, cleanup stale locks, resurrect callbacks
// ══════════════════════════════════════════════════════════════════
function getLeads(stateCode, agent, me, size) {
  if (!sheets_()[stateCode]) return { error: 'invalid state' };
  const ss = SpreadsheetApp.openById(sheets_()[stateCode]);
  const sheet = ss.getSheetByName('Leads');
  // A full stack, not a handful. Locked By/At, Last Activity At and Call Open
  // At are columns 6-9, so the whole block is read and written once — at this
  // size, setting cells one at a time would be 600 calls and time out.
  const want = Number(size) || RESERVE_SIZE;
  const LOCK_COL = COL['Locked By'], LOCK_W = 4;

  // One agent at a time, or two can reserve the same row.
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (e) { return { error: 'busy, try again' }; }

  try {
    releaseStale_(sheet);

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { leads: [], state: stateCode };

    const data = sheet.getRange(2, 1, lastRow - 1, LEAD_COLS.length).getValues();
    const now = Date.now();

    const iStatus = ix_('Status'), iLockBy = ix_('Locked By');
    const iAtt = ix_('Attempts'), iStart = ix_('Last Call Start');
    const iHold = ix_('Callback Hold Until'), iCbAgent = ix_('Scheduled By');
    const iDonBy = ix_('Donated By');

    // Leads this agent already holds come back to them. Treating their own
    // locks as unavailable meant a refresh reserved a second stack on top of
    // the first, and the leads they were part-way through vanished.
    const mine = [];
    const avail = [];
    data.forEach(function(row, i) {
      const st = String(row[iStatus] || '').toLowerCase();
      if (DIALABLE.indexOf(st) === -1) return;
      if (!canSee_(row, me)) return;                  // not mine to dial

      // Donating puts the lead in the upline's pool, and the upline's id is in
      // the donor's own path — so canSee_ hands it straight back. Giving a
      // lead away has to mean you stop being offered it.
      if (String(row[iDonBy] || '') === String(agent || '')) return;

      const lockedBy = String(row[iLockBy] || '');
      if (lockedBy) {
        if (lockOwnerIsMe_(lockedBy, me)) {
          mine.push({ rowIndex: i + 2, row: row,
                      attempts: Number(row[iAtt]) || 0,
                      last: parseStamp_(row[iStart]) });
        }
        return;                                       // held, by them or someone else
      }

      // A callback stays with the agent who booked it until the hold expires.
      const hold = parseStamp_(row[iHold]);
      if (hold && now < hold && String(row[iCbAgent] || '') !== String(agent || '')) return;

      avail.push({
        rowIndex: i + 2, row: row,
        attempts: Number(row[iAtt]) || 0,
        last: parseStamp_(row[iStart])
      });
    });

    // Never-dialled first, then longest since the last attempt. Within the
    // never-dialled group the order is random: they all tie on both keys, so a
    // plain sort falls back to sheet order and every agent is handed the same
    // top rows, queueing them behind each other's locks. It also means the
    // oldest rows are dialled to death while newer ones are never reached.
    avail.forEach(function(item) { item.shuffle = Math.random(); });
    avail.sort(function(a, b) {
      if (a.attempts === 0 && b.attempts !== 0) return -1;
      if (b.attempts === 0 && a.attempts !== 0) return 1;
      if (a.attempts === 0 && b.attempts === 0) return a.shuffle - b.shuffle;
      return a.last - b.last;
    });

    // Top the existing stack back up to a full one rather than replacing it.
    const fresh = avail.slice(0, Math.max(0, want - mine.length));
    const batch = mine.concat(fresh);
    if (!batch.length) return { leads: [], state: stateCode };

    const nowStr = stamp_();
    const lockId = String((me && me.id) || agent || '');
    const lockRange = sheet.getRange(2, LOCK_COL, lastRow - 1, LOCK_W);
    const lockVals = lockRange.getValues();
    fresh.forEach(function(item) {
      const r = item.rowIndex - 2;
      lockVals[r][0] = lockId;        // Locked By — the id, not the name
      lockVals[r][1] = nowStr;        // Locked At
      lockVals[r][2] = nowStr;        // Last Activity At
    });
    // Held leads keep their original lock time but the idle clock restarts,
    // so a stack cannot expire underneath someone still working it.
    mine.forEach(function(item) { lockVals[item.rowIndex - 2][2] = nowStr; });
    lockRange.setValues(lockVals);
    SpreadsheetApp.flush();
    invalidateStates_(me);

    return {
      state: stateCode,
      leads: batch.map(function(item) {
        return Object.assign({
          rowIndex: item.rowIndex,
          state: stateCode,
          // Only an owner may donate or share, so the card is told rather than
          // guessing from fields it would have to be given anyway.
          ownerIsMe: String(item.row[ix_('Owner ID')] || '') === String(me && me.id || '')
        }, rowToObj(item.row));
      })
    };
  } finally {
    lock.releaseLock();
  }
}

// A reservation dies after IDLE_RELEASE_MS of no activity. An open call holds
// it past that — but only up to OPEN_CALL_CEILING_MS, so a browser that died
// mid-call cannot sit on 150 leads forever.
function releaseStale_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const data = sheet.getRange(2, 1, lastRow - 1, LEAD_COLS.length).getValues();
  const now = Date.now();
  const iLockBy = ix_('Locked By'), iAct = ix_('Last Activity At'), iOpen = ix_('Call Open At');

  const lockRange = sheet.getRange(2, COL['Locked By'], lastRow - 1, 4);
  const lockVals = lockRange.getValues();
  let freed = 0;

  data.forEach(function(row, i) {
    if (!row[iLockBy]) return;
    const openAt = parseStamp_(row[iOpen]);
    if (openAt) {
      if (now - openAt < OPEN_CALL_CEILING_MS) return;   // still on the call
    } else {
      const act = parseStamp_(row[iAct]);
      if (act && now - act < IDLE_RELEASE_MS) return;
    }
    lockVals[i][0] = '';   // Locked By
    lockVals[i][1] = '';   // Locked At
    lockVals[i][3] = '';   // Call Open At
    row[iLockBy] = '';     // so the caller sees it as available in this pass
    freed++;
  });

  // One write, however many were stale. Releasing a 150-lead stack row by row
  // would be 450 calls.
  if (freed) lockRange.setValues(lockVals);
}

// Locks used to hold a display name. Two people sharing one could release and
// disposition each other's stacks, and renaming anyone in Users orphaned their
// reservations — their own leads started refusing their dispositions with
// lead_released. Locks hold the user id now.
//
// Rows locked before the change still carry a name, so both are accepted.
// backfillLockOwners() converts them; this stays until it has run everywhere,
// and is harmless after — ids and names never collide, ids are U-prefixed.
function lockOwnerIsMe_(lockedBy, me) {
  const v = String(lockedBy || '').trim();
  if (!v || !me) return false;
  if (me.id && v === String(me.id)) return true;
  return !!me.name && v === String(me.name).trim();
}

// Same test where only the request body is in hand. doPost puts both the id
// and the name on it from the verified session, never from the client.
function lockOwnerIsBody_(lockedBy, body) {
  return lockOwnerIsMe_(lockedBy, { id: body && body.agentId, name: body && body.agent });
}

function clearLock_(sheet, rowIndex) {
  sheet.getRange(rowIndex, COL['Locked By']).setValue('');
  sheet.getRange(rowIndex, COL['Locked At']).setValue('');
  sheet.getRange(rowIndex, COL['Call Open At']).setValue('');
}

// 'Linda Beno' from parts; falls back to whichever half exists.
function composeName_(first, last) {
  return [String(first || '').trim(), String(last || '').trim()]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

// 'Linda Beno' -> ['Linda', 'Beno']; 'Mary Jo Smith' -> ['Mary', 'Jo Smith'].
function splitName_(full) {
  const parts = String(full || '').trim().replace(/\s+/g, ' ').split(' ');
  if (!parts[0]) return ['', ''];
  if (parts.length === 1) return [parts[0], ''];
  return [parts[0], parts.slice(1).join(' ')];
}

// Written with the offset on it. Formatting in TZ and leaving the zone off
// meant new Date() reparsed the string in whatever timezone the Apps Script
// project is set to — a Pacific stamp read as Central is two hours in the past,
// which made every lead look idle against a fifteen minute limit and released
// whole stacks the moment anyone triggered the sweep.
function stamp_() {
  const d = new Date();
  return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ss") +
         Utilities.formatDate(d, TZ, 'XXX');
}

// Accepts a Date, an offset-bearing stamp, or a bare one written before this
// change — the bare form is read as TZ rather than left to the parser to guess.
function parseStamp_(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const raw = String(v).trim();
  if (!raw) return 0;

  if (/(?:[+-]\d{2}:?\d{2}|Z)$/.test(raw)) {
    const t = Date.parse(raw.replace(' ', 'T'));
    return isNaN(t) ? 0 : t;
  }
  const iso = raw.replace(' ', 'T');
  const naive = Date.parse(iso + 'Z');
  if (isNaN(naive)) { const t = Date.parse(raw); return isNaN(t) ? 0 : t; }
  const t2 = Date.parse(iso + Utilities.formatDate(new Date(naive), TZ, 'XXX'));
  return isNaN(t2) ? naive : t2;
}

function parseCallbackDateTime(dateVal, timeVal) {
  try {
    // fmtDate returns MM/DD/YYYY — convert to ISO YYYY-MM-DD for Date parsing
    const dateStr = fmtDate(dateVal);
    const timeStr = fmtTime(timeVal);
    if (!dateStr || !timeStr) return null;
    const m = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    const iso = m ? (m[3] + '-' + m[1].padStart(2,'0') + '-' + m[2].padStart(2,'0')) : dateStr;
    return new Date(iso + 'T' + timeStr + ':00');
  } catch (e) { return null; }
}

// ══════════════════════════════════════════════════════════════════
// VISIBILITY
// ══════════════════════════════════════════════════════════════════
// Visible if it is in a pool I belong to, or I own it, or it was shared
// with me. Path alone is not enough: admin's id is in everyone's path, so
// without an explicit flag every "exclusive" lead would be admin-visible.
function canSee_(row, me) {
  if (!me) return false;
  const owner  = String(row[ix_('Owner ID')] || '');
  const vis    = String(row[ix_('Visibility')] || VISIBILITY.POOL).toLowerCase();
  const shared = String(row[ix_('Shared With')] || '');

  if (owner === me.id) return true;
  if (shared && shared.split(',').some(function(x) { return x.trim() === me.id; })) return true;
  if (vis === VISIBILITY.EXCLUSIVE) return false;
  if (!owner) return true;                        // unowned: company-wide pool

  // Pool lead: visible when the owner is me or someone above me, i.e. the
  // owner's id appears as a segment of my path. Compare segments, not
  // substrings — 'U1' must not match 'U12'.
  return String(me.path || '').split('>').indexOf(owner) !== -1;
}

// ══════════════════════════════════════════════════════════════════
// DISPOSITIONS — Status changes in place; the row never moves
// ══════════════════════════════════════════════════════════════════
function setStatus_(body, status, extra) {
  const ss = SpreadsheetApp.openById(sheets_()[body.state]);
  const sheet = ss.getSheetByName('Leads');
  const row = Number(body.rowIndex);
  if (!row || row < 2) return { error: 'bad row' };

  // Refuse to record an outcome for a lead this agent no longer holds. Without
  // this, a stack released by an admin or the idle timer could still be
  // dispositioned from a stale tab — overwriting whatever the agent who picked
  // those leads up next had recorded.
  const held = String(sheet.getRange(row, COL['Locked By']).getValue() || '');
  if (held && !lockOwnerIsBody_(held, body)) {
    return { error: 'lead_released' };
  }

  const now = stamp_();
  const write = Object.assign({
    'Status': status,
    'Status At': now,
    'Status By': body.agent || '',
    'Status Reason': body.reason || '',
    'Call Open At': ''          // the call is over; back to the idle clock
  }, extra || {});

  // Log the call that produced this disposition, if there was one.
  if (body.callStart) {
    write['Last Call Agent']    = body.agent || '';
    write['Last Call Start']    = body.callStart;
    write['Last Call End']      = body.callEnd || '';
    write['Last Call Duration'] = body.callDuration || '';
    const cur = Number(sheet.getRange(row, COL['Attempts']).getValue()) || 0;
    write['Attempts'] = cur + 1;
    if (cur + 1 >= REVIEW_THRESHOLD && status === STATUS.NEW) {
      write['Status'] = STATUS.REVIEW;
      write['Status Reason'] = 'Exceeded ' + REVIEW_THRESHOLD + ' attempts';
    }
  }

  Object.keys(write).forEach(function(name) {
    sheet.getRange(row, COL[name]).setValue(write[name]);
  });
  clearLock_(sheet, row);
  sheet.getRange(row, COL['Last Activity At']).setValue(now);
  return { success: true };
}

// NEXT — no disposition, just release and record the attempt.
function actionNext(body) {
  return setStatus_(body, STATUS.NEW, {});
}

function actionDCID(body) {
  return setStatus_(body, STATUS.DCID, {
    'DCID Reason': body.reason || '',
    'DCID Date': stamp_(),
    'DCID Agent': body.agent || '',
    'DCID Review': 'pending'
  });
}

/**
 * Marks a lead as being on a live call.
 *
 * releaseStale_ has always honoured Call Open At — a lead with one set is held
 * for up to two hours instead of fifteen minutes — but nothing ever wrote it,
 * so the branch was dead. On a phone that mattered: dialling backgrounds the
 * browser, iOS suspends its timers, the heartbeat stops, and a call longer than
 * fifteen minutes had the agent's whole stack swept out from under them. They
 * came back to "your leads were released", which reads as being logged out.
 */
function actionCallStarted(me, body) {
  const state = String(body.state || '').toUpperCase();
  if (!sheets_()[state]) return { error: 'bad state' };
  const row = Number(body.rowIndex);
  if (!row || row < 2) return { error: 'bad row' };

  const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
  const held = String(sheet.getRange(row, COL['Locked By']).getValue() || '');
  if (held && !lockOwnerIsBody_(held, body)) return { error: 'lead_released' };

  const now = stamp_();
  const range = sheet.getRange(row, COL['Locked By'], 1, 4);   // cols 6-9
  const v = range.getValues();
  v[0][2] = now;      // Last Activity At
  v[0][3] = now;      // Call Open At
  range.setValues(v);

  // Calls started from the callbacks tab or from search never pass through the
  // dialer, so nothing else would ever record them — an agent who worked only
  // their callbacks showed zero calls. Attempts is deliberately untouched: the
  // disposition owns that count, and incrementing here would double a normal dial.
  if (body.record) {
    writeCells_(sheet, row, {
      'Last Call Agent': body.agent || '',
      'Last Call Start': body.callStart || now
    });
  }
  return { success: true };
}

function actionSold(body) {
  const monthly = Number(String(body.premium || '').replace(/[^0-9.]/g, '')) || 0;
  const followUp = new Date(Date.now() + SOLD_FOLLOWUP_DAYS * 86400000);
  return setStatus_(body, STATUS.SOLD, {
    'Monthly Premium': body.premium || '',
    'AP Amount': monthly * 12,                    // annual premium, for the leaderboard
    'Carrier': body.carrier || '',
    'First Draft Date': body.firstDraft || '',
    'Recurring Draft Date': body.recurringDraft || '',
    'Reason for Policy': body.reason || '',
    'Sale Notes': body.notes || '',
    'Sold Date': stamp_(),
    'Sold Agent': body.agent || '',
    'Follow Up At': Utilities.formatDate(followUp, TZ, 'yyyy-MM-dd')
  });
}

// ══════════════════════════════════════════════════════════════════
// SOLD WORKSPACE — the policies an agent has written, and the ERS
// appointment on each one. Referrals collected at that appointment
// become leads, which is the whole point of running it.
// ══════════════════════════════════════════════════════════════════

// Every sale this user can see, newest first. Scoped exactly like the dial
// queue: your own, plus anyone below you in the tree.
function getSold(me, range) {
  if (!me) return { error: 'auth_required' };
  const cutoff = getRangeCutoff(range || 'all');
  const out = [];

  activeStates_().forEach(function(state) {
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const lr = sheet ? sheet.getLastRow() : 0;
    if (lr < 2) return;
    const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();

    data.forEach(function(row, i) {
      if (String(row[ix_('Status')] || '').toLowerCase() !== STATUS.SOLD) return;
      if (!canSee_(row, me)) return;
      const soldAt = row[ix_('Sold Date')];
      if (cutoff && !dateInRange(soldAt, cutoff)) return;

      out.push({
        state: state,
        rowIndex: i + 2,
        leadId: String(row[ix_('Lead ID')] || ''),
        name: String(row[ix_('Name')] || ''),
        phone: String(row[ix_('Phone')] || ''),
        premium: row[ix_('Monthly Premium')],
        ap: Number(row[ix_('AP Amount')]) || 0,
        carrier: String(row[ix_('Carrier')] || ''),
        firstDraft: fmtDate(row[ix_('First Draft Date')]),
        recurringDraft: String(row[ix_('Recurring Draft Date')] || ''),
        reason: String(row[ix_('Reason for Policy')] || ''),
        notes: String(row[ix_('Sale Notes')] || ''),
        soldDate: fmtDateTime(soldAt),
        soldAgent: String(row[ix_('Sold Agent')] || ''),
        soldSort: parseStamp_(soldAt),
        ersAt: fmtDateTime(row[ix_('ERS At')]),
        ersAtRaw: row[ix_('ERS At')] ? String(row[ix_('ERS At')]) : '',
        ersStatus: String(row[ix_('ERS Status')] || ''),
        ersBy: String(row[ix_('ERS By')] || ''),
        ersNotes: String(row[ix_('ERS Notes')] || ''),
        referrals: Number(row[ix_('Referral Count')]) || 0,
        mine: String(row[ix_('Sold Agent')] || '') === String(me.name || '')
      });
    });
  });

  out.sort(function(a, b) { return b.soldSort - a.soldSort; });

  const totals = out.reduce(function(t, o) {
    t.policies++; t.ap += o.ap;
    if (o.ersStatus === ERS.DONE) t.ersDone++;
    else if (o.ersStatus === ERS.BOOKED) t.ersBooked++;
    else t.ersUnbooked++;
    t.referrals += o.referrals;
    return t;
  }, { policies: 0, ap: 0, ersDone: 0, ersBooked: 0, ersUnbooked: 0, referrals: 0 });

  return { sold: out, totals: totals };
}

// Booking, rescheduling and cancelling are one action — the appointment is a
// single field, and a reschedule is just a different value in it.
function actionBookErs(me, body) {
  const ctx = oneLeadSeen_(me, body);
  if (ctx.error) return ctx;
  if (String(ctx.row[ix_('Status')] || '').toLowerCase() !== STATUS.SOLD) {
    return { error: 'That lead is not a sale.' };
  }

  const when = String(body.ersAt || '').trim();
  if (!when) {                                   // cancelling
    writeCells_(ctx.sheet, ctx.rowIndex, {
      'ERS At': '', 'ERS Status': '', 'ERS By': ''
    });
    logActivity_(me, 'ersCancel', ctx.row[ix_('Name')], body.state);
    return { success: true, ersStatus: '' };
  }

  writeCells_(ctx.sheet, ctx.rowIndex, {
    'ERS At': when,
    'ERS Status': ERS.BOOKED,
    'ERS By': me.name || me.email
  });
  logActivity_(me, 'ersBook', ctx.row[ix_('Name')] + ' @ ' + when, body.state);
  return { success: true, ersStatus: ERS.BOOKED, ersAt: when };
}

function actionCompleteErs(me, body) {
  const ctx = oneLeadSeen_(me, body);
  if (ctx.error) return ctx;
  if (String(ctx.row[ix_('Status')] || '').toLowerCase() !== STATUS.SOLD) {
    return { error: 'That lead is not a sale.' };
  }

  const outcome = String(body.outcome || ERS.DONE);
  if (outcome === ERS.NO_SHOW) {
    writeCells_(ctx.sheet, ctx.rowIndex, {
      'ERS Status': ERS.NO_SHOW,
      'ERS Notes': String(body.notes || '')
    });
    logActivity_(me, 'ersNoShow', ctx.row[ix_('Name')], body.state);
    return { success: true, ersStatus: ERS.NO_SHOW, created: 0 };
  }

  // Referrals are created before the appointment is marked done, so a failure
  // partway leaves the appointment still open rather than silently losing them.
  const made = createReferrals_(me, ctx, body.referrals || []);
  if (made.error) return made;

  const prior = Number(ctx.row[ix_('Referral Count')]) || 0;
  writeCells_(ctx.sheet, ctx.rowIndex, {
    'ERS Status': ERS.DONE,
    'ERS By': me.name || me.email,
    'ERS Notes': String(body.notes || ''),
    'Referral Count': prior + made.created
  });
  logActivity_(me, 'ersComplete',
    ctx.row[ix_('Name')] + ' \u2014 ' + made.created + ' referrals', body.state);

  return { success: true, ersStatus: ERS.DONE, created: made.created, skipped: made.skipped };
}

// A named set of cells on one row, in one write. Callers name columns rather
// than tracking indices, and the span is read back so untouched columns in
// between keep their values.
function writeCells_(sheet, rowIndex, obj) {
  const keys = Object.keys(obj).filter(function(k) { return COL[k]; });
  if (!keys.length) return;
  let lo = Infinity, hi = 0;
  keys.forEach(function(k) { lo = Math.min(lo, COL[k]); hi = Math.max(hi, COL[k]); });
  const range = sheet.getRange(rowIndex, lo, 1, hi - lo + 1);
  const vals = range.getValues();
  keys.forEach(function(k) { vals[0][COL[k] - lo] = obj[k]; });
  range.setValues(vals);
}

// oneLead_ requires ownership, which is right for giving a lead away. Booking
// an ERS appointment is not that — a manager running the appointment for one of
// their agents needs it, and visibility already encodes the tree.
function oneLeadSeen_(me, body) {
  const state = String(body.state || '').toUpperCase();
  if (!sheets_()[state]) return { error: 'Unknown state: ' + state };
  const rowIndex = Number(body.rowIndex);
  if (!rowIndex || rowIndex < 2) return { error: 'Bad row.' };
  const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
  const row = sheet.getRange(rowIndex, 1, 1, LEAD_COLS.length).getValues()[0];
  if (!canSee_(row, me)) return { error: 'not_permitted' };
  return { sheet: sheet, row: row, rowIndex: rowIndex, state: state };
}

// Referrals become real leads in the state they live in, owned by whoever ran
// the appointment. They arrive already dialable — that is the entire point.
//
// A referral with no usable phone is skipped rather than written, because a
// lead nobody can call is just a row that gets dialled at forever.
function createReferrals_(me, ctx, list) {
  if (!list || !list.length) return { created: 0, skipped: [] };

  const sourceId = String(ctx.row[ix_('Lead ID')] || '');
  const byState = {}, skipped = [];

  list.forEach(function(r) {
    const name  = String(r.name || '').trim();
    const phone = String(r.phone || '').replace(/\D/g, '');
    if (!name)            { skipped.push('(no name)'); return; }
    if (phone.length < 10) { skipped.push(name + ' (no usable phone)'); return; }

    const st = String(r.state || ctx.state || '').toUpperCase();
    if (!US_STATES[st])   { skipped.push(name + ' (unknown state ' + st + ')'); return; }
    if (!ensureStateSheet_(st)) { skipped.push(name + ' (could not open ' + st + ')'); return; }

    (byState[st] = byState[st] || []).push({ name: name, phone: phone, r: r });
  });

  let created = 0;
  const now = stamp_();

  Object.keys(byState).forEach(function(st) {
    const sheet = SpreadsheetApp.openById(sheets_()[st]).getSheetByName('Leads');
    const seq0 = nextLeadSeq_(sheet, st);
    const rows = byState[st].map(function(item, n) {
      const row = new Array(LEAD_COLS.length).fill('');
      const parts = splitName_(item.name);
      row[ix_('Lead ID')]      = st + '-' + ('000000' + (seq0 + n)).slice(-6);
      row[ix_('Status')]       = STATUS.NEW;
      row[ix_('Visibility')]   = VISIBILITY.EXCLUSIVE;   // earned, not pooled
      row[ix_('Owner ID')]     = me.id || '';
      row[ix_('Name')]         = item.name;
      row[ix_('First Name')]   = parts[0];
      row[ix_('Last Name')]    = parts[1];
      row[ix_('Phone')]        = item.phone;
      row[ix_('State')]        = st;
      row[ix_('Email')]        = String(item.r.email || '');
      row[ix_('Date Added')]   = now;
      row[ix_('Lead Source')]  = 'ERS Referral';
      row[ix_('Uploaded By')]  = me.name || me.email;
      row[ix_('Referred By')]  = sourceId;
      return row;
    });

    const at = sheet.getLastRow() + 1;
    sheet.getRange(at, COL['Phone'], rows.length, 1).setNumberFormat('@');
    sheet.getRange(at, 1, rows.length, LEAD_COLS.length).setValues(rows);
    bumpStateCount_(st, rows.length);
    created += rows.length;
  });

  if (created) invalidateStates_(me);
  return { created: created, skipped: skipped };
}

function actionWrong(body) {
  return setStatus_(body, STATUS.WRONG, {
    'Wrong Number Date': stamp_(),
    'Wrong Number Agent': body.agent || ''
  });
}

function actionCallback(body) {
  // Store the date as MM/DD/YYYY text. Sheets parses bare date strings in the
  // spreadsheet's timezone, which shifts them a day; text never moves.
  const iso = String(body.callbackDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const dateVal = iso ? (iso[2] + '/' + iso[3] + '/' + iso[1]) : (body.callbackDate || '');
  const timeVal = body.callbackTime || '';

  const res = setStatus_(body, STATUS.CALLBACK, {
    'Callback Date': dateVal,
    'Callback Time': timeVal,
    'Scheduled By': body.agent || '',
    'Scheduled Date': stamp_(),
    // The booking agent keeps first claim for 72 hours past the appointment.
    'Callback Hold Until': holdUntil_(dateVal, timeVal)
  });

  try {
    const sheet = SpreadsheetApp.openById(sheets_()[body.state]).getSheetByName('Leads');
    sheet.getRange(body.rowIndex, COL['Callback Date']).setNumberFormat('@').setValue(dateVal);
    sheet.getRange(body.rowIndex, COL['Callback Time']).setNumberFormat('@').setValue(timeVal);
  } catch (e) {}
  return res;
}

function holdUntil_(dateVal, timeVal) {
  const dt = parseCallbackDateTime(dateVal, timeVal);
  if (!dt) return '';
  return Utilities.formatDate(new Date(dt.getTime() + CALLBACK_HOLD_MS), TZ, 'yyyy-MM-dd HH:mm:ss');
}

function actionReturnToPool(body) {
  return setStatus_(body, STATUS.NEW, {
    'Callback Date': '', 'Callback Time': '',
    'Callback Hold Until': '', 'Scheduled By': ''
  });
}

// ══════════════════════════════════════════════════════════════════
// RELEASE — end a dial session
// ══════════════════════════════════════════════════════════════════
function actionReleaseAll(body) {
  activeStates_().forEach(function(state) {
    releaseAgentLocks(SpreadsheetApp.openById(sheets_()[state]), body.agent, body.agentId);
  });
  return { success: true };
}

// Releasing someone else's locks, so the target cannot come from body.agent —
// doPost overwrites that with the caller's own name to stop clients claiming an
// identity, which meant this quietly released the admin's own leads instead.
function actionForceRelease(me, body) {
  if (!me || (me.role !== 'admin' && me.role !== 'manager')) return { error: 'not_permitted' };

  const target = String(body.target || '').trim();
  if (!target) return { error: 'No agent named.' };

  // The list sends the id alongside the name. An older cached client sends only
  // the name, so fall back to looking it up — without an id this frees nothing,
  // because locks are keyed on the id now.
  let targetId = String(body.targetId || '').trim();
  if (!targetId) {
    const u = usersAll_().filter(function(x) {
      return String(x.name || '').trim().toLowerCase() === target.toLowerCase();
    })[0];
    if (u) targetId = u.id;
  }

  // A manager may only do this to their own branch.
  if (me.role !== 'admin' && !inScope_(scopeNamesFor_(me), target)) {
    return { error: 'That agent is not in your team.' };
  }

  const states = body.state ? [body.state] : activeStates_();
  let freed = 0;
  states.forEach(function(state) {
    if (!sheets_()[state]) return;
    freed += releaseAgentLocks(SpreadsheetApp.openById(sheets_()[state]), target, targetId);
  });
  logActivity_(me, 'forceRelease', target + ' (' + freed + ')', body.state || '');
  return { success: true, released: freed, agent: target };
}

// How many leads this user is holding right now. One narrow column read, so
// the dialer can poll it without cost — it is how an agent finds out their
// stack was pulled while they were sitting on it.
function heartbeat_(user, stateCode) {
  const code = String(stateCode || '').toUpperCase();
  if (!sheets_()[code]) return { held: 0 };
  const sheet = SpreadsheetApp.openById(sheets_()[code]).getSheetByName('Leads');
  const lr = sheet ? sheet.getLastRow() : 0;
  if (lr < 2) return { held: 0 };

  // Locked By, Locked At, Last Activity At, Call Open At are columns 6-9.
  const range = sheet.getRange(2, COL['Locked By'], lr - 1, 4);
  const vals = range.getValues();
  const mine = [];
  vals.forEach(function(r, i) {
    if (lockOwnerIsMe_(r[0], user)) mine.push(i);
  });
  if (!mine.length) return { held: 0 };

  // Only the lead an agent dispositions gets its activity refreshed, so the
  // rest of a 150-lead stack goes stale after fifteen minutes even while they
  // are working it — and the sweep takes the leads out from under them.
  // The dialer polls this every ten seconds, so an open tab is proof of work.
  // Throttled: one write every four minutes per agent, not one every poll.
  try {
    const cache = CacheService.getScriptCache();
    const key = 'touch_' + code + '_' + String(user.id || user.name || '');
    if (!cache.get(key)) {
      cache.put(key, '1', 240);
      const now = stamp_();
      mine.forEach(function(i) { vals[i][2] = now; });   // Last Activity At
      range.setValues(vals);
    }
  } catch (e) { /* keeping the stack alive is not worth failing the poll over */ }

  return { held: mine.length };
}

// `who` is an id or a display name — sign-out passes the session's own, an
// admin force-release passes whatever the team list showed. Both must match
// rows locked before and after the id change.
function releaseAgentLocks(ss, who, whoId) {
  const sheet = ss.getSheetByName('Leads');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const lockRange = sheet.getRange(2, COL['Locked By'], lastRow - 1, 4);
  const lockVals = lockRange.getValues();
  let freed = 0;
  const target = { id: whoId || '', name: who || '' };
  lockVals.forEach(function(r) {
    if (!lockOwnerIsMe_(r[0], target)) return;
    r[0] = ''; r[1] = ''; r[3] = '';
    freed++;
  });
  // Signing out of a 150-lead stack is one write, not four hundred and fifty.
  if (freed) lockRange.setValues(lockVals);
  return freed;
}

// ══════════════════════════════════════════════════════════════════
// SEARCH — across all states, Leads + Callbacks tabs
// ══════════════════════════════════════════════════════════════════
function search(query, me) {
  if (!query || query.length < 2) return { results: [] };
  const digits = query.replace(/\D/g, '');
  const qName  = query.toLowerCase();
  const results = [];

  activeStates_().forEach(function(state) {
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const data = sheet.getRange(2, 1, lastRow - 1, LEAD_COLS.length).getValues();
    data.forEach(function(row, i) {
      if (!canSee_(row, me)) return;
      const nameHit  = String(row[ix_('Name')] || '').toLowerCase().indexOf(qName) !== -1;
      const phoneHit = digits && String(row[ix_('Phone')] || '').replace(/\D/g, '').indexOf(digits) !== -1;
      if (!nameHit && !phoneHit) return;
      results.push(Object.assign({ rowIndex: i + 2, state: state }, rowToObj(row)));
    });
  });
  return { results: results.slice(0, 25) };
}

// ══════════════════════════════════════════════════════════════════
// MY CALLBACKS — agent's unresolved callbacks across all states
// ══════════════════════════════════════════════════════════════════
function myCallbacks(agent, me) {
  const results = [];
  activeStates_().forEach(function(state) {
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const data = sheet.getRange(2, 1, lastRow - 1, LEAD_COLS.length).getValues();
    data.forEach(function(row, i) {
      if (String(row[ix_('Status')] || '').toLowerCase() !== STATUS.CALLBACK) return;
      if (String(row[ix_('Scheduled By')] || '') !== String(agent || '')) return;
      results.push(Object.assign({ rowIndex: i + 2, state: state }, rowToObj(row)));
    });
  });
  return { callbacks: results };
}

// ══════════════════════════════════════════════════════════════════
// LEADERBOARD — today's top performers
// ══════════════════════════════════════════════════════════════════
function leaderboard(range) {
  // Company-wide by design — everything else scopes to a downline, this does not.
  const out = adminStats(range || 'today', null);
  return {
    range: out.range,
    leaderboard: out.agents.sort(function(a, b) {
      return b.ap - a.ap || b.sales - a.sales || b.calls - a.calls;
    })
  };
}

// ══════════════════════════════════════════════════════════════════
// ADMIN STATS — per state counts, aggregates, per-agent breakdown
// ══════════════════════════════════════════════════════════════════
function scopeNamesFor_(me) {
  if (!me) return null;
  if (me.role === 'admin') return null;                 // null = no filter
  // Both keys: disposition columns still record names, but Locked By is an id
  // now, and inProgress is counted from it.
  const set = {};
  downlineOf_(me, true).forEach(function(u) {
    if (u.name) set[String(u.name).trim().toLowerCase()] = true;
    if (u.id)   set[String(u.id).trim().toLowerCase()]   = true;
  });
  return set;
}

function inScope_(scope, agentName) {
  if (!scope) return true;                              // admin, or unscoped
  return !!scope[String(agentName || '').trim().toLowerCase()];
}

function blankAgent_(name) {
  return { agent: name, calls: 0, sales: 0, dcid: 0, wrong: 0, callbacks: 0, ap: 0, lastActive: '' };
}

function bump_(agents, name, key, when) {
  if (!name) return;
  agents[name] = agents[name] || blankAgent_(name);
  agents[name][key]++;
  const d = fmtDateTime(when);
  if (d && (!agents[name].lastActive || d > agents[name].lastActive)) agents[name].lastActive = d;
}

function adminStats(range, scope) {
  const cutoff = getRangeCutoff(range || 'today');
  const perState = {};
  const totals = { calls: 0, sales: 0, dcid: 0, wrong: 0, callbacks: 0, ap: 0 };
  const agents = {};

  activeStates_().forEach(function(state) {
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const st = { available: 0, inProgress: 0, callbacks: 0, dcid: 0, sold: 0, wrong: 0, review: 0 };
    const lr = sheet.getLastRow();

    if (lr >= 2) {
      const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
      data.forEach(function(row) {
        const status = String(row[ix_('Status')] || '').toLowerCase();
        const lockedBy = row[ix_('Locked By')];

        // Live pool counts.
        if (lockedBy) { if (inScope_(scope, lockedBy)) st.inProgress++; }
        else if (DIALABLE.indexOf(status) !== -1) st.available++;

        // Calls in range — recorded on the lead whatever it was dispositioned as.
        const callAt = row[ix_('Last Call Start')], callBy = row[ix_('Last Call Agent')];
        if (callAt && dateInRange(callAt, cutoff) && inScope_(scope, callBy)) {
          totals.calls++;
          bump_(agents, callBy, 'calls', callAt);
        }

        // Dispositions in range, each dated and attributed by its own columns.
        const disp = [
          [STATUS.SOLD,     'Sold Date',         'Sold Agent',         'sold',      'sales'],
          [STATUS.DCID,     'DCID Date',         'DCID Agent',         'dcid',      'dcid'],
          [STATUS.WRONG,    'Wrong Number Date', 'Wrong Number Agent', 'wrong',     'wrong'],
          [STATUS.CALLBACK, 'Scheduled Date',    'Scheduled By',       'callbacks', 'callbacks']
        ];
        disp.forEach(function(d) {
          if (status !== d[0]) return;
          const at = row[ix_(d[1])], by = row[ix_(d[2])];
          if (!at || !dateInRange(at, cutoff) || !inScope_(scope, by)) return;
          st[d[3]]++;
          totals[d[4]]++;
          bump_(agents, by, d[4], at);
          if (d[0] === STATUS.SOLD) {
            const ap = Number(row[ix_('AP Amount')]) || 0;
            totals.ap += ap;
            if (by) { agents[by] = agents[by] || blankAgent_(by); agents[by].ap += ap; }
          }
        });

        if (status === STATUS.REVIEW) st.review++;
      });
    }
    perState[state] = st;
  });

  return {
    range: range || 'today',
    perState: perState,
    totals: totals,
    agents: Object.keys(agents).map(function(k) { return agents[k]; })
              .sort(function(a, b) { return b.sales - a.sales || b.calls - a.calls; })
  };
}

function getRangeCutoff(range) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // start of today
  switch (range) {
    case 'today': return d;
    case 'week':
      const wd = new Date(d);
      wd.setDate(d.getDate() - d.getDay());
      return wd;
    case 'month': return new Date(now.getFullYear(), now.getMonth(), 1);
    case 'ytd': return new Date(now.getFullYear(), 0, 1);
    case 'all': return new Date(2000, 0, 1);
    default: return d;
  }
}

function dateInRange(val, cutoff) {
  if (!val) return false;
  const dt = (val instanceof Date) ? val : new Date(val);
  return dt.getTime() >= cutoff.getTime();
}

// Converts rows locked under a display name to the owner's id. Safe to run
// repeatedly, and safe to run while agents are dialling — a converted row is
// still recognised as theirs, because lockOwnerIsMe_ accepts either form.
//
// A name matching no user, or matching two, is left alone and reported. Those
// are the rows that would have been silently mis-attributed all along; releasing
// them is a judgement call, so this does not make it.
function backfillLockOwners() {
  const byName = {};
  usersAll_().forEach(function(u) {
    const k = String(u.name || '').trim().toLowerCase();
    if (!k) return;
    byName[k] = byName[k] ? 'AMBIGUOUS' : u.id;
  });

  const converted = {}, unmatched = {}, ambiguous = {};
  let rows = 0;

  activeStates_().forEach(function(state) {
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const lr = sheet ? sheet.getLastRow() : 0;
    if (lr < 2) return;
    const range = sheet.getRange(2, COL['Locked By'], lr - 1, 1);
    const vals = range.getValues();
    let touched = 0;

    vals.forEach(function(r) {
      const v = String(r[0] || '').trim();
      if (!v) return;
      if (/^U\d+$/i.test(v)) return;                  // already an id
      rows++;
      const hit = byName[v.toLowerCase()];
      if (!hit)                { unmatched[v] = (unmatched[v] || 0) + 1; return; }
      if (hit === 'AMBIGUOUS') { ambiguous[v] = (ambiguous[v] || 0) + 1; return; }
      r[0] = hit;
      converted[v] = (converted[v] || 0) + 1;
      touched++;
    });

    if (touched) range.setValues(vals);               // one write per state
  });

  const fmt = function(o) {
    const k = Object.keys(o);
    return k.length ? k.map(function(n) { return n + ' \u00d7' + o[n]; }).join(', ') : 'none';
  };
  const msg = [
    'Name-keyed locks found: ' + rows,
    'Converted:  ' + fmt(converted),
    'Unmatched:  ' + fmt(unmatched) + '   (left as-is — no such user)',
    'Ambiguous:  ' + fmt(ambiguous) + '   (left as-is — two users share the name)'
  ].join('\n');
  Logger.log(msg);
  return msg;
}

// Widens every state sheet to the current schema and rewrites the header.
// Adding columns to LEAD_COLS does nothing until this has run — reads past the
// old width come back empty and writes land outside the sheet.
function migrateSchemaColumns() {
  const report = [];
  Object.keys(sheets_()).forEach(function(state) {
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    if (!sheet) { report.push(state + ': no Leads tab'); return; }
    const had = sheet.getMaxColumns();
    if (had < LEAD_COLS.length) sheet.insertColumnsAfter(had, LEAD_COLS.length - had);
    sheet.getRange(1, 1, 1, LEAD_COLS.length)
         .setValues([LEAD_COLS]).setFontWeight('bold').setBackground('#e8f0fe');
    report.push(state + ': ' + had + ' \u2192 ' + LEAD_COLS.length);
  });
  const msg = 'Schema now ' + LEAD_COLS.length + ' columns.\n' + report.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * The contactable leads of one batch, for Autopilot to work.
 *
 * Only rows the caller can see, only ones still dialable, and never a lead
 * someone is holding — pulling a lead into an email sequence while an agent has
 * it reserved means the prospect hears from both at once.
 */
function apiBatchLeads_(me, batchId) {
  if (!batchId) return { error: 'no batch' };
  const out = [];
  activeStates_().forEach(function(state) {
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const lr = sheet ? sheet.getLastRow() : 0;
    if (lr < 2) return;
    const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
    data.forEach(function(row) {
      if (String(row[ix_('Batch ID')] || '') !== batchId) return;
      if (String(row[ix_('Batch Status')] || '').toLowerCase() === 'removed') return;
      if (DIALABLE.indexOf(String(row[ix_('Status')] || '').toLowerCase()) === -1) return;
      if (row[ix_('Locked By')]) return;
      if (!canSee_(row, me)) return;
      out.push({
        leadId: String(row[ix_('Lead ID')] || ''),
        firstName: String(row[ix_('First Name')] || ''),
        lastName: String(row[ix_('Last Name')] || ''),
        email: String(row[ix_('Email')] || ''),
        phone: String(row[ix_('Phone')] || ''),
        state: String(row[ix_('State')] || ''),
        source: String(row[ix_('Lead Source')] || '')
      });
    });
  });
  return { batchId: batchId, leads: out, count: out.length };
}

/**
 * How many stored numbers the old dialler would have sent abroad.
 *
 * The bug only affected numbers stored as ten digits: "4402415268" became
 * +44 0241 5268, the United Kingdom. A number stored with its leading 1 —
 * "12163335916" — produced +1 216 333 5916 and dialled correctly, which is why
 * the ten wrong-number leads from 24 August turned out to be genuine.
 *
 * This counts both shapes so the real exposure is known rather than guessed.
 */
function misdialExposure() {
  const tally = { ten: 0, eleven: 0, other: 0, sample: [] };
  activeStates_().forEach(function(state) {
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const lr = sheet ? sheet.getLastRow() : 0;
    if (lr < 2) return;
    const nums = sheet.getRange(2, COL['Phone'], lr - 1, 1).getValues();
    nums.forEach(function(r, i) {
      const d = String(r[0] || '').replace(/\D/g, '');
      if (!d) return;
      if (d.length === 10) {
        tally.ten++;
        if (tally.sample.length < 8) {
          tally.sample.push(state + ' row ' + (i + 2) + '  ' + d +
                            '  would have dialled +' + d.slice(0, 3) + '\u2026');
        }
      } else if (d.length === 11 && d.charAt(0) === '1') tally.eleven++;
      else tally.other++;
    });
  });
  const total = tally.ten + tally.eleven + tally.other;
  const msg = [
    'Stored phone shapes across every state sheet:',
    '  ten digits   ' + tally.ten + '   <- these misdialled internationally',
    '  1 + ten      ' + tally.eleven + '   dialled correctly all along',
    '  anything else ' + tally.other,
    '  total        ' + total,
    '',
    tally.ten ? 'Examples of what went abroad:' : 'Nothing was affected.',
    tally.sample.join('\n')
  ].join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * Undoes wrong-number dispositions caused by the international dialling bug.
 *
 * Until 2026-08-24 every tel: link prefixed a bare "+" to a ten-digit number,
 * so the phone read the area code as a country code — (216) dialled Tunisia,
 * (440) the United Kingdom, (220) Gambia. Agents heard the wrong person, or
 * nobody, and marked the lead as a wrong number. The numbers were fine.
 *
 * CHECK THE NUMBERS BEFORE RESTORING. Only leads stored as ten digits were
 * misdialled; one stored as 1 + ten digits dialled correctly, so a wrong number
 * on one of those is genuine and restoring it puts a dead number back in the
 * pool. Run misdialExposure() first to see which shape your data is in.
 *
 * Call with no arguments to see what would change. Nothing is written until
 * confirm is true.
 *
 *   restoreWrongNumbers()                          // list them
 *   restoreWrongNumbers('2026-08-24')              // list that day only
 *   restoreWrongNumbers('2026-08-24', '', true)    // actually restore
 */
function restoreWrongNumbers(onDate, agentName, confirm) {
  const day   = String(onDate || '').trim();
  const who   = String(agentName || '').trim().toLowerCase();
  const found = [];

  activeStates_().forEach(function(state) {
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const lr = sheet ? sheet.getLastRow() : 0;
    if (lr < 2) return;
    const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();

    data.forEach(function(row, i) {
      if (String(row[ix_('Status')] || '').toLowerCase() !== STATUS.WRONG) return;
      const at = String(row[ix_('Wrong Number Date')] || '');
      const by = String(row[ix_('Wrong Number Agent')] || '');
      if (day && at.indexOf(day) !== 0) return;
      if (who && by.toLowerCase() !== who) return;

      found.push({
        state: state, rowIndex: i + 2,
        name: String(row[ix_('Name')] || ''),
        phone: String(row[ix_('Phone')] || ''),
        by: by, at: at
      });
    });
  });

  if (confirm) {
    found.forEach(function(f) {
      const sheet = SpreadsheetApp.openById(sheets_()[f.state]).getSheetByName('Leads');
      // Back to the pool, and the wrong-number stamps cleared so the stats stop
      // counting them. Attempts is left alone — the dial did happen.
      writeCells_(sheet, f.rowIndex, {
        'Status': STATUS.NEW,
        'Status Reason': 'Restored — misdialled internationally by the CRM',
        'Status At': stamp_(),
        'Wrong Number Date': '',
        'Wrong Number Agent': '',
        'Locked By': '', 'Locked At': '', 'Call Open At': ''
      });
    });
    invalidateStates_(null);
    recountStates();
  }

  const lines = found.map(function(f) {
    return '  ' + f.state + ' row ' + f.rowIndex + '  ' +
           (f.name || '(no name)') + '  ' + f.phone + '  by ' + f.by + '  ' + f.at;
  });
  const msg = (confirm ? 'RESTORED ' : 'WOULD RESTORE ') + found.length +
              ' wrong-number leads' +
              (day ? ' from ' + day : '') + (who ? ' by ' + agentName : '') + '\n' +
              lines.join('\n') +
              (confirm ? '' : '\n\nNothing written. Re-run with confirm = true to apply.');
  Logger.log(msg);
  return msg;
}

// ══════════════════════════════════════════════════════════════════
// TRELLUS RECEIVER
//
// Trellus takes over the call button, places the call, and posts the result
// back. They post from a browser extension with an Authorization header, which
// forces a CORS preflight that Apps Script cannot answer — there is no doOptions.
// So a Cloudflare Worker sits in front, answers the preflight, checks the bearer
// token and forwards here. This endpoint therefore trusts its caller and must
// never be given out directly; the Worker URL is what Trellus receives.
//
// Retries are expected. Every event carries a session id, and the same session
// is applied once and then acknowledged, so a duplicate delivery is a no-op
// rather than a second disposition on the same lead.
// ══════════════════════════════════════════════════════════════════

const TRELLUS_SHARED_SECRET_PROP = 'TRELLUS_SECRET';
const PROCESSED_TAB = 'ProcessedEvents';

// Trellus's outcome vocabulary → ours. Anything unrecognised is recorded as a
// call and left for a human, rather than guessed into a disposition that takes
// the lead out of the pool.
const TRELLUS_OUTCOMES = {
  'sale': STATUS.SOLD, 'sold': STATUS.SOLD,
  'not_interested': STATUS.DCID, 'dnc': STATUS.DCID, 'do_not_call': STATUS.DCID,
  'wrong_number': STATUS.WRONG, 'bad_number': STATUS.WRONG,
  'callback': STATUS.CALLBACK, 'scheduled': STATUS.CALLBACK,
  'no_answer': '', 'voicemail': '', 'busy': '', 'failed': '', 'abandoned': ''
};

function processedTab_() {
  const ss = authSS_();
  let sh = ss.getSheetByName(PROCESSED_TAB);
  if (!sh) {
    sh = ss.insertSheet(PROCESSED_TAB);
    sh.appendRow(['Key', 'At', 'Lead ID', 'Outcome', 'Rep', 'Result']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function alreadyProcessed_(key) {
  const sh = processedTab_();
  const lr = sh.getLastRow();
  if (lr < 2) return false;
  const keys = sh.getRange(2, 1, lr - 1, 1).getValues();
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === key) return true;
  }
  return false;
}

function actionTrellusEvent(body) {
  const secret = PropertiesService.getScriptProperties()
    .getProperty(TRELLUS_SHARED_SECRET_PROP);
  if (!secret || String(body.secret || '') !== secret) return { error: 'not_permitted' };

  const sessionId = String(body.session_id || '').trim();
  if (!sessionId) return { error: 'no session_id' };
  const key = 'call.completed:' + sessionId;

  // Acknowledged, not re-applied. A retry must not disposition twice.
  if (alreadyProcessed_(key)) return { success: true, duplicate: true };

  const leadId = String(body.lead_id || '').trim().toUpperCase();
  if (!leadId) return { error: 'no lead_id' };

  const found = leadRowById_(leadId);
  if (!found) return { error: 'not_found' };

  // rep_email may be someone we do not have. The call still happened and still
  // belongs on the lead — it is the credit that goes nowhere, not the record.
  const rep = String(body.rep_email || '').trim().toLowerCase();
  const who = rep ? userByEmail_(rep) : null;
  const repName = who ? who.name : '';

  const outcome = String(body.outcome || '').trim().toLowerCase();
  const status = TRELLUS_OUTCOMES.hasOwnProperty(outcome) ? TRELLUS_OUTCOMES[outcome] : null;

  const now = stamp_();
  const write = {
    'Last Call Agent': repName || rep || 'Trellus',
    'Last Call Start': body.started_at || now,
    'Last Call End': body.ended_at || '',
    'Last Call Duration': body.duration || '',
    'Call Open At': ''
  };
  const cur = Number(found.sheet.getRange(found.rowIndex, COL['Attempts']).getValue()) || 0;
  write['Attempts'] = cur + 1;

  let applied = 'call recorded';
  if (status) {
    write['Status'] = status;
    write['Status At'] = now;
    write['Status By'] = repName || rep || 'Trellus';
    write['Status Reason'] = 'Trellus: ' + outcome;
    applied = status;
    if (status === STATUS.WRONG) {
      write['Wrong Number Date'] = now;
      write['Wrong Number Agent'] = repName || rep || 'Trellus';
    }
  } else if (status === null) {
    // Unrecognised vocabulary. Record the call, flag it, disposition nothing.
    write['Status Reason'] = 'Trellus sent an unknown outcome: ' + outcome;
    applied = 'unknown outcome — left for a human';
  }
  writeCells_(found.sheet, found.rowIndex, write);

  processedTab_().appendRow([key, now, leadId, outcome,
                             rep + (who ? '' : ' (unattributed)'), applied]);
  logActivity_({ email: rep, name: repName || 'Trellus', role: 'system' },
               'trellusCall', leadId + ' — ' + applied, found.state);

  return { success: true, applied: applied, attributed: !!who };
}

// Sheet-level lookup with no visibility check — the caller is the Worker, not a
// user, and it has already been authenticated by the shared secret.
function leadRowById_(leadId) {
  const guess = leadId.split('-')[0];
  const order = sheets_()[guess] ? [guess].concat(activeStates_().filter(function(s) {
    return s !== guess; })) : activeStates_();
  for (let n = 0; n < order.length; n++) {
    const state = order[n];
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const lr = sheet ? sheet.getLastRow() : 0;
    if (lr < 2) continue;
    const ids = sheet.getRange(2, COL['Lead ID'], lr - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || '').trim().toUpperCase() === leadId) {
        return { sheet: sheet, rowIndex: i + 2, state: state };
      }
    }
  }
  return null;
}

/**
 * Undoes what the Trellus relay tests wrote.
 *
 * Testing against a real lead is the only way to know the chain works, but it
 * leaves that lead looking dialled — Attempts up, a call agent, a status reason
 * — and leaves the test session keys claimed so the same ids cannot be reused.
 *
 * Lists what it would do; writes nothing until confirm is true.
 *
 *   cleanupTrellusTests('OH-000513')                 // show
 *   cleanupTrellusTests('OH-000513', 'qa-', true)    // do it
 */
function cleanupTrellusTests(leadId, keyPrefix, confirm) {
  const id = String(leadId || '').trim().toUpperCase();
  const prefix = String(keyPrefix === undefined ? 'qa-' : keyPrefix);
  const out = [];

  if (id) {
    const found = leadRowById_(id);
    if (!found) {
      out.push('No lead ' + id);
    } else {
      const row = found.sheet.getRange(found.rowIndex, 1, 1, LEAD_COLS.length).getValues()[0];
      out.push('Lead ' + id + ' (' + found.state + ' row ' + found.rowIndex + ')');
      out.push('  Attempts        ' + row[ix_('Attempts')] + '  -> blank');
      out.push('  Last Call Agent ' + row[ix_('Last Call Agent')] + '  -> blank');
      out.push('  Status          ' + row[ix_('Status')] + '  (left alone)');
      if (confirm) {
        writeCells_(found.sheet, found.rowIndex, {
          'Attempts': '', 'Last Call Agent': '', 'Last Call Start': '',
          'Last Call End': '', 'Last Call Duration': '', 'Status Reason': ''
        });
      }
    }
  }

  // Delete bottom-up: removing a row shifts everything below it up, and a
  // top-down loop would skip the row that moved into the deleted index.
  const sh = processedTab_();
  const lr = sh.getLastRow();
  let removed = 0;
  if (lr > 1) {
    const keys = sh.getRange(2, 1, lr - 1, 1).getValues();
    for (let i = keys.length - 1; i >= 0; i--) {
      const k = String(keys[i][0] || '');
      if (k.indexOf('call.completed:' + prefix) !== 0) continue;
      out.push('  event ' + k + '  -> delete');
      removed++;
      if (confirm) sh.deleteRow(i + 2);
    }
  }

  const msg = (confirm ? 'CLEANED UP' : 'WOULD CLEAN UP') + '\n' + out.join('\n') +
              '\n' + removed + ' test events' +
              (confirm ? '' : '\n\nNothing written. Re-run with confirm = true.');
  Logger.log(msg);
  return msg;
}

/** Run once from the editor to mint the secret the Worker will carry. */
function setupTrellus() {
  const props = PropertiesService.getScriptProperties();
  let sec = props.getProperty(TRELLUS_SHARED_SECRET_PROP);
  if (!sec) {
    sec = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty(TRELLUS_SHARED_SECRET_PROP, sec);
  }
  processedTab_();
  const msg = 'Trellus receiver ready.\n\nShared secret (put this in the Cloudflare\n' +
              'Worker, never in the repo and never to Trellus):\n\n  ' + sec +
              '\n\nTrellus gets the Worker URL and their own bearer token, which the\n' +
              'Worker checks before forwarding.';
  Logger.log(msg);
  return msg;
}

// ══════════════════════════════════════════════════════════════════
// ADDRESSABLE LEADS
//
// A lead has to be reachable by its id alone for anything outside this app to
// point at it — a dialer taking over the call button, a link in an email, a
// webhook writing a result back. Lead IDs are stable for life precisely because
// rows never move, which is what makes this safe.
// ══════════════════════════════════════════════════════════════════

/**
 * Finds a lead anywhere by its Lead ID. The id carries its state as a prefix
 * (OH-000513), so the right book is opened directly instead of reading fifty.
 */
function leadById_(me, leadId) {
  if (!me) return { error: 'auth_required' };
  const id = String(leadId || '').trim().toUpperCase();
  if (!id) return { error: 'no lead id' };

  const guess = id.split('-')[0];
  const order = sheets_()[guess] ? [guess].concat(activeStates_().filter(function(s) {
    return s !== guess; })) : activeStates_();

  for (let n = 0; n < order.length; n++) {
    const state = order[n];
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const lr = sheet ? sheet.getLastRow() : 0;
    if (lr < 2) continue;
    const ids = sheet.getRange(2, COL['Lead ID'], lr - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || '').trim().toUpperCase() !== id) continue;
      const row = sheet.getRange(i + 2, 1, 1, LEAD_COLS.length).getValues()[0];
      if (!canSee_(row, me)) return { error: 'not_permitted' };
      // Same shape every other reader returns, so the UI needs no special case.
      return { lead: Object.assign({ rowIndex: i + 2, state: state }, rowToObj(row)) };
    }
  }
  return { error: 'not_found' };
}

// ══════════════════════════════════════════════════════════════════
// ADMIN LOCKS — live view of who has what locked
// ══════════════════════════════════════════════════════════════════
function adminLocks(scope) {
  const locks = [];
  // Locked By is an id now, so the admin list would read "U007" without this.
  // Names are resolved once per call, not once per row.
  const nameCache = {};
  const ownerName = function(v) {
    const key = String(v || '');
    if (!key) return '';
    if (!(key in nameCache)) {
      const u = /^U\d+$/i.test(key) ? userById_(key) : null;
      nameCache[key] = (u && u.name) || key;    // legacy rows already hold a name
    }
    return nameCache[key];
  };
  activeStates_().forEach(state => {
    const ss = SpreadsheetApp.openById(sheets_()[state]);
    const sheet = ss.getSheetByName('Leads');
    const lr = sheet.getLastRow();
    if (lr < 2) return;
    const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
    const lockedByIdx = LEAD_COLS.indexOf('Locked By');
    const lockedAtIdx = LEAD_COLS.indexOf('Locked At');
    const nameIdx = LEAD_COLS.indexOf('Name');
    data.forEach((row, i) => {
      if (row[lockedByIdx] && inScope_(scope, row[lockedByIdx])) {
        locks.push({
          state: state,
          rowIndex: i + 2,
          name: row[nameIdx],
          agent: ownerName(row[lockedByIdx]),
          agentId: String(row[lockedByIdx] || ''),
          lockedAt: fmtDateTime(row[lockedAtIdx])
        });
      }
    });
  });
  // Group by agent
  const byAgent = {};
  locks.forEach(l => {
    byAgent[l.agent] = byAgent[l.agent] ||
      { agent: l.agent, agentId: l.agentId, count: 0, states: {}, leads: [] };
    byAgent[l.agent].count++;
    byAgent[l.agent].states[l.state] = (byAgent[l.agent].states[l.state] || 0) + 1;
    byAgent[l.agent].leads.push(l);
  });
  return { locks: locks, byAgent: Object.values(byAgent) };
}

// ══════════════════════════════════════════════════════════════════
// LEAD SOURCES
// ══════════════════════════════════════════════════════════════════
// Lives in the auth spreadsheet, not the state sheets — a source is
// company-wide. "Other" writes a pending row for admin to approve, so
// agents can keep working without waiting on a decision.
const SOURCE_COLS = ['Source', 'Status', 'Submitted By', 'Submitted At'];

function sourcesSheet_() {
  const ss = authSS_();
  let sh = ss.getSheetByName('LeadSources');
  if (!sh) {
    sh = ss.insertSheet('LeadSources');
    sh.appendRow(SOURCE_COLS);
    sh.setFrozenRows(1);
  }
  // A tab with a header and nothing under it leaves the picker empty with no
  // way back, so re-seed instead of trusting it was populated once.
  if (sh.getLastRow() < 2) {
    SEED_LEAD_SOURCES.forEach(function(name) {
      sh.appendRow([name, 'approved', 'system', stamp_()]);
    });
  }
  return sh;
}

// ══════════════════════════════════════════════════════════════════
// KEEPING THE CONTAINER WARM
// ══════════════════════════════════════════════════════════════════
// A cold Apps Script container takes 15-25 seconds to answer; a warm one
// takes about one. The client pings on page load, which covers the common
// case. This trigger covers the rest of the working day so the first agent
// in the morning is not the one who pays for it.
//
// Run setupKeepWarm() once from the editor. It finds its own URL, so there is
// nothing to paste anywhere.
// The deployment the front end actually calls. ScriptApp.getService().getUrl()
// is not usable here: it returns this project's /dev URL, which is a different
// deployment and requires the owner to be signed in — pinging it warms the
// wrong container and returns a Google sign-in page.
const WEB_APP_EXEC_URL = 'https://script.google.com/macros/s/AKfycbxp5bPBH45WwdR33oP-We7hEgYP37US2_wcmm-ZsLeuVSuo4jeJU9yXwyzH2t4f5uaa/exec';

function setupKeepWarm() {
  let url = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL') || '';
  if (!url) url = WEB_APP_EXEC_URL;
  if (!url || url.indexOf('/exec') === -1) {
    return 'Need the /exec URL of the deployment the app calls. Set WEB_APP_URL in Script Properties.';
  }
  PropertiesService.getScriptProperties().setProperty('WEB_APP_URL', url);

  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'keepWarm') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('keepWarm').timeBased().everyMinutes(5).create();

  // Prove it works now rather than leaving you to wonder for five minutes.
  const t0 = Date.now();
  let probe;
  try {
    probe = UrlFetchApp.fetch(url + '?action=ping', { muteHttpExceptions: true }).getContentText();
  } catch (e) { probe = 'probe failed: ' + e.message; }

  // A sign-in page means we pinged something the trigger cannot reach.
  const ok = String(probe).indexOf('"ok":true') !== -1;
  const msg = (ok ? 'Keep-warm working.' : 'Keep-warm installed but the ping did NOT reach the app.') +
              '\nEvery 5 minutes, 6am to 9pm.' +
              '\nURL: ' + url +
              '\nPing took ' + (Date.now() - t0) + 'ms' +
              (ok ? '' : '\nExpected JSON with ok:true. If this is an HTML sign-in page, the URL is' +
                         ' wrong or that deployment is older than the ping handler.') +
              '\nResponse: ' + String(probe).slice(0, 200);
  Logger.log(msg);
  return msg;
}

function installKeepWarm() { return setupKeepWarm(); }

function removeKeepWarm() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'keepWarm') { ScriptApp.deleteTrigger(t); n++; }
  });
  const msg = 'Removed ' + n + ' keep-warm trigger(s).';
  Logger.log(msg);
  return msg;
}

function keepWarm() {
  // Only during calling hours — warming a container nobody will use at 3am
  // just burns quota. Log the skip: a run that does nothing and says nothing
  // is indistinguishable from a broken one.
  const hour = Number(Utilities.formatDate(new Date(), TZ, 'H'));
  if (hour < 6 || hour > 21) {
    Logger.log('Outside 6am-9pm (' + hour + ':00) — skipping. This is normal.');
    return;
  }
  const url = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!url) { Logger.log('No WEB_APP_URL set. Run setupKeepWarm() first.'); return; }
  const t0 = Date.now();
  try {
    const body = UrlFetchApp.fetch(url + '?action=ping', { muteHttpExceptions: true }).getContentText();
    Logger.log('Ping ' + (Date.now() - t0) + 'ms — ' + String(body).slice(0, 120));
  } catch (e) {
    Logger.log('Ping failed: ' + e.message);
  }
}

// Undoes createAllStateSheets for states that never received leads, returning
// to creating a sheet on first upload. Empty state sheets buy nothing: the
// picker hides them, uploads create them on demand, and 48 spreadsheets is a
// lot of Drive activity for an account to be judged on.
//
// Only touches sheets with zero lead rows, never the three original states,
// and trashes rather than deletes — recoverable from Drive trash for 30 days.
function deleteEmptyStateSheets() {
  const reg = stateRegistry_();
  const keep = [], trashed = [], skipped = [];

  Object.keys(reg).forEach(function(code) {
    if (seedRegistry_()[code]) { keep.push(code); return; }
    let rows = -1;
    try {
      const sh = SpreadsheetApp.openById(reg[code]).getSheetByName('Leads');
      rows = sh ? Math.max(0, sh.getLastRow() - 1) : 0;
    } catch (e) { skipped.push(code + '(unreadable)'); return; }

    if (rows > 0) { keep.push(code + '(' + rows + ')'); return; }
    try {
      DriveApp.getFileById(reg[code]).setTrashed(true);
      trashed.push(code);
    } catch (e) { skipped.push(code + '(' + e.message + ')'); }
  });

  // Rewrite the registry with only what survived.
  const next = {};
  Object.keys(reg).forEach(function(code) {
    if (seedRegistry_()[code]) return;                  // seeds are not stored
    if (trashed.indexOf(code) === -1) next[code] = reg[code];
  });
  PropertiesService.getScriptProperties().setProperty('STATE_SHEETS', JSON.stringify(next));
  _sheets = null;                                        // drop the per-execution cache
  recountStates();

  const msg = 'Trashed ' + trashed.length + ' empty state sheets.' +
              '\nKept: ' + keep.join(', ') +
              (skipped.length ? '\nSkipped: ' + skipped.join(', ') : '') +
              '\nStates are created again on first upload.';
  Logger.log(msg);
  return msg;
}

// Read-only: what the sources tab actually holds, and whether it is reachable.
function inspectSources() {
  let msg;
  try {
    const sh = sourcesSheet_();
    const all = sourcesAll_();
    msg = 'Auth spreadsheet: ' + authSS_().getName() +
          '\nLeadSources rows: ' + Math.max(0, sh.getLastRow() - 1) +
          '\n' + all.map(function(x) { return '  ' + x.name + '  [' + x.status + ']'; }).join('\n');
  } catch (err) {
    msg = 'FAILED: ' + err.message + '\n' + err.stack;
  }
  Logger.log(msg);
  return msg;
}

function sourcesAll_() {
  const sh = sourcesSheet_();
  const lr = sh.getLastRow();
  if (lr < 2) return [];
  return sh.getRange(2, 1, lr - 1, SOURCE_COLS.length).getValues().map(function(r, i) {
    return { rowIndex: i + 2, name: String(r[0] || ''), status: String(r[1] || ''),
             submittedBy: String(r[2] || ''), submittedAt: fmtDateTime(r[3]) };
  }).filter(function(x) { return x.name; });
}

function listSources_(me) {
  const all = sourcesAll_();
  const isAdmin = me && me.role === 'admin';
  return {
    // Everyone picks from approved. Admin also sees the queue.
    sources: all.filter(function(s) { return s.status === 'approved'; }),
    pending: isAdmin ? all.filter(function(s) { return s.status === 'pending'; }) : []
  };
}

function addSource_(me, name) {
  name = String(name || '').trim();
  if (!name) return { error: 'Name that source before you submit it.' };
  const existing = sourcesAll_().filter(function(s) {
    return s.name.toLowerCase() === name.toLowerCase();
  })[0];
  if (existing) {
    return existing.status === 'approved'
      ? { error: 'That source already exists — pick it from the list.' }
      : { error: 'That one is already waiting on approval.' };
  }
  // Admin adding a source does not need to approve their own request.
  const status = (me.role === 'admin') ? 'approved' : 'pending';
  sourcesSheet_().appendRow([name, status, me.email, stamp_()]);
  logActivity_(me, 'addSource', name + ' (' + status + ')', '');
  return { success: true, status: status, name: name };
}

function decideSource_(me, name, decision, rename) {
  if (!me || me.role !== 'admin') return { error: 'not_permitted' };
  const row = sourcesAll_().filter(function(s) { return s.name === name; })[0];
  if (!row) return { error: 'No such source.' };
  const sh = sourcesSheet_();
  if (decision === 'approve') {
    if (rename) sh.getRange(row.rowIndex, 1).setValue(String(rename).trim());
    sh.getRange(row.rowIndex, 2).setValue('approved');
  } else {
    sh.getRange(row.rowIndex, 2).setValue('rejected');
  }
  logActivity_(me, 'decideSource', name + ' -> ' + decision, '');
  return { success: true };
}

// ══════════════════════════════════════════════════════════════════
// WHAT A CELL CAN ACTUALLY HOLD
// ══════════════════════════════════════════════════════════════════
// Only Phone and the callback columns are formatted as text; everything else
// is written as-is. So a value beginning with = becomes a live formula in the
// sheet rather than a name, and a field long enough will push the row out of
// shape. Both look like the CRM losing data, and neither is recoverable by the
// agent who uploaded it.
const FIELD_LIMITS = {
  'Name': 120, 'First Name': 60, 'Last Name': 60, 'Phone': 20, 'Email': 254,
  'Extra Data': 2000,
  'Address': 200, 'City': 80, 'Zip': 12, 'Lead Type': 40, 'Beneficiary': 100,
  'Hobby': 100, 'Age': 3, 'DOB': 30, 'Lead Source': 60, 'State': 2
};

// = and @ start a formula or a mention. + and - do too when what follows is not
// simply a number, which is why a phone like +1-216... has to stay allowed.
function looksLikeFormula_(v) {
  const t = String(v || '').trim();
  if (!t) return false;
  if (t.charAt(0) === '=' || t.charAt(0) === '@') return true;
  if ((t.charAt(0) === '+' || t.charAt(0) === '-') && /[=(]/.test(t)) return true;
  return false;
}

// Returns a reason string, or '' when the row is fine.
// Same normalisation as the client, because a direct call should behave the
// same way as the upload screen.
function normalizeState_(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (upper.length === 2 && US_STATES[upper]) return upper;

  const cleaned = upper.replace(/\./g, '').replace(/\s+/g, ' ').trim();
  const byName = {};
  Object.keys(US_STATES).forEach(function(c) { byName[US_STATES[c].toUpperCase()] = c; });
  byName['WASHINGTON DC'] = 'DC';
  byName['D C'] = 'DC';
  return byName[upper] || byName[cleaned] || upper;
}

function unsupportedReason_(item) {
  const keys = Object.keys(item || {});
  for (let i = 0; i < keys.length; i++) {
    const f = keys[i];
    // Always JSON, so it opens with a brace and cannot be read as a formula.
    if (f === 'Extra Data') continue;
    const raw = item[f];
    if (raw === null || raw === undefined) continue;
    const v = String(raw);

    if (looksLikeFormula_(v)) {
      return f + ' starts with a spreadsheet symbol';
    }
    // Control characters survive a CSV and then break the row silently.
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(v)) {
      return f + ' contains characters a cell cannot store';
    }
    const cap = FIELD_LIMITS[f];
    if (cap && v.trim().length > cap) {
      return f + ' is too long for the sheet (' + v.trim().length + ' of ' + cap + ')';
    }
  }
  return '';
}

// ══════════════════════════════════════════════════════════════════
// LEAD UPLOAD
// ══════════════════════════════════════════════════════════════════
// Takes rows already mapped to column names by the client. Name and phone
// are required; everything else is optional. A batch id ties the rows
// together so the whole upload can be pulled back later — by flipping
// Batch Status, never by deleting rows.
function uploadLeads_(me, body) {
  if (!me) return { error: 'No user record.' };
  const state = String(body.state || '').toUpperCase();
  if (!US_STATES[state]) return { error: 'Not a US state code: ' + state };
  if (!ensureStateSheet_(state)) return { error: 'Could not open or create the ' + state + ' sheet.' };

  const incoming = body.rows || [];
  if (!incoming.length) return { error: 'Nothing to upload.' };
  if (incoming.length > 5000) return { error: 'Split uploads into 5,000 rows or fewer.' };

  const source = String(body.source || '').trim();
  const approved = sourcesAll_().filter(function(s) { return s.status === 'approved'; })
                                .map(function(s) { return s.name; });
  if (approved.indexOf(source) === -1) return { error: 'Choose an approved lead source.' };

  const exclusive = String(body.visibility || '') === VISIBILITY.EXCLUSIVE;
  const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');

  const lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { return { error: 'busy, try again' }; }

  try {
    // Duplicate check is per-owner-pool only. A number already worked by
    // another branch is reported, not blocked — it is a different pool.
    // Keyed on number AND name. Final expense leads are households: a husband
    // and wife request cover on the same line, and matching on the number
    // alone silently discards the second of them. Two rows with the same
    // number and the same name are a genuine duplicate; same number, different
    // person is two prospects.
    const lr = sheet.getLastRow();
    const mine = {};
    if (lr >= 2) {
      const existing = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
      existing.forEach(function(row) {
        const digits = String(row[ix_('Phone')] || '').replace(/\D/g, '');
        if (digits && String(row[ix_('Owner ID')] || '') === me.id) {
          mine[digits + '|' + String(row[ix_('Name')] || '').trim().toLowerCase()] = true;
        }
      });
    }

    const batchId = 'B' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss') + '-' + me.id;
    const idBase = nextLeadSeq_(sheet, state);
    const now = stamp_();
    let seq = 0, skipped = 0, noPhone = 0, wrongState = 0, households = 0, unsupported = 0;
    // Refused for everyone, including admin. Nobody downstream can repair a
    // row once it is in the sheet — letting a manager push it through only
    // moves the broken data somewhere it is harder to find. These rows go up
    // the chain until the schema is changed to hold them.
    let firstBadReason = '';
    const out = [];
    const seenInBatch = {};
    const seenPhone = {};

    incoming.forEach(function(item) {
      const name  = String(item['Name'] || '').trim();
      const phone = String(item['Phone'] || '').replace(/\D/g, '');
      if (!name || !phone) { noPhone++; return; }

      // The client filters these out, but it is the client — and a lead in
      // the wrong state sheet gets dialled against the wrong TCPA window.
      const rowState = normalizeState_(item['State']);
      if (rowState && rowState !== state) { wrongState++; return; }
      if (rowState) item['State'] = rowState;   // store the code, never the name

      const bad = unsupportedReason_(item);
      if (bad) {
        unsupported++;
        if (!firstBadReason) firstBadReason = bad;
        return;
      }
      const key = phone + '|' + name.toLowerCase();
      if (mine[key] || seenInBatch[key]) { skipped++; return; }
      // Same line, different person — kept, and counted so the number is
      // explainable rather than looking like leads went missing.
      if (seenPhone[phone]) households++;
      seenInBatch[key] = true;
      seenPhone[phone] = true;

      const row = new Array(LEAD_COLS.length).fill('');
      LEAD_COLS.forEach(function(col) {
        if (item[col] !== undefined && item[col] !== null && String(item[col]) !== '') {
          row[COL[col] - 1] = item[col];
        }
      });

      let first = String(item['First Name'] || '').trim();
      let last  = String(item['Last Name'] || '').trim();
      if (!first && !last) { const p = splitName_(name); first = p[0]; last = p[1]; }

      seq++;
      row[ix_('First Name')]   = first;
      row[ix_('Last Name')]    = last;
      row[ix_('Lead ID')]      = state + '-' + ('000000' + (idBase + seq - 1)).slice(-6);
      row[ix_('Status')]       = STATUS.NEW;
      row[ix_('State')]        = state;
      row[ix_('Phone')]        = phone;
      row[ix_('Name')]         = composeName_(first, last) || name;
      row[ix_('Owner ID')]     = me.id;
      row[ix_('Visibility')]   = exclusive ? VISIBILITY.EXCLUSIVE : VISIBILITY.POOL;
      row[ix_('Lead Source')]  = source;
      row[ix_('Batch ID')]     = batchId;
      row[ix_('Uploaded By')]  = me.email;
      row[ix_('Batch Status')] = 'active';
      row[ix_('Date Added')]   = now;
      row[ix_('Attempts')]     = 0;
      row[ix_('Locked By')]    = '';
      out.push(row);
    });

    if (out.length) {
      const at = sheet.getLastRow() + 1;
      sheet.getRange(at, COL['Phone'], out.length, 1).setNumberFormat('@');
      sheet.getRange(at, 1, out.length, LEAD_COLS.length).setValues(out);
    }

    if (out.length) bumpStateCount_(state, out.length);
    logActivity_(me, 'uploadLeads', out.length + ' into ' + state + ' (' + source + ', ' + batchId + ')', state);
    return {
      success: true, added: out.length, batchId: batchId,
      skippedDuplicate: skipped, skippedIncomplete: noPhone, skippedWrongState: wrongState,
      households: households,
      unsupported: unsupported,
      unsupportedReason: firstBadReason
    };
  } finally {
    lock.releaseLock();
  }
}

// Highest existing sequence for a state, so a batch can number from there.
function nextLeadSeq_(sheet, state) {
  const lr = sheet.getLastRow();
  let max = 0;
  if (lr >= 2) {
    sheet.getRange(2, COL['Lead ID'], lr - 1, 1).getValues().forEach(function(r) {
      const m = String(r[0] || '').match(/-(\d+)$/);
      if (m) max = Math.max(max, Number(m[1]));
    });
  }
  return max + 1;
}

// Pull a batch back out of rotation. Reversible: rows are flagged, not deleted.
function setBatchStatus_(me, batchId, state, active) {
  if (!me) return { error: 'No user record.' };
  const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
  const lr = sheet.getLastRow();
  if (lr < 2) return { error: 'Nothing there.' };

  const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
  let touched = 0;
  data.forEach(function(row, i) {
    if (String(row[ix_('Batch ID')] || '') !== batchId) return;
    // Uploader can pull their own batch; admin can pull anyone's.
    // Ownership, not authorship. Keyed on Uploaded By, the donor could pull a
    // batch out of rotation after giving it away — yanking a hundred leads
    // back out of their upline's pool.
    if (me.role !== 'admin' && String(row[ix_('Owner ID')] || '') !== String(me.id || '')) return;
    sheet.getRange(i + 2, COL['Batch Status']).setValue(active ? 'active' : 'removed');
    sheet.getRange(i + 2, COL['Status']).setValue(active ? STATUS.NEW : STATUS.REMOVED);
    touched++;
  });
  logActivity_(me, 'setBatchStatus', batchId + ' -> ' + (active ? 'active' : 'removed'), state);
  return { success: true, updated: touched };
}

function myBatches_(me) {
  const cache = CacheService.getScriptCache();
  const key = 'batches_' + (me ? me.id : 'anon') + '_' + statesVersion_();
  const hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  // Nine fields out of sixty-one. Reading the full width made this the
  // slowest screen in the app for no reason — the wanted columns sit in two
  // runs, 3-16 and 25-28, so two narrow reads cover them.
  const A0 = COL['Owner ID'], AW = COL['Date Added'] - COL['Owner ID'] + 1;
  const B0 = COL['Lead Source'], BW = COL['Batch Status'] - COL['Lead Source'] + 1;
  const iOwner = COL['Owner ID'] - A0, iVis = COL['Visibility'] - A0,
        iShared = COL['Shared With'] - A0, iLock = COL['Locked By'] - A0,
        iAdded = COL['Date Added'] - A0;
  const iSource = COL['Lead Source'] - B0, iBatch = COL['Batch ID'] - B0,
        iBy = COL['Uploaded By'] - B0, iStatus = COL['Batch Status'] - B0;
  const C0 = COL['Donated By'], CW = COL['Donated At'] - COL['Donated By'] + 1;
  const iDonBy = COL['Donated By'] - C0, iDonAt = COL['Donated At'] - C0;

  const out = [];
  activeStates_().forEach(function(state) {
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const lr = sheet ? sheet.getLastRow() : 0;
    if (lr < 2) return;

    const a = sheet.getRange(2, A0, lr - 1, AW).getValues();
    const b = sheet.getRange(2, B0, lr - 1, BW).getValues();
    const c = sheet.getRange(2, C0, lr - 1, CW).getValues();

    const acc = {};
    for (let i = 0; i < b.length; i++) {
      const batchId = String(b[i][iBatch] || '');
      if (!batchId) continue;
      const by = String(b[i][iBy] || '');
      // Yours if you uploaded it, or if it was donated into your pool —
      // filtering on Uploaded By alone hid every donation from the manager
      // who now owns the leads.
      const owned = String(a[i][iOwner] || '') === String(me.id || '');
      if (me.role !== 'admin' && by !== me.email && !owned) continue;

      acc[batchId] = acc[batchId] || {
        batchId: batchId, state: state, uploadedBy: by,
        source: String(b[i][iSource] || ''),
        batchStatus: String(b[i][iStatus] || ''),
        visibility: String(a[i][iVis] || VISIBILITY.POOL),
        ownerId: String(a[i][iOwner] || ''),
        added: String(a[i][iAdded] || ''),
        donatedBy: String(c[i][iDonBy] || ''),
        donatedAt: String(c[i][iDonAt] || ''),
        count: 0, locked: 0, _share: {}
      };
      acc[batchId].count++;
      if (a[i][iLock]) acc[batchId].locked++;
      // Sharing is stored per lead, so a batch can hold several different
      // answers once someone revokes an individual one. Tally them rather
      // than reporting whichever row happened to come first.
      const sw = String(a[i][iShared] || '');
      acc[batchId]._share[sw] = (acc[batchId]._share[sw] || 0) + 1;
    }
    Object.keys(acc).forEach(function(k) {
      const b = acc[k];
      const variants = Object.keys(b._share);
      // The most common answer is what the picker should open on.
      variants.sort(function(x, y) { return b._share[y] - b._share[x]; });
      b.sharedWith = variants[0] || '';
      b.sharedOn = b._share[b.sharedWith] || 0;
      b.sharedMixed = variants.length > 1;
      // A donated batch stays visible to the donor as a record, but it is not
      // theirs to change any more.
      b.ownerIsMe = String(b.ownerId || '') === String(me.id || '');
      delete b._share;
      out.push(b);
    });
  });

  out.sort(function(a, b) { return String(b.added).localeCompare(String(a.added)); });
  const result = { batches: out };
  cache.put(key, JSON.stringify(result), 60);
  return result;
}

// ══════════════════════════════════════════════════════════════════
// LEAD OWNERSHIP — visibility, sharing, donating to a pool
// ══════════════════════════════════════════════════════════════════
function hasDownline_(me) {
  return downlineOf_(me, false).length > 0;
}

// Who a donation goes to, and what to call it on the confirmation.
// A manager with reports keeps ownership and simply opens the leads to
// their branch. Someone with nobody under them has no branch to open to,
// so the leads pass up to their parent instead.
function donationTarget_(me) {
  if (me.role === 'admin' || hasDownline_(me)) {
    return { ownerId: me.id, label: 'your team' };
  }
  const parent = me.parentId ? userById_(me.parentId) : null;
  if (!parent) return null;
  return { ownerId: parent.id, label: parent.name || parent.email };
}

// Everyone active, for the share picker. Agents seeing the full roster is
// intentional — sharing a lead is not a permission grant.
function rosterFor_(me) {
  if (!me) return { roster: [] };
  return {
    roster: usersAll_()
      .filter(function(u) { return u.status === 'active' && u.id !== me.id; })
      .map(function(u) { return { id: u.id, name: u.name, email: u.email, role: u.role }; })
      .sort(function(a, b) { return String(a.name).localeCompare(String(b.name)); })
  };
}

// Walks one batch, applying `fn` to every row the caller is allowed to touch.
// Reserved rows are skipped: changing ownership under someone mid-call would
// pull the lead out from under them.
function eachBatchRow_(me, batchId, state, fn) {
  const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
  if (!sheet) return { error: 'No sheet for ' + state };
  const lr = sheet.getLastRow();
  if (lr < 2) return { error: 'Nothing there.' };

  const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
  let changed = 0, skippedLocked = 0, notMine = 0;

  data.forEach(function(row, i) {
    if (String(row[ix_('Batch ID')] || '') !== batchId) return;
    const owner = String(row[ix_('Owner ID')] || '');
    if (me.role !== 'admin' && owner !== me.id) { notMine++; return; }
    if (row[ix_('Locked By')]) { skippedLocked++; return; }
    fn(sheet, i + 2, row);
    changed++;
  });
  return { success: true, changed: changed, skippedLocked: skippedLocked, notMine: notMine };
}

function setBatchVisibility_(me, body) {
  if (!me) return { error: 'No user record.' };
  const vis = String(body.visibility || '').toLowerCase();
  if ([VISIBILITY.POOL, VISIBILITY.EXCLUSIVE].indexOf(vis) === -1) return { error: 'Bad visibility.' };

  const out = eachBatchRow_(me, body.batchId, body.state, function(sheet, rowIndex) {
    sheet.getRange(rowIndex, COL['Visibility']).setValue(vis);
  });
  if (out.error) return out;
  logActivity_(me, 'setVisibility', body.batchId + ' -> ' + vis + ' (' + out.changed + ')', body.state);
  invalidateStates_(me);
  return out;
}

function shareBatch_(me, body) {
  if (!me) return { error: 'No user record.' };
  const ids = (body.userIds || []).map(function(x) { return String(x).trim(); }).filter(Boolean);
  const value = ids.join(',');

  const out = eachBatchRow_(me, body.batchId, body.state, function(sheet, rowIndex) {
    sheet.getRange(rowIndex, COL['Shared With']).setValue(value);
  });
  if (out.error) return out;
  logActivity_(me, 'shareBatch', body.batchId + ' -> [' + value + '] (' + out.changed + ')', body.state);
  invalidateStates_(me);
  return out;
}

function donateBatch_(me, body) {
  if (!me) return { error: 'No user record.' };
  const target = donationTarget_(me);
  if (!target) return { error: 'You have no manager above you to donate to.' };

  const donatedAt = stamp_();
  const out = eachBatchRow_(me, body.batchId, body.state, function(sheet, rowIndex) {
    sheet.getRange(rowIndex, COL['Owner ID']).setValue(target.ownerId);
    sheet.getRange(rowIndex, COL['Visibility']).setValue(VISIBILITY.POOL);
    sheet.getRange(rowIndex, COL['Shared With']).setValue('');
    sheet.getRange(rowIndex, COL['Donated By']).setValue(me.name || me.email);
    sheet.getRange(rowIndex, COL['Donated At']).setValue(donatedAt);
  });
  if (out.error) return out;
  out.destination = target.label;
  logActivity_(me, 'donateBatch', body.batchId + ' -> ' + target.ownerId + ' (' + out.changed + ')', body.state);
  invalidateStates_(me);
  return out;
}

// Where a donation would land, so the UI can name it before asking.
function donationInfo_(me) {
  const t = donationTarget_(me);
  return t ? { destination: t.label, ownerId: t.ownerId }
           : { destination: '', ownerId: '' };
}

// ══════════════════════════════════════════════════════════════════
// LEAD EDITING
// ══════════════════════════════════════════════════════════════════
// Anyone who can see a lead can correct it. Bad data is worse than no data
// on a dialer — a wrong number cannot go back to the pool until someone
// fixes it, and only the person on the call knows what it should say.
//
// Every change is logged before-and-after, because the sheet only ever holds
// the current value: the activity log is the sole record of who changed what.
const EDITABLE_FIELDS = [
  'First Name', 'Last Name', 'Phone', 'Email', 'Address', 'City', 'Zip',
  'Lead Type', 'Beneficiary', 'Hobby', 'Age', 'DOB', 'Lead Source'
];

function updateLead_(me, body) {
  if (!me) return { error: 'No user record.' };
  const state = String(body.state || '').toUpperCase();
  if (!sheets_()[state]) return { error: 'Unknown state: ' + state };

  const rowIndex = Number(body.rowIndex);
  if (!rowIndex || rowIndex < 2) return { error: 'Bad row.' };

  const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
  const row = sheet.getRange(rowIndex, 1, 1, LEAD_COLS.length).getValues()[0];
  if (!canSee_(row, me)) return { error: 'not_permitted' };

  const fields = body.fields || {};
  const changes = [];

  EDITABLE_FIELDS.forEach(function(name) {
    if (!(name in fields)) return;
    let next = String(fields[name] === null || fields[name] === undefined ? '' : fields[name]).trim();
    if (name === 'Phone') next = next.replace(/\D/g, '');
    const prev = String(row[ix_(name)] === null || row[ix_(name)] === undefined ? '' : row[ix_(name)]).trim();
    if (prev === next) return;
    sheet.getRange(rowIndex, COL[name]).setValue(next);
    row[ix_(name)] = next;
    changes.push(name + ': "' + prev + '" -> "' + next + '"');
  });

  if (!changes.length) return { success: true, changed: 0 };

  // Name is the composed display value, so it has to follow its parts.
  const composed = composeName_(row[ix_('First Name')], row[ix_('Last Name')]);
  if (composed && composed !== String(row[ix_('Name')] || '').trim()) {
    sheet.getRange(rowIndex, COL['Name']).setValue(composed);
    row[ix_('Name')] = composed;
  }

  sheet.getRange(rowIndex, COL['Last Activity At']).setValue(stamp_());
  logActivity_(me, 'editLead',
    (row[ix_('Lead ID')] || ('row ' + rowIndex)) + ' — ' + changes.join('; '), state);

  return {
    success: true,
    changed: changes.length,
    lead: Object.assign({ rowIndex: rowIndex, state: state }, rowToObj(row))
  };
}

// ══════════════════════════════════════════════════════════════════
// DCID REVIEW
// ══════════════════════════════════════════════════════════════════
// DCID is a crash-out, and agents disposition it under pressure mid-call.
// A manager or admin looks at them before they are lost: back to the pool if
// the agent was hasty, archived if genuinely dead. Either way the lead row
// survives — archiving is a status, not a delete, so the history stays.
function dcidQueue_(me) {
  if (!me || (me.role !== 'admin' && me.role !== 'manager')) return { error: 'not_permitted' };

  const scope = scopeNamesFor_(me);      // null for admin = everyone
  const items = [];

  activeStates_().forEach(function(code) {
    const sheet = SpreadsheetApp.openById(sheets_()[code]).getSheetByName('Leads');
    const lr = sheet ? sheet.getLastRow() : 0;
    if (lr < 2) return;
    const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();

    data.forEach(function(row, i) {
      if (String(row[ix_('Status')] || '').toLowerCase() !== STATUS.DCID) return;
      if (String(row[ix_('DCID Review')] || '').toLowerCase() !== 'pending') return;
      // Only this manager's branch; admin sees the lot.
      if (!inScope_(scope, row[ix_('DCID Agent')])) return;

      items.push({
        state: code, rowIndex: i + 2,
        leadId: String(row[ix_('Lead ID')] || ''),
        name: String(row[ix_('Name')] || ''),
        phone: String(row[ix_('Phone')] || ''),
        city: String(row[ix_('City')] || ''),
        attempts: Number(row[ix_('Attempts')]) || 0,
        agent: String(row[ix_('DCID Agent')] || ''),
        reason: String(row[ix_('DCID Reason')] || ''),
        at: fmtDateTime(row[ix_('DCID Date')])
      });
    });
  });

  items.sort(function(a, b) { return String(b.at).localeCompare(String(a.at)); });
  return { items: items };
}

function reviewDcid_(me, body) {
  if (!me || (me.role !== 'admin' && me.role !== 'manager')) return { error: 'not_permitted' };
  const decision = String(body.decision || '');
  if (['pool', 'archive'].indexOf(decision) === -1) return { error: 'Bad decision.' };

  const items = body.items || [];
  if (!items.length) return { error: 'Nothing selected.' };

  const now = stamp_();
  let done = 0;

  // Group by state so each spreadsheet is opened once, not once per lead.
  const byState = {};
  items.forEach(function(it) {
    (byState[it.state] = byState[it.state] || []).push(Number(it.rowIndex));
  });

  Object.keys(byState).forEach(function(code) {
    if (!sheets_()[code]) return;
    const sheet = SpreadsheetApp.openById(sheets_()[code]).getSheetByName('Leads');
    if (!sheet) return;

    byState[code].forEach(function(rowIndex) {
      if (!rowIndex || rowIndex < 2) return;
      const row = sheet.getRange(rowIndex, 1, 1, LEAD_COLS.length).getValues()[0];
      if (String(row[ix_('Status')] || '').toLowerCase() !== STATUS.DCID) return;

      sheet.getRange(rowIndex, COL['DCID Review']).setValue(decision === 'pool' ? 'returned' : 'archived');
      sheet.getRange(rowIndex, COL['DCID Reviewed By']).setValue(me.email);
      sheet.getRange(rowIndex, COL['DCID Reviewed At']).setValue(now);

      if (decision === 'pool') {
        // Back into rotation, with the attempt history intact so it is not
        // dialled straight back to the top of the queue.
        sheet.getRange(rowIndex, COL['Status']).setValue(STATUS.NEW);
        sheet.getRange(rowIndex, COL['Status Reason']).setValue('DCID returned by ' + me.name);
        clearLock_(sheet, rowIndex);
      } else {
        sheet.getRange(rowIndex, COL['Status']).setValue(STATUS.ARCHIVED);
        sheet.getRange(rowIndex, COL['Archived At']).setValue(now);
        sheet.getRange(rowIndex, COL['Archived By']).setValue(me.email);
      }
      sheet.getRange(rowIndex, COL['Status At']).setValue(now);
      done++;
    });
  });

  logActivity_(me, 'reviewDcid', decision + ' x' + done, '');
  return { success: true, changed: done };
}

// One lead rather than a whole batch. An agent working a list wants to hand
// off the ones that went nowhere without giving up the rest.
function oneLead_(me, body) {
  const state = String(body.state || '').toUpperCase();
  if (!sheets_()[state]) return { error: 'Unknown state: ' + state };
  const rowIndex = Number(body.rowIndex);
  if (!rowIndex || rowIndex < 2) return { error: 'Bad row.' };

  const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
  const row = sheet.getRange(rowIndex, 1, 1, LEAD_COLS.length).getValues()[0];
  if (!canSee_(row, me)) return { error: 'not_permitted' };

  // Giving a lead away or sharing it is an owner's decision, not a viewer's.
  const owner = String(row[ix_('Owner ID')] || '');
  if (me.role !== 'admin' && owner !== me.id) {
    return { error: 'That lead is not yours to give away.' };
  }
  return { sheet: sheet, row: row, rowIndex: rowIndex, state: state };
}

function donateLead_(me, body) {
  if (!me) return { error: 'No user record.' };
  const target = donationTarget_(me);
  if (!target) return { error: 'You have no manager above you to donate to.' };

  const ctx = oneLead_(me, body);
  if (ctx.error) return ctx;

  // Someone else mid-call on it keeps it; the donor's own lock is fine, they
  // are the one handing it over.
  const lockedBy = String(ctx.row[ix_('Locked By')] || '');
  if (lockedBy && !lockOwnerIsMe_(lockedBy, me)) {
    return { error: 'Someone is dialing that lead right now.' };
  }

  const now = stamp_();
  ctx.sheet.getRange(ctx.rowIndex, COL['Owner ID']).setValue(target.ownerId);
  ctx.sheet.getRange(ctx.rowIndex, COL['Visibility']).setValue(VISIBILITY.POOL);
  ctx.sheet.getRange(ctx.rowIndex, COL['Shared With']).setValue('');
  ctx.sheet.getRange(ctx.rowIndex, COL['Donated By']).setValue(me.name || me.email);
  ctx.sheet.getRange(ctx.rowIndex, COL['Donated At']).setValue(now);
  clearLock_(ctx.sheet, ctx.rowIndex);

  logActivity_(me, 'donateLead',
    (ctx.row[ix_('Lead ID')] || ('row ' + ctx.rowIndex)) + ' -> ' + target.label, ctx.state);
  invalidateStates_(me);
  return { success: true, destination: target.label };
}

function shareLead_(me, body) {
  if (!me) return { error: 'No user record.' };
  const ctx = oneLead_(me, body);
  if (ctx.error) return ctx;

  const ids = (body.userIds || []).map(function(x) { return String(x).trim(); }).filter(Boolean);
  ctx.sheet.getRange(ctx.rowIndex, COL['Shared With']).setValue(ids.join(','));
  logActivity_(me, 'shareLead',
    (ctx.row[ix_('Lead ID')] || ('row ' + ctx.rowIndex)) + ' -> [' + ids.join(',') + ']', ctx.state);
  invalidateStates_(me);
  return { success: true, shared: ids.length };
}

// Correcting a mistyped email. Without this a single wrong character means the
// account can never be signed into and has to be abandoned, since sign-in is
// matched on the Google address.
function changeUserEmail_(actor, userId, newEmail) {
  if (!actor) return { error: 'No user record.' };
  const target = userById_(userId);
  if (!target) return { error: 'No such user.' };
  if (!canManage_(actor, target)) return { error: 'not_permitted' };

  const email = String(newEmail || '').trim().toLowerCase();
  if (!email || email.indexOf('@') === -1 || /\s/.test(email)) {
    return { error: 'That is not a valid email address.' };
  }
  if (email === String(target.email || '').toLowerCase()) {
    return { error: 'That is already their email.' };
  }
  const clash = userByEmail_(email);
  if (clash && clash.id !== target.id) {
    return { error: 'Another account already uses that email.' };
  }

  const sh = authSS_().getSheetByName(USERS_SHEET);
  sh.getRange(target.row, USER_COLS.indexOf('Email') + 1).setValue(email);
  logActivity_(actor, 'changeUserEmail', target.email + ' -> ' + email, '');

  // Sessions are keyed on email, so any existing session for the old address
  // stops resolving and they sign in again — correct, and worth saying so.
  return { success: true, email: email, wasSignedIn: !!target.lastLogin };
}

// Which of these numbers the uploader already has in a state. Checked before
// upload so a list bought twice, or overlapping lists from the same vendor,
// do not quietly become two copies of the same person to call.
//
// DCID is deliberately excluded: that lead crashed out, and re-uploading is
// how it gets another attempt. Flagging it would block the one case where a
// second copy is wanted.
/**
 * One canonical form for comparing numbers.
 *
 * The sheet holds both shapes — 525 rows as ten digits and 297 as 1 + ten at
 * the last count — so comparing raw digits made the same person two different
 * people. The duplicate check missed them and agents uploaded rows that were
 * already there.
 */
function phoneKey_(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '1') return d.slice(1);
  if (d.length > 11) return (d.charAt(0) === '1' ? d.substr(1, 10) : d.substr(0, 10));
  return d;
}

function existingLeads_(me, body) {
  if (!me) return { error: 'No user record.' };
  const state = String(body.state || '').toUpperCase();
  if (!sheets_()[state]) return { matches: {} };

  const wanted = {};
  (body.phones || []).forEach(function(p) {
    const d = phoneKey_(p);
    if (d) wanted[d] = true;
  });
  if (!Object.keys(wanted).length) return { matches: {} };

  const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
  const lr = sheet ? sheet.getLastRow() : 0;
  if (lr < 2) return { matches: {} };

  const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
  const matches = {};

  data.forEach(function(row) {
    const phone = phoneKey_(row[ix_('Phone')]);
    if (!phone || !wanted[phone]) return;
    if (!canSee_(row, me)) return;                 // not theirs to know about

    const status = String(row[ix_('Status')] || '').toLowerCase();
    if (status === STATUS.DCID) return;            // re-uploading is how it gets retried
    if (status === STATUS.ARCHIVED || status === STATUS.REMOVED) return;

    // Several rows can share a number; report the one furthest along.
    const rank = { sold: 5, callback: 4, wrong: 3, review: 2, new: 1 };
    const prev = matches[phone];
    if (prev && (rank[prev.status] || 0) >= (rank[status] || 0)) return;

    matches[phone] = {
      name: String(row[ix_('Name')] || ''),
      status: status || 'new',
      leadId: String(row[ix_('Lead ID')] || ''),
      attempts: Number(row[ix_('Attempts')]) || 0,
      source: String(row[ix_('Lead Source')] || ''),
      added: fmtDateTime(row[ix_('Date Added')]),
      lastCall: fmtDateTime(row[ix_('Last Call Start')])
    };
  });

  return { matches: matches };
}

// ══════════════════════════════════════════════════════════════════
// MIGRATION — run once from the editor, after pasting this file
// ══════════════════════════════════════════════════════════════════
// Folds the old six tabs into one, mapping columns by name and deriving
// Status from whichever tab a row was sitting in. Old tabs are renamed,
// never deleted, so this is reversible if the result looks wrong.
function migrateLeadSchema() {
  const OLD_LEAD_COLS = [
    'Name', 'Phone', 'Email', 'Address', 'City', 'State',
    'Lead Type', 'Beneficiary', 'Hobby', 'Age', 'DOB',
    'Status', 'Locked By', 'Locked At',
    'Attempts', 'Last Call Agent', 'Last Call Start', 'Last Call End', 'Last Call Duration',
    'Date Added'
  ];
  // tab → [status, extra column names appended after the shared block]
  const OLD_TABS = {
    'Leads':         [STATUS.NEW,      []],
    'Callbacks':     [STATUS.CALLBACK, ['Callback Date', 'Callback Time', 'Scheduled By', 'Scheduled Date']],
    'DCID':          [STATUS.DCID,     ['DCID Reason', 'DCID Date', 'DCID Agent']],
    'Sold':          [STATUS.SOLD,     ['Monthly Premium', 'Carrier', 'First Draft Date',
                                        'Recurring Draft Date', 'Reason for Policy', 'Sale Notes',
                                        'Sold Date', 'Sold Agent']],
    'Wrong Numbers': [STATUS.WRONG,    ['Wrong Number Date', 'Wrong Number Agent']],
    'Review':        [STATUS.REVIEW,   ['Status At', 'Status Reason']]
  };

  const report = [];

  Object.keys(sheets_()).forEach(function(state) {
    const ss = SpreadsheetApp.openById(sheets_()[state]);

    // Already migrated? A new-schema Leads tab starts with 'Lead ID'. Re-reading
    // it through the old column map would produce garbage, so stop here instead.
    const current = ss.getSheetByName('Leads');
    if (current && current.getLastColumn() > 0 &&
        String(current.getRange(1, 1).getValue()).trim() === 'Lead ID') {
      report.push(state + ': already migrated, skipped');
      return;
    }

    const rows = [];
    let seq = 0;

    Object.keys(OLD_TABS).forEach(function(tabName) {
      const sheet = ss.getSheetByName(tabName);
      if (!sheet) return;
      const lr = sheet.getLastRow();
      if (lr < 2) return;

      const status = OLD_TABS[tabName][0];
      const extras = OLD_TABS[tabName][1];
      const oldCols = OLD_LEAD_COLS.concat(extras);
      const data = sheet.getRange(2, 1, lr - 1, Math.min(oldCols.length, sheet.getLastColumn())).getValues();

      data.forEach(function(old) {
        if (!old[0] && !old[1]) return;                 // no name and no phone: junk row
        const row = new Array(LEAD_COLS.length).fill('');

        oldCols.forEach(function(name, i) {
          if (name === 'Status') return;                // old Status was the lock flag
          if (COL[name]) row[COL[name] - 1] = old[i];
        });

        const sp = splitName_(row[ix_('Name')]);
        row[ix_('First Name')] = sp[0];
        row[ix_('Last Name')]  = sp[1];

        seq++;
        row[ix_('Lead ID')]    = state + '-' + ('000000' + seq).slice(-6);
        row[ix_('Status')]     = status;
        row[ix_('State')]      = state;
        row[ix_('Visibility')] = VISIBILITY.POOL;
        row[ix_('Owner ID')]   = '';                    // unowned = whole-company pool
        row[ix_('Locked By')]  = '';                    // no reservation survives a migration
        row[ix_('Locked At')]  = '';

        // Backfill AP so the leaderboard has something to rank on.
        if (status === STATUS.SOLD) {
          const m = Number(String(row[ix_('Monthly Premium')] || '').replace(/[^0-9.]/g, '')) || 0;
          row[ix_('AP Amount')] = m * 12;
        }
        if (status === STATUS.DCID) row[ix_('DCID Review')] = 'pending';
        if (status === STATUS.CALLBACK) {
          row[ix_('Callback Hold Until')] =
            holdUntil_(row[ix_('Callback Date')], row[ix_('Callback Time')]);
        }
        rows.push(row);
      });

      renameUnique_(ss, sheet, tabName + '_old');
    });

    const fresh = ss.insertSheet('Leads');
    fresh.getRange(1, 1, 1, LEAD_COLS.length)
         .setValues([LEAD_COLS]).setFontWeight('bold').setBackground('#e8f0fe');
    fresh.setFrozenRows(1);
    if (rows.length) {
      fresh.getRange(2, COL['Phone'], rows.length, 1).setNumberFormat('@');
      fresh.getRange(2, COL['Callback Date'], rows.length, 2).setNumberFormat('@');
      fresh.getRange(2, 1, rows.length, LEAD_COLS.length).setValues(rows);
    }
    report.push(state + ': ' + rows.length + ' leads');
  });

  const msg = 'Migrated — ' + report.join(', ') + '. Old tabs kept with an _old suffix.';
  Logger.log(msg);
  return msg;
}

// Rename without ever colliding — a half-finished earlier run may have
// already taken the plain name.
function renameUnique_(ss, sheet, base) {
  let name = base, n = 2;
  while (ss.getSheetByName(name)) { name = base + '_' + n; n++; }
  sheet.setName(name);
  return name;
}

// Adds the two name columns to sheets migrated before they existed, and
// splits the existing Name into them. Safe to re-run: it only fills blanks.
function backfillNameParts() {
  const report = [];
  Object.keys(sheets_()).forEach(function(state) {
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    if (!sheet) { report.push(state + ': no Leads tab'); return; }

    // Widen the sheet and rewrite the header to the current schema.
    if (sheet.getMaxColumns() < LEAD_COLS.length) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), LEAD_COLS.length - sheet.getMaxColumns());
    }
    sheet.getRange(1, 1, 1, LEAD_COLS.length)
         .setValues([LEAD_COLS]).setFontWeight('bold').setBackground('#e8f0fe');

    const lr = sheet.getLastRow();
    if (lr < 2) { report.push(state + ': header updated, no rows'); return; }

    const names = sheet.getRange(2, COL['Name'], lr - 1, 1).getValues();
    const parts = sheet.getRange(2, COL['First Name'], lr - 1, 2).getValues();
    let filled = 0;
    const out = parts.map(function(p, i) {
      if (String(p[0] || '').trim() || String(p[1] || '').trim()) return p;
      const sp = splitName_(names[i][0]);
      if (sp[0] || sp[1]) filled++;
      return sp;
    });
    sheet.getRange(2, COL['First Name'], out.length, 2).setValues(out);
    report.push(state + ': ' + filled + ' split');
  });
  const msg = report.join(', ');
  Logger.log(msg);
  return msg;
}

// Retires the seeded test leads. They carry plausible-looking phone numbers
// that belong to real people, so leaving them mixed into a live pool means
// an agent eventually dials a stranger. Archived, not deleted, so the row
// and its history survive.
function removeDummyLeads() {
  const names = {};
  DUMMY_LEADS.forEach(function(d) { names[String(d[0]).toLowerCase()] = true; });
  const phones = {};
  DUMMY_LEADS.forEach(function(d) { phones[String(d[1]).replace(/\D/g, '')] = true; });

  const report = [];
  Object.keys(sheets_()).forEach(function(code) {
    const sheet = SpreadsheetApp.openById(sheets_()[code]).getSheetByName('Leads');
    if (!sheet) return;
    const lr = sheet.getLastRow();
    if (lr < 2) return;

    const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
    let hit = 0;
    data.forEach(function(row, i) {
      const nm = String(row[ix_('Name')] || '').toLowerCase();
      const ph = String(row[ix_('Phone')] || '').replace(/\D/g, '');
      const already = String(row[ix_('Status')] || '').toLowerCase() === STATUS.ARCHIVED;
      // Both must match, so a real lead who happens to share a test name stays.
      if (already || !names[nm] || !phones[ph]) return;
      sheet.getRange(i + 2, COL['Status']).setValue(STATUS.ARCHIVED);
      sheet.getRange(i + 2, COL['Status Reason']).setValue('seeded test lead');
      sheet.getRange(i + 2, COL['Archived At']).setValue(stamp_());
      sheet.getRange(i + 2, COL['Archived By']).setValue('system');
      hit++;
    });
    if (hit) report.push(code + ': ' + hit);
  });
  recountStates();
  const msg = report.length ? 'Archived test leads — ' + report.join(', ')
                            : 'No seeded test leads found.';
  Logger.log(msg);
  return msg;
}

// Empties every state of leads, ready for the first real upload.
//
// The current Leads tab is renamed rather than emptied, so nothing is actually
// destroyed — if this is run by mistake, or the wrong batch turns out to have
// been real, the data is still sitting there under a dated name. A fresh Leads
// tab is created with the current header, so Lead IDs start from 000001 again.
//
// Delete the Leads_cleared_* tabs by hand once you are certain.
function clearAllLeads() {
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd_HHmm');
  const report = [];
  let wiped = 0;

  Object.keys(sheets_()).forEach(function(code) {
    const ss = SpreadsheetApp.openById(sheets_()[code]);
    const sheet = ss.getSheetByName('Leads');
    if (!sheet) return;

    const rows = Math.max(0, sheet.getLastRow() - 1);
    if (!rows) return;                       // already empty, leave it alone

    renameUnique_(ss, sheet, 'Leads_cleared_' + stamp);

    const fresh = ss.insertSheet('Leads');
    fresh.getRange(1, 1, 1, LEAD_COLS.length)
         .setValues([LEAD_COLS]).setFontWeight('bold').setBackground('#e8f0fe');
    fresh.setFrozenRows(1);
    fresh.getRange(2, COL['Phone'], fresh.getMaxRows() - 1, 1).setNumberFormat('@');
    fresh.getRange(2, COL['Callback Date'], fresh.getMaxRows() - 1, 2).setNumberFormat('@');

    report.push(code + ': ' + rows);
    wiped += rows;
  });

  // Counts and cached pickers both describe leads that no longer exist.
  recountStates();
  try { CacheService.getScriptCache().put('states_ver', String(Date.now()), 21600); } catch (e) {}

  const msg = wiped
    ? 'Cleared ' + wiped + ' leads — ' + report.join(', ') +
      '.\nOld data kept in Leads_cleared_' + stamp + ' in each sheet; delete those tabs when you are sure.' +
      '\nEvery state now starts empty and Lead IDs restart at 000001.'
    : 'Nothing to clear — every state was already empty.';
  Logger.log(msg);
  return msg;
}

// Retires every generated test lead, wherever it landed. They all carry a
// number in the 555-0100..0199 block reserved for fiction, which nothing real
// can use — so this is exact, and cannot catch a genuine lead.
//
// Run before agents start. Otherwise a 150-lead stack comes back mostly
// unroutable numbers and the agent spends the morning listening to dead air.
// Archived, not deleted: the rows and their history stay.
function removeTestLeads() {
  const report = [];
  let total = 0;

  Object.keys(sheets_()).forEach(function(code) {
    const sheet = SpreadsheetApp.openById(sheets_()[code]).getSheetByName('Leads');
    const lr = sheet ? sheet.getLastRow() : 0;
    if (lr < 2) return;

    const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
    const now = stamp_();
    let hit = 0;

    data.forEach(function(row, i) {
      const phone = String(row[ix_('Phone')] || '').replace(/\D/g, '');
      // 1 + area code + 555 + 01xx
      if (!/^1\d{3}55501\d{2}$/.test(phone)) return;
      if (String(row[ix_('Status')] || '').toLowerCase() === STATUS.ARCHIVED) return;

      sheet.getRange(i + 2, COL['Status']).setValue(STATUS.ARCHIVED);
      sheet.getRange(i + 2, COL['Status Reason']).setValue('generated test lead');
      sheet.getRange(i + 2, COL['Archived At']).setValue(now);
      sheet.getRange(i + 2, COL['Archived By']).setValue('system');
      clearLock_(sheet, i + 2);
      hit++;
    });
    if (hit) { report.push(code + ': ' + hit); total += hit; }
  });

  recountStates();
  const msg = total
    ? 'Archived ' + total + ' test leads — ' + report.join(', ') + '. Real leads untouched.'
    : 'No test leads found.';
  Logger.log(msg);
  return msg;
}

// Counts what each state would actually hand an agent, and how much of it is
// test data. Read-only — run it before and after.
function poolReport() {
  const out = [];
  Object.keys(sheets_()).forEach(function(code) {
    const sheet = SpreadsheetApp.openById(sheets_()[code]).getSheetByName('Leads');
    const lr = sheet ? sheet.getLastRow() : 0;
    if (lr < 2) return;

    const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
    let dialable = 0, fake = 0;
    data.forEach(function(row) {
      const st = String(row[ix_('Status')] || '').toLowerCase();
      if (DIALABLE.indexOf(st) === -1) return;
      dialable++;
      const phone = String(row[ix_('Phone')] || '').replace(/\D/g, '');
      if (/^1\d{3}55501\d{2}$/.test(phone)) fake++;
    });
    if (dialable) {
      out.push(code + ': ' + dialable + ' dialable, ' + fake + ' of them test (' +
               (dialable - fake) + ' real)');
    }
  });
  const msg = out.length ? out.join('\n') : 'No dialable leads anywhere.';
  Logger.log(msg);
  return msg;
}

// Read-only. Confirms the script's timezone agrees with TZ and that a stamp
// written now reads back as written now — the check that would have caught
// stacks releasing the moment they were reserved.
function checkClock() {
  const written = stamp_();
  const readBack = parseStamp_(written);
  const driftMin = Math.round((Date.now() - readBack) / 60000);
  let scriptTz = '(unknown)';
  try { scriptTz = Session.getScriptTimeZone(); } catch (e) {}
  let sheetTz = '(unknown)';
  try { sheetTz = SpreadsheetApp.openById(sheets_()[Object.keys(sheets_())[0]]).getSpreadsheetTimeZone(); } catch (e) {}

  const msg = 'TZ constant : ' + TZ +
    '\nScript zone : ' + scriptTz +
    '\nSheet zone  : ' + sheetTz +
    '\nStamp now   : ' + written +
    '\nReads back  : ' + driftMin + ' minutes ago' +
    '\n\n' + (Math.abs(driftMin) <= 1
      ? 'Correct. A lead reserved now will not look idle.'
      : 'WRONG — a lead reserved now already looks ' + driftMin +
        ' minutes old, so the idle sweep will release stacks immediately.');
  Logger.log(msg);
  return msg;
}

// Read-only: the header and one row side by side, so column drift is
// obvious before a large upload lands on top of it. Pass a state code.
function inspectLeadRow(stateCode) {
  const code = String(stateCode || 'OH').toUpperCase();
  if (!sheets_()[code]) return 'No sheet for ' + code;
  const sheet = SpreadsheetApp.openById(sheets_()[code]).getSheetByName('Leads');
  if (!sheet) return code + ': no Leads tab';

  const width = sheet.getLastColumn();
  const header = sheet.getRange(1, 1, 1, width).getValues()[0];
  const lines = [code + ': ' + width + ' columns, ' +
                 Math.max(0, sheet.getLastRow() - 1) + ' rows'];

  const mismatch = [];
  LEAD_COLS.forEach(function(name, i) {
    if (String(header[i] || '').trim() !== name) {
      mismatch.push('col ' + (i + 1) + ' expected "' + name + '" got "' + (header[i] || '') + '"');
    }
  });
  lines.push(mismatch.length ? 'HEADER MISMATCH:\n  ' + mismatch.join('\n  ')
                             : 'Header matches the schema exactly.');

  if (sheet.getLastRow() >= 2) {
    const row = sheet.getRange(2, 1, 1, width).getValues()[0];
    lines.push('\nFirst row:');
    header.forEach(function(h, i) {
      const v = row[i];
      if (v !== '' && v !== null && v !== undefined) {
        lines.push('  ' + (String(h) + '                    ').slice(0, 20) + ' = ' + v);
      }
    });
  }
  const msg = lines.join('\n');
  Logger.log(msg);
  return msg;
}

// What state is each spreadsheet actually in? Read-only.
function inspectSheets() {
  const out = [];
  Object.keys(sheets_()).forEach(function(state) {
    const ss = SpreadsheetApp.openById(sheets_()[state]);
    const tabs = ss.getSheets().map(function(sh) {
      return sh.getName() + '(' + Math.max(0, sh.getLastRow() - 1) + ')';
    });
    const leads = ss.getSheetByName('Leads');
    const migrated = !!(leads && leads.getLastColumn() > 0 &&
      String(leads.getRange(1, 1).getValue()).trim() === 'Lead ID');
    out.push(state + ': ' + (migrated ? 'MIGRATED' : 'not migrated') + ' — ' + tabs.join(', '));
  });
  const msg = out.join('\n');
  Logger.log(msg);
  return msg;
}

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════
const DATE_COLS = new Set(['DOB', 'Date Added', 'Last Call Start', 'Last Call End', 'Locked At',
  'Last Activity At', 'Call Open At', 'Callback Hold Until', 'Status At',
  'DCID Date', 'DCID Reviewed At', 'Sold Date', 'Follow Up At',
  'Wrong Number Date', 'Scheduled Date', 'Archived At']);
function rowToObj(row) {
  const obj = {};
  LEAD_COLS.forEach((col, i) => {
    const key = col.replace(/\s+/g, '_').toLowerCase();
    // Format Date-type columns as strings so JSON doesn't serialize them as ISO
    obj[key] = DATE_COLS.has(col) ? fmtDateTime(row[i]) : row[i];
  });
  // The UI has read these camelCase keys since before callbacks lived on the
  // lead row. Keep them rather than rewrite 22 call sites.
  obj.callbackDate = fmtDate(row[ix_('Callback Date')]);
  obj.callbackTime = fmtTime(row[ix_('Callback Time')]);
  return obj;
}


// Format Sheets Date value → 'yyyy-MM-dd' string (empty if null/blank)
// (An earlier fmtDate lived here. It was shadowed by the one below — JavaScript
// keeps the last declaration — so it had never run, and it formatted dates
// differently. Removed rather than left for someone to edit and wonder why
// nothing changed.)
// All Sheets stores dates as UTC midnight. When reading date-only or time-only cells,
// we format in UTC to preserve the raw value. Only true datetimes get converted to TZ.

// Dates return MM/dd/yyyy. Sheets auto-parses cell values using the SPREADSHEET's
// timezone (not the script's). Cache once per invocation for perf.

let _cachedSheetTZ = null;
function sheetTZ() {
  if (_cachedSheetTZ) return _cachedSheetTZ;
  try {
    _cachedSheetTZ = SpreadsheetApp.openById(sheets_()['AZ']).getSpreadsheetTimeZone();
  } catch (e) {
    try { _cachedSheetTZ = Session.getScriptTimeZone(); } catch (e2) { _cachedSheetTZ = TZ; }
  }
  return _cachedSheetTZ;
}

function fmtDate(v) {
  if (!v && v !== 0) return '';
  if (v instanceof Date) return Utilities.formatDate(v, sheetTZ(), 'MM/dd/yyyy');
  const s = String(v);
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[2] + '/' + isoMatch[3] + '/' + isoMatch[1];
  return s;
}

function fmtTime(v) {
  if (!v && v !== 0) return '';
  if (v instanceof Date) return Utilities.formatDate(v, sheetTZ(), 'HH:mm');
  return String(v);
}

function fmtDateTime(v) {
  if (!v && v !== 0) return '';
  if (v instanceof Date) {
    const stz = sheetTZ();
    // If time is midnight in the SCRIPT's tz, treat as date-only
    const hm = Utilities.formatDate(v, stz, 'HHmmss');
    if (hm === '000000') return Utilities.formatDate(v, stz, 'MM/dd/yyyy');
    return Utilities.formatDate(v, TZ, 'MM/dd/yyyy HH:mm:ss');
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    try { return Utilities.formatDate(new Date(s), TZ, 'MM/dd/yyyy HH:mm:ss'); } catch (e) {}
  }
  const isoDate = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) return isoDate[2] + '/' + isoDate[3] + '/' + isoDate[1];
  return s;
}
