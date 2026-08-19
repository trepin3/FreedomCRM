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

const SHEET_SEED = {
  AZ: '16XtlVoT_4XxtPzfH9THF0f9eWnpN4-g6LSJ7Jkeqdic',
  VA: '1Rofg1YZwb1l7RN2pZ9_LbBoP28_zOLeakYGJqSqaFoc',
  OH: '1Z8qf3oprwWpek3LdDCEJnEjOs2OE1eJdJc2mqsVoB4M'
};

function stateRegistry_() {
  let extra = {};
  try {
    extra = JSON.parse(PropertiesService.getScriptProperties().getProperty('STATE_SHEETS') || '{}');
  } catch (e) {}
  return Object.assign({}, SHEET_SEED, extra);
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

    const ss = SpreadsheetApp.create('FreedomCRM Leads — ' + US_STATES[code] + ' (' + code + ')');
    setupTabs(ss, code);

    const reg = {};
    Object.keys(fresh).forEach(function(k) { if (!SHEET_SEED[k]) reg[k] = fresh[k]; });
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

// States with leads this user can actually dial. Cached briefly: the picker
// is hit on every sign-in and this reads every registered spreadsheet.
function listStates_(me) {
  const cache = CacheService.getScriptCache();
  const key = 'states_' + (me ? me.id : 'anon');
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
          if (DIALABLE.indexOf(st) !== -1 && !row[ix_('Locked By')]) available++;
        });
      }
    } catch (e) { return; }
    states.push({ code: code, name: US_STATES[code] || code, available: available, total: total });
  });

  states.sort(function(a, b) { return b.available - a.available || a.name.localeCompare(b.name); });
  const out = { states: states, all: US_STATES };
  cache.put(key, JSON.stringify(out), 120);
  return out;
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
  'First Name', 'Last Name', 'Zip'
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

// Reservation: 15 minutes idle releases a lead, but an open call holds it —
// with a ceiling, so a crash mid-call cannot freeze 150 leads indefinitely.
const RESERVE_SIZE         = 150;
const IDLE_RELEASE_MS      = 15 * 60 * 1000;
const OPEN_CALL_CEILING_MS = 2 * 60 * 60 * 1000;
const CALLBACK_HOLD_MS     = 72 * 60 * 60 * 1000;  // booking agent keeps it this long
const SOLD_FOLLOWUP_DAYS   = 3;

const SEED_LEAD_SOURCES = ['$1 Bang Bang', '$1 Goat', 'DashlyPro'];

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
  Object.keys(SHEET_SEED).forEach(function(state) {
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
  Logger.log('Seeded ' + DUMMY_LEADS.length + ' leads per state.');
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
    ss = SpreadsheetApp.create('FreedomCRM \u2014 Auth & Activity');
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

  return { email: agent.email, name: agent.name || payload.n, role: agent.role };
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
  if (agent.status !== 'active')   return { error: 'That account has been disabled.' };

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
                       'demoteUser', 'revokeUser', 'pauseUser', 'resumeUser'];

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
      case 'myBatches':   result = myBatches_(userByEmail_(user.email)); break;
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

    const user = verifySession_(body.s);
    if (!user) return jsonOut({ error: 'auth_required' });
    body.agent = user.name;          // ignore whatever the client claimed
    logActivity_(user, action, body.rowIndex ? ('row ' + body.rowIndex) : '', body.state);

    const ua = userAction_(user, action, body);
    if (ua) return jsonOut(ua);

    let result;
    switch (action) {
      case 'uploadLeads':    result = uploadLeads_(userByEmail_(user.email), body); break;
      case 'addSource':      result = addSource_(userByEmail_(user.email), body.name); break;
      case 'decideSource':   result = decideSource_(userByEmail_(user.email), body.name, body.decision, body.rename); break;
      case 'setBatchStatus': result = setBatchStatus_(userByEmail_(user.email), body.batchId, body.state, !!body.active); break;
      case 'setBatchVisibility': result = setBatchVisibility_(userByEmail_(user.email), body); break;
      case 'shareBatch':     result = shareBatch_(userByEmail_(user.email), body); break;
      case 'donateBatch':    result = donateBatch_(userByEmail_(user.email), body); break;
      case 'next': result = actionNext(body); break;
      case 'dcid': result = actionDCID(body); break;
      case 'sold': result = actionSold(body); break;
      case 'wrong': result = actionWrong(body); break;
      case 'callback': result = actionCallback(body); break;
      case 'releaseAll': result = actionReleaseAll(body); break;
      case 'forceRelease': result = actionForceRelease(body); break;
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
  const want = Number(size) || BATCH_SIZE;

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

    const avail = [];
    data.forEach(function(row, i) {
      const st = String(row[iStatus] || '').toLowerCase();
      if (DIALABLE.indexOf(st) === -1) return;
      if (row[iLockBy]) return;                       // someone holds it
      if (!canSee_(row, me)) return;                  // not mine to dial

      // A callback stays with the agent who booked it until the hold expires.
      const hold = row[iHold] ? new Date(row[iHold]).getTime() : 0;
      if (hold && now < hold && String(row[iCbAgent] || '') !== String(agent || '')) return;

      avail.push({
        rowIndex: i + 2, row: row,
        attempts: Number(row[iAtt]) || 0,
        last: row[iStart] ? new Date(row[iStart]).getTime() : 0
      });
    });

    // Never-dialled first, then longest since the last attempt.
    avail.sort(function(a, b) {
      if (a.attempts === 0 && b.attempts !== 0) return -1;
      if (b.attempts === 0 && a.attempts !== 0) return 1;
      return a.last - b.last;
    });

    const batch = avail.slice(0, want);
    if (!batch.length) return { leads: [], state: stateCode };

    const nowStr = stamp_();
    batch.forEach(function(item) {
      sheet.getRange(item.rowIndex, COL['Locked By']).setValue(agent || '');
      sheet.getRange(item.rowIndex, COL['Locked At']).setValue(nowStr);
      sheet.getRange(item.rowIndex, COL['Last Activity At']).setValue(nowStr);
    });
    SpreadsheetApp.flush();

    return {
      state: stateCode,
      leads: batch.map(function(item) {
        return Object.assign({ rowIndex: item.rowIndex, state: stateCode }, rowToObj(item.row));
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

  data.forEach(function(row, i) {
    if (!row[iLockBy]) return;
    const openAt = row[iOpen] ? new Date(row[iOpen]).getTime() : 0;
    if (openAt) {
      if (now - openAt < OPEN_CALL_CEILING_MS) return;   // still on the call
    } else {
      const act = row[iAct] ? new Date(row[iAct]).getTime() : 0;
      if (act && now - act < IDLE_RELEASE_MS) return;
    }
    clearLock_(sheet, i + 2);
  });
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

function stamp_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
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

  const now = stamp_();
  const write = Object.assign({
    'Status': status,
    'Status At': now,
    'Status By': body.agent || '',
    'Status Reason': body.reason || ''
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
    releaseAgentLocks(SpreadsheetApp.openById(sheets_()[state]), body.agent);
  });
  return { success: true };
}

function actionForceRelease(body) {
  const states = body.state ? [body.state] : activeStates_();
  states.forEach(function(state) {
    releaseAgentLocks(SpreadsheetApp.openById(sheets_()[state]), body.agent);
  });
  return { success: true };
}

function releaseAgentLocks(ss, agent) {
  const sheet = ss.getSheetByName('Leads');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const vals = sheet.getRange(2, COL['Locked By'], lastRow - 1, 1).getValues();
  vals.forEach(function(r, i) {
    if (String(r[0] || '') === String(agent || '')) clearLock_(sheet, i + 2);
  });
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
  const set = {};
  downlineOf_(me, true).forEach(function(u) {
    if (u.name) set[String(u.name).trim().toLowerCase()] = true;
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

// ══════════════════════════════════════════════════════════════════
// ADMIN LOCKS — live view of who has what locked
// ══════════════════════════════════════════════════════════════════
function adminLocks(scope) {
  const locks = [];
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
          agent: row[lockedByIdx],
          lockedAt: fmtDateTime(row[lockedAtIdx])
        });
      }
    });
  });
  // Group by agent
  const byAgent = {};
  locks.forEach(l => {
    byAgent[l.agent] = byAgent[l.agent] || { agent: l.agent, count: 0, states: {}, leads: [] };
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
function setupKeepWarm() {
  let url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  if (!url) url = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL') || '';
  if (!url) {
    return 'Could not find the web app URL. Deploy the web app first, then run this again.';
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

  const msg = 'Keep-warm installed, every 5 minutes between 6am and 9pm.\n' +
              'URL: ' + url + '\n' +
              'Test ping took ' + (Date.now() - t0) + 'ms\n' +
              'Response: ' + String(probe).slice(0, 300);
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
  // just burns quota.
  const hour = Number(Utilities.formatDate(new Date(), TZ, 'H'));
  if (hour < 6 || hour > 21) return;
  const url = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!url) return;
  try {
    UrlFetchApp.fetch(url + '?action=ping', { muteHttpExceptions: true });
  } catch (e) {}
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
    const lr = sheet.getLastRow();
    const mine = {};
    if (lr >= 2) {
      const existing = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
      existing.forEach(function(row) {
        const digits = String(row[ix_('Phone')] || '').replace(/\D/g, '');
        if (digits && String(row[ix_('Owner ID')] || '') === me.id) mine[digits] = true;
      });
    }

    const batchId = 'B' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd-HHmmss') + '-' + me.id;
    const idBase = nextLeadSeq_(sheet, state);
    const now = stamp_();
    let seq = 0, skipped = 0, noPhone = 0, wrongState = 0;
    const out = [];
    const seenInBatch = {};

    incoming.forEach(function(item) {
      const name  = String(item['Name'] || '').trim();
      const phone = String(item['Phone'] || '').replace(/\D/g, '');
      if (!name || !phone) { noPhone++; return; }

      // The client filters these out, but it is the client — and a lead in
      // the wrong state sheet gets dialled against the wrong TCPA window.
      const rowState = String(item['State'] || '').trim().toUpperCase();
      if (rowState && rowState !== state) { wrongState++; return; }
      if (mine[phone] || seenInBatch[phone]) { skipped++; return; }
      seenInBatch[phone] = true;

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
      skippedDuplicate: skipped, skippedIncomplete: noPhone, skippedWrongState: wrongState
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
    if (me.role !== 'admin' && String(row[ix_('Uploaded By')] || '') !== me.email) return;
    sheet.getRange(i + 2, COL['Batch Status']).setValue(active ? 'active' : 'removed');
    sheet.getRange(i + 2, COL['Status']).setValue(active ? STATUS.NEW : STATUS.REMOVED);
    touched++;
  });
  logActivity_(me, 'setBatchStatus', batchId + ' -> ' + (active ? 'active' : 'removed'), state);
  return { success: true, updated: touched };
}

function myBatches_(me) {
  const out = [];
  activeStates_().forEach(function(state) {
    const sheet = SpreadsheetApp.openById(sheets_()[state]).getSheetByName('Leads');
    const lr = sheet.getLastRow();
    if (lr < 2) return;
    const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
    const acc = {};
    data.forEach(function(row) {
      const b = String(row[ix_('Batch ID')] || '');
      if (!b) return;
      const by = String(row[ix_('Uploaded By')] || '');
      if (me.role !== 'admin' && by !== me.email) return;
      acc[b] = acc[b] || { batchId: b, state: state, uploadedBy: by,
                           source: String(row[ix_('Lead Source')] || ''),
                           batchStatus: String(row[ix_('Batch Status')] || ''),
                           visibility: String(row[ix_('Visibility')] || VISIBILITY.POOL),
                           sharedWith: String(row[ix_('Shared With')] || ''),
                           ownerId: String(row[ix_('Owner ID')] || ''),
                           added: String(row[ix_('Date Added')] || ''), count: 0, locked: 0 };
      acc[b].count++;
      if (row[ix_('Locked By')]) acc[b].locked++;
    });
    Object.keys(acc).forEach(function(k) { out.push(acc[k]); });
  });
  out.sort(function(a, b) { return String(b.added).localeCompare(String(a.added)); });
  return { batches: out };
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
  return out;
}

function donateBatch_(me, body) {
  if (!me) return { error: 'No user record.' };
  const target = donationTarget_(me);
  if (!target) return { error: 'You have no manager above you to donate to.' };

  const out = eachBatchRow_(me, body.batchId, body.state, function(sheet, rowIndex) {
    sheet.getRange(rowIndex, COL['Owner ID']).setValue(target.ownerId);
    sheet.getRange(rowIndex, COL['Visibility']).setValue(VISIBILITY.POOL);
    sheet.getRange(rowIndex, COL['Shared With']).setValue('');
  });
  if (out.error) return out;
  out.destination = target.label;
  logActivity_(me, 'donateBatch', body.batchId + ' -> ' + target.ownerId + ' (' + out.changed + ')', body.state);
  return out;
}

// Where a donation would land, so the UI can name it before asking.
function donationInfo_(me) {
  const t = donationTarget_(me);
  return t ? { destination: t.label, ownerId: t.ownerId }
           : { destination: '', ownerId: '' };
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
function fmtDate(v) {
  if (!v && v !== 0) return '';
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v);
}
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
