/**
 * FreedomCRM — Google Apps Script Backend
 * Deploy as Web App: Execute as "Me", Access: "Anyone"
 * Then paste the Web App URL into index.html CONFIG.APPS_SCRIPT_URL
 */

// ══════════════════════════════════════════════════════════════════
// CONFIGURATION — 3 state sheet IDs
// ══════════════════════════════════════════════════════════════════
const SHEETS = {
  AZ: '16XtlVoT_4XxtPzfH9THF0f9eWnpN4-g6LSJ7Jkeqdic',
  VA: '1Rofg1YZwb1l7RN2pZ9_LbBoP28_zOLeakYGJqSqaFoc',
  OH: '1Z8qf3oprwWpek3LdDCEJnEjOs2OE1eJdJc2mqsVoB4M'
};
const BATCH_SIZE = 5;
const LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const CALLBACK_RESURRECT_MS = 24 * 60 * 60 * 1000; // 24 hours
const REVIEW_THRESHOLD = 30; // attempts before flagging for review
const TZ = 'America/Los_Angeles'; // Pacific Time

// Column layout (Leads tab & all disposition tabs share these first cols)
const LEAD_COLS = [
  'Name', 'Phone', 'Email', 'Address', 'City', 'State',
  'Lead Type', 'Beneficiary', 'Hobby', 'Age', 'DOB',
  'Status', 'Locked By', 'Locked At',
  'Attempts', 'Last Call Agent', 'Last Call Start', 'Last Call End', 'Last Call Duration',
  'Date Added'
];
const CALLBACK_EXTRA = ['Callback Date', 'Callback Time', 'Scheduled By', 'Scheduled Date'];
const DCID_EXTRA = ['DCID Reason', 'DCID Date', 'DCID Agent'];
const SOLD_EXTRA = ['Monthly Premium', 'Carrier', 'First Draft Date', 'Recurring Draft Date', 'Reason for Policy', 'Sale Notes', 'Sold Date', 'Sold Agent'];
const WRONG_EXTRA = ['Wrong Number Date', 'Wrong Number Agent'];
const REVIEW_EXTRA = ['Flagged Date', 'Flag Reason'];

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
function initSetup() {
  Object.keys(SHEETS).forEach(state => {
    const ss = SpreadsheetApp.openById(SHEETS[state]);
    setupTabs(ss, state);
  });
  Logger.log('Setup complete for all 3 state sheets.');
}

function setupTabs(ss, stateCode) {
  // Rename or remove default "Sheet1"
  const defaultSheet = ss.getSheetByName('Sheet1');

  // Define all tabs and their headers
  const tabs = [
    { name: 'Leads', headers: LEAD_COLS },
    { name: 'Callbacks', headers: LEAD_COLS.concat(CALLBACK_EXTRA) },
    { name: 'DCID', headers: LEAD_COLS.concat(DCID_EXTRA) },
    { name: 'Sold', headers: LEAD_COLS.concat(SOLD_EXTRA) },
    { name: 'Wrong Numbers', headers: LEAD_COLS.concat(WRONG_EXTRA) },
    { name: 'Review', headers: LEAD_COLS.concat(REVIEW_EXTRA) }
  ];

  tabs.forEach(t => {
    let sheet = ss.getSheetByName(t.name);
    if (!sheet) sheet = ss.insertSheet(t.name);
    sheet.clear();
    sheet.getRange(1, 1, 1, t.headers.length).setValues([t.headers]).setFontWeight('bold').setBackground('#e8f0fe');
    sheet.setFrozenRows(1);
  });

  // Populate dummy leads in Leads tab with state-adjusted data
  const leadsSheet = ss.getSheetByName('Leads');
  const now = new Date();
  const nowStr = Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm:ss');
  const rows = DUMMY_LEADS.map(row => {
    const r = row.slice();
    r[5] = stateCode; // State column
    // Fill remaining cols
    return r.concat(['', '', '', 0, '', '', '', '', nowStr]);
  });
  leadsSheet.getRange(2, 1, rows.length, LEAD_COLS.length).setValues(rows);

  // Remove default Sheet1 if it exists and isn't one of our tabs
  if (defaultSheet && ss.getSheets().length > 6) {
    ss.deleteSheet(defaultSheet);
  }
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

// The ids whose leads this user may see: everyone on their own upline chain.
function visibleOwnerIds_(user) {
  return String(user.path || '').split('>').filter(String);
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
  Object.keys(SHEETS).forEach(function(state) {
    const sh = SpreadsheetApp.openById(SHEETS[state]).getSheetByName('Leads');
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

  const sh = authSS_().getSheetByName(AGENTS_SHEET);
  sh.getRange(agent.row, 5).setValue(Utilities.formatDate(new Date(), TZ, 'MM/dd/yyyy HH:mm:ss'));

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

function doGet(e) {
  try {
    const action = (e.parameter.action || 'getLeads');

    const user = verifySession_(e.parameter.s);
    if (!user) return jsonOut({ error: 'auth_required' });

    const isAdmin = user.role === 'admin';
    // Managers see the same screen, scoped to their branch; agents get nothing.
    if ((action === 'adminStats' || action === 'adminLocks') &&
        user.role !== 'admin' && user.role !== 'manager') {
      return jsonOut({ error: 'not_permitted' });
    }

    const me = userByEmail_(user.email);
    let result;
    switch (action) {
      case 'createUser':   return jsonOut(me ? createUser_(me, body)                        : { error: 'No user record.' });
      case 'reassignUser': return jsonOut(me ? reassignUser_(me, body.userId, body.parentId) : { error: 'No user record.' });
      case 'disableUser':  return jsonOut(me ? disableUser_(me, body.userId)                 : { error: 'No user record.' });
      case 'promoteUser':  return jsonOut(me ? promoteUser_(me, body.userId)                 : { error: 'No user record.' });
      case 'demoteUser':   return jsonOut(me ? demoteUser_(me, body.userId)                  : { error: 'No user record.' });
      case 'revokeUser':   return jsonOut(me ? revokeUser_(me, body.userId)                  : { error: 'No user record.' });
      case 'pauseUser':    return jsonOut(me ? setPaused_(me, body.userId, true)             : { error: 'No user record.' });
      case 'resumeUser':   return jsonOut(me ? setPaused_(me, body.userId, false)            : { error: 'No user record.' });
    }
    switch (action) {
      // The agent is whoever the token says, never e.parameter.agent.
      case 'getLeads':    result = getLeads(e.parameter.state, user.name);
                          logActivity_(user, 'getLeads', '', e.parameter.state); break;
      case 'search':      result = search(e.parameter.q); break;
      case 'myCallbacks': result = myCallbacks(user.name); break;
      case 'leaderboard': result = leaderboard(); break;
      case 'adminStats': {
        const me = userByEmail_(user.email);
        result = adminStats(e.parameter.range, scopeNamesFor_(me)); break;
      }
      case 'adminLocks': {
        const me = userByEmail_(user.email);
        result = adminLocks(scopeNamesFor_(me)); break;
      }
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

    let result;
    switch (action) {
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
function getLeads(stateCode, agent) {
  if (!SHEETS[stateCode]) return { error: 'invalid state' };
  const ss = SpreadsheetApp.openById(SHEETS[stateCode]);

  // 1. Clear stale locks
  clearStaleLocks(ss);

  // 2. Resurrect callbacks past their scheduled + 24hrs
  resurrectCallbacks(ss);

  // 3. Fetch available leads (Status is blank)
  const leadsSheet = ss.getSheetByName('Leads');
  const lastRow = leadsSheet.getLastRow();
  if (lastRow < 2) return { leads: [], state: stateCode };

  const data = leadsSheet.getRange(2, 1, lastRow - 1, LEAD_COLS.length).getValues();
  const statusIdx = LEAD_COLS.indexOf('Status');
  const attemptsIdx = LEAD_COLS.indexOf('Attempts');

  // Available = Status blank
  const available = [];
  data.forEach((row, i) => {
    if (!row[statusIdx]) {
      available.push({ rowIndex: i + 2, row: row, attempts: Number(row[attemptsIdx]) || 0 });
    }
  });

  // Sort: 0-attempts first, then random
  const zeroAttempts = available.filter(l => l.attempts === 0);
  const attempted = available.filter(l => l.attempts > 0);
  shuffle(zeroAttempts);
  shuffle(attempted);
  const prioritized = zeroAttempts.concat(attempted);

  // Take first BATCH_SIZE
  const batch = prioritized.slice(0, BATCH_SIZE);
  if (batch.length === 0) return { leads: [], state: stateCode };

  // Lock them
  const nowStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  batch.forEach(item => {
    leadsSheet.getRange(item.rowIndex, statusIdx + 1).setValue('In Progress');
    leadsSheet.getRange(item.rowIndex, LEAD_COLS.indexOf('Locked By') + 1).setValue(agent || '');
    leadsSheet.getRange(item.rowIndex, LEAD_COLS.indexOf('Locked At') + 1).setValue(nowStr);
  });

  // Return as objects
  const leads = batch.map(item => ({
    rowIndex: item.rowIndex,
    state: stateCode,
    ...rowToObj(item.row)
  }));

  return { leads: leads, state: stateCode };
}

function clearStaleLocks(ss) {
  const leadsSheet = ss.getSheetByName('Leads');
  const lastRow = leadsSheet.getLastRow();
  if (lastRow < 2) return;
  const data = leadsSheet.getRange(2, 1, lastRow - 1, LEAD_COLS.length).getValues();
  const statusIdx = LEAD_COLS.indexOf('Status');
  const lockedAtIdx = LEAD_COLS.indexOf('Locked At');
  const now = Date.now();
  data.forEach((row, i) => {
    if (row[statusIdx] === 'In Progress' && row[lockedAtIdx]) {
      const lockTime = new Date(row[lockedAtIdx]).getTime();
      if (now - lockTime > LOCK_TIMEOUT_MS) {
        leadsSheet.getRange(i + 2, statusIdx + 1).setValue('');
        leadsSheet.getRange(i + 2, LEAD_COLS.indexOf('Locked By') + 1).setValue('');
        leadsSheet.getRange(i + 2, lockedAtIdx + 1).setValue('');
      }
    }
  });
}

function resurrectCallbacks(ss) {
  const cbSheet = ss.getSheetByName('Callbacks');
  const leadsSheet = ss.getSheetByName('Leads');
  const lastRow = cbSheet.getLastRow();
  if (lastRow < 2) return;

  const headers = LEAD_COLS.concat(CALLBACK_EXTRA);
  const data = cbSheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const dateIdx = headers.indexOf('Callback Date');
  const timeIdx = headers.indexOf('Callback Time');
  const now = new Date();

  // Iterate in reverse so we can delete rows safely
  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    if (!row[dateIdx] || !row[timeIdx]) continue;
    const cbDateTime = parseCallbackDateTime(row[dateIdx], row[timeIdx]);
    if (!cbDateTime) continue;
    if (now.getTime() - cbDateTime.getTime() > CALLBACK_RESURRECT_MS) {
      // Move back to Leads
      const leadRow = row.slice(0, LEAD_COLS.length);
      // Clear status fields
      leadRow[LEAD_COLS.indexOf('Status')] = '';
      leadRow[LEAD_COLS.indexOf('Locked By')] = '';
      leadRow[LEAD_COLS.indexOf('Locked At')] = '';
      leadsSheet.appendRow(leadRow);
      cbSheet.deleteRow(i + 2);
    }
  }
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
// NEXT — release lock, log call, increment attempts, check review threshold
// ══════════════════════════════════════════════════════════════════
function actionNext(body) {
  const ss = SpreadsheetApp.openById(SHEETS[body.state]);
  const sheet = ss.getSheetByName('Leads');
  const row = body.rowIndex;
  sheet.getRange(row, LEAD_COLS.indexOf('Status') + 1).setValue('');
  sheet.getRange(row, LEAD_COLS.indexOf('Locked By') + 1).setValue('');
  sheet.getRange(row, LEAD_COLS.indexOf('Locked At') + 1).setValue('');

  if (body.callStart) {
    sheet.getRange(row, LEAD_COLS.indexOf('Last Call Agent') + 1).setValue(body.agent || '');
    sheet.getRange(row, LEAD_COLS.indexOf('Last Call Start') + 1).setValue(body.callStart);
    sheet.getRange(row, LEAD_COLS.indexOf('Last Call End') + 1).setValue(body.callEnd || '');
    sheet.getRange(row, LEAD_COLS.indexOf('Last Call Duration') + 1).setValue(body.callDuration || '');

    // Increment attempts
    const attemptsIdx = LEAD_COLS.indexOf('Attempts') + 1;
    const current = Number(sheet.getRange(row, attemptsIdx).getValue()) || 0;
    const newCount = current + 1;
    sheet.getRange(row, attemptsIdx).setValue(newCount);

    // Auto-flag to Review if >= threshold
    if (newCount >= REVIEW_THRESHOLD) {
      moveToReview(ss, row, body.agent);
    }
  }
  return { success: true };
}

function moveToReview(ss, rowIndex, agent) {
  const leadsSheet = ss.getSheetByName('Leads');
  const reviewSheet = ss.getSheetByName('Review');
  const rowData = leadsSheet.getRange(rowIndex, 1, 1, LEAD_COLS.length).getValues()[0];
  const now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  const reviewRow = rowData.concat([now, 'Exceeded ' + REVIEW_THRESHOLD + ' attempts']);
  reviewSheet.appendRow(reviewRow);
  leadsSheet.deleteRow(rowIndex);
}

// ══════════════════════════════════════════════════════════════════
// DISPOSITIONS — DCID, Sold, Wrong Number, Callback
// ══════════════════════════════════════════════════════════════════
function actionDCID(body) {
  return moveLead(body.state, body.rowIndex, 'DCID', DCID_EXTRA, [
    body.reason || '',
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
    body.agent || ''
  ], body);
}

function actionSold(body) {
  return moveLead(body.state, body.rowIndex, 'Sold', SOLD_EXTRA, [
    body.premium || '',
    body.carrier || '',
    body.firstDraft || '',
    body.recurringDraft || '',
    body.reason || '',
    body.notes || '',
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
    body.agent || ''
  ], body);
}

function actionWrong(body) {
  return moveLead(body.state, body.rowIndex, 'Wrong Numbers', WRONG_EXTRA, [
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
    body.agent || ''
  ], body);
}

function actionCallback(body) {
  // Convert ISO date (YYYY-MM-DD) → US format (MM/DD/YYYY) so Sheets parses in
  // local timezone, not UTC. Time is kept as literal text via setNumberFormat('@')
  // below to prevent any auto-parsing.
  const isoDate = String(body.callbackDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const dateVal = isoDate ? (isoDate[2] + '/' + isoDate[3] + '/' + isoDate[1]) : (body.callbackDate || '');
  const timeVal = body.callbackTime || '';
  const result = moveLead(body.state, body.rowIndex, 'Callbacks', CALLBACK_EXTRA, [
    dateVal, timeVal, body.agent || '',
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss')
  ], body);
  // Force the newly-written callback date + time cells to plain text so future
  // reads return the exact string (no timezone shifts).
  try {
    const cbSheet = SpreadsheetApp.openById(SHEETS[body.state]).getSheetByName('Callbacks');
    const newRow = cbSheet.getLastRow();
    const dateCol = LEAD_COLS.length + 1; // 1-indexed
    const timeCol = LEAD_COLS.length + 2;
    cbSheet.getRange(newRow, dateCol).setNumberFormat('@').setValue(dateVal);
    cbSheet.getRange(newRow, timeCol).setNumberFormat('@').setValue(timeVal);
  } catch (e) {}
  return result;
}

// Move lead from Leads (or Callbacks) tab into destination tab
function moveLead(stateCode, rowIndex, destTabName, extraCols, extraValues, body) {
  const ss = SpreadsheetApp.openById(SHEETS[stateCode]);
  const sourceTab = body.sourceTab || 'Leads';
  const source = ss.getSheetByName(sourceTab);
  const dest = ss.getSheetByName(destTabName);

  const sourceHeaders = (sourceTab === 'Callbacks') ? LEAD_COLS.concat(CALLBACK_EXTRA) : LEAD_COLS;
  const rowData = source.getRange(rowIndex, 1, 1, sourceHeaders.length).getValues()[0];
  const baseData = rowData.slice(0, LEAD_COLS.length);

  // Log call data if provided
  if (body.callStart) {
    baseData[LEAD_COLS.indexOf('Last Call Agent')] = body.agent || '';
    baseData[LEAD_COLS.indexOf('Last Call Start')] = body.callStart;
    baseData[LEAD_COLS.indexOf('Last Call End')] = body.callEnd || '';
    baseData[LEAD_COLS.indexOf('Last Call Duration')] = body.callDuration || '';
    const attemptsIdx = LEAD_COLS.indexOf('Attempts');
    baseData[attemptsIdx] = (Number(baseData[attemptsIdx]) || 0) + 1;
  }

  // Clear lock fields
  baseData[LEAD_COLS.indexOf('Status')] = '';
  baseData[LEAD_COLS.indexOf('Locked By')] = '';
  baseData[LEAD_COLS.indexOf('Locked At')] = '';

  const destRow = baseData.concat(extraValues);
  dest.appendRow(destRow);
  source.deleteRow(rowIndex);
  return { success: true };
}

function actionReturnToPool(body) {
  const ss = SpreadsheetApp.openById(SHEETS[body.state]);
  const sourceTab = body.sourceTab || 'Callbacks';
  const source = ss.getSheetByName(sourceTab);
  const dest = ss.getSheetByName('Leads');
  const rowData = source.getRange(body.rowIndex, 1, 1, LEAD_COLS.length).getValues()[0];
  rowData[LEAD_COLS.indexOf('Status')] = '';
  rowData[LEAD_COLS.indexOf('Locked By')] = '';
  rowData[LEAD_COLS.indexOf('Locked At')] = '';
  dest.appendRow(rowData);
  source.deleteRow(body.rowIndex);
  return { success: true };
}

// ══════════════════════════════════════════════════════════════════
// RELEASE ALL — end dial session
// ══════════════════════════════════════════════════════════════════
function actionReleaseAll(body) {
  Object.keys(SHEETS).forEach(state => {
    const ss = SpreadsheetApp.openById(SHEETS[state]);
    releaseAgentLocks(ss, body.agent);
  });
  return { success: true };
}

function actionForceRelease(body) {
  // Admin force-release specific agent's locks in a state (or all states)
  if (body.state) {
    const ss = SpreadsheetApp.openById(SHEETS[body.state]);
    releaseAgentLocks(ss, body.agent);
  } else {
    Object.keys(SHEETS).forEach(state => {
      const ss = SpreadsheetApp.openById(SHEETS[state]);
      releaseAgentLocks(ss, body.agent);
    });
  }
  return { success: true };
}

function releaseAgentLocks(ss, agent) {
  const sheet = ss.getSheetByName('Leads');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const data = sheet.getRange(2, 1, lastRow - 1, LEAD_COLS.length).getValues();
  const statusIdx = LEAD_COLS.indexOf('Status');
  const lockedByIdx = LEAD_COLS.indexOf('Locked By');
  data.forEach((row, i) => {
    if (row[statusIdx] === 'In Progress' && row[lockedByIdx] === agent) {
      sheet.getRange(i + 2, statusIdx + 1).setValue('');
      sheet.getRange(i + 2, lockedByIdx + 1).setValue('');
      sheet.getRange(i + 2, LEAD_COLS.indexOf('Locked At') + 1).setValue('');
    }
  });
}

// ══════════════════════════════════════════════════════════════════
// SEARCH — across all states, Leads + Callbacks tabs
// ══════════════════════════════════════════════════════════════════
function search(query) {
  if (!query || query.length < 2) return { results: [] };
  const q = query.toLowerCase().replace(/\D/g, '') || query.toLowerCase();
  const qName = query.toLowerCase();
  const results = [];

  Object.keys(SHEETS).forEach(state => {
    const ss = SpreadsheetApp.openById(SHEETS[state]);
    ['Leads', 'Callbacks'].forEach(tabName => {
      const sheet = ss.getSheetByName(tabName);
      const lastRow = sheet.getLastRow();
      if (lastRow < 2) return;
      const cols = (tabName === 'Callbacks') ? LEAD_COLS.concat(CALLBACK_EXTRA) : LEAD_COLS;
      const data = sheet.getRange(2, 1, lastRow - 1, cols.length).getValues();
      const nameIdx = 0, phoneIdx = 1;
      data.forEach((row, i) => {
        const nameMatch = String(row[nameIdx]).toLowerCase().includes(qName);
        const phoneMatch = String(row[phoneIdx]).replace(/\D/g, '').includes(q);
        if (nameMatch || phoneMatch) {
          results.push({
            rowIndex: i + 2,
            state: state,
            sourceTab: tabName,
            ...rowToObj(row.slice(0, LEAD_COLS.length)),
            callbackDate: tabName === 'Callbacks' ? fmtDate(row[LEAD_COLS.length]) : null,
            callbackTime: tabName === 'Callbacks' ? fmtTime(row[LEAD_COLS.length + 1]) : null
          });
        }
      });
    });
  });
  return { results: results.slice(0, 25) };
}

// ══════════════════════════════════════════════════════════════════
// MY CALLBACKS — agent's unresolved callbacks across all states
// ══════════════════════════════════════════════════════════════════
function myCallbacks(agent) {
  const results = [];
  Object.keys(SHEETS).forEach(state => {
    const ss = SpreadsheetApp.openById(SHEETS[state]);
    const sheet = ss.getSheetByName('Callbacks');
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    const cols = LEAD_COLS.concat(CALLBACK_EXTRA);
    const data = sheet.getRange(2, 1, lastRow - 1, cols.length).getValues();
    const scheduledByIdx = LEAD_COLS.length + 2;
    data.forEach((row, i) => {
      if (row[scheduledByIdx] === agent) {
        results.push({
          rowIndex: i + 2,
          state: state,
          sourceTab: 'Callbacks',
          ...rowToObj(row.slice(0, LEAD_COLS.length)),
          callbackDate: fmtDate(row[LEAD_COLS.length]),
          callbackTime: fmtTime(row[LEAD_COLS.length + 1])
        });
      }
    });
  });
  return { callbacks: results };
}

// ══════════════════════════════════════════════════════════════════
// LEADERBOARD — today's top performers
// ══════════════════════════════════════════════════════════════════
function leaderboard() {
  const todayStart = getRangeCutoff('today');
  const agentStats = {};
  const ensureAgent = (a) => {
    agentStats[a] = agentStats[a] || { agent: a, calls: 0, sales: 0, dcid: 0, wrong: 0, callbacks: 0 };
  };

  Object.keys(SHEETS).forEach(state => {
    const ss = SpreadsheetApp.openById(SHEETS[state]);

    // Count calls today across ALL tabs (Last Call Agent + Last Call Start)
    ['Leads', 'DCID', 'Sold', 'Wrong Numbers', 'Callbacks'].forEach(tabName => {
      const sheet = ss.getSheetByName(tabName);
      const rows = sheet.getLastRow();
      if (rows < 2) return;
      const cols = sheet.getLastColumn();
      const data = sheet.getRange(2, 1, rows - 1, cols).getValues();
      const startIdx = LEAD_COLS.indexOf('Last Call Start');
      const agentIdx = LEAD_COLS.indexOf('Last Call Agent');
      data.forEach(row => {
        if (dateInRange(row[startIdx], todayStart) && row[agentIdx]) {
          ensureAgent(row[agentIdx]);
          agentStats[row[agentIdx]].calls++;
        }
      });
    });

    // Count sales today (Sold tab, Sold Date + Sold Agent)
    countAgentDisp(ss, 'Sold', LEAD_COLS.length + 6, LEAD_COLS.length + 7, todayStart, agentStats, 'sales', ensureAgent);
    // Count DCID today
    countAgentDisp(ss, 'DCID', LEAD_COLS.length + 1, LEAD_COLS.length + 2, todayStart, agentStats, 'dcid', ensureAgent);
    // Count Wrong # today
    countAgentDisp(ss, 'Wrong Numbers', LEAD_COLS.length, LEAD_COLS.length + 1, todayStart, agentStats, 'wrong', ensureAgent);
    // Count Callbacks scheduled today
    countAgentDisp(ss, 'Callbacks', LEAD_COLS.length + 3, LEAD_COLS.length + 2, todayStart, agentStats, 'callbacks', ensureAgent);
  });

  const rows = Object.values(agentStats).sort((a, b) => b.sales - a.sales || b.calls - a.calls);
  return { leaderboard: rows };
}

function countAgentDisp(ss, tabName, dateColIdx, agentColIdx, cutoff, agentStats, key, ensureAgent) {
  const sheet = ss.getSheetByName(tabName);
  const rows = sheet.getLastRow();
  if (rows < 2) return;
  const cols = sheet.getLastColumn();
  const data = sheet.getRange(2, 1, rows - 1, cols).getValues();
  data.forEach(row => {
    if (dateInRange(row[dateColIdx], cutoff) && row[agentColIdx]) {
      ensureAgent(row[agentColIdx]);
      agentStats[row[agentColIdx]][key]++;
    }
  });
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

function adminStats(range, scope) {
  const cutoff = getRangeCutoff(range || 'today');
  const perState = {};
  const totals = { calls: 0, sales: 0, dcid: 0, wrong: 0, callbacks: 0 };
  const agents = {};

  Object.keys(SHEETS).forEach(state => {
    const ss = SpreadsheetApp.openById(SHEETS[state]);
    const s = {
      available: 0, inProgress: 0,
      callbacks: 0, dcid: 0, sold: 0, wrong: 0, review: 0
    };

    // Count status in Leads tab (available vs In Progress)
    const leadsSheet = ss.getSheetByName('Leads');
    const lr = leadsSheet.getLastRow();
    if (lr >= 2) {
      const data = leadsSheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
      const statusIdx = LEAD_COLS.indexOf('Status');
      const lockedByIdx = LEAD_COLS.indexOf('Locked By');
      data.forEach(row => {
        if (row[statusIdx] === 'In Progress') {
          if (inScope_(scope, row[lockedByIdx])) s.inProgress++;
        } else s.available++;   // pool-wide: leads have no owner until phase 2
      });
    }

    // Count calls in range across ALL tabs — captures calls that ended in Sold/DCID/Wrong/Callback
    ['Leads', 'DCID', 'Sold', 'Wrong Numbers', 'Callbacks'].forEach(tabName => {
      const sheet = ss.getSheetByName(tabName);
      const rows = sheet.getLastRow();
      if (rows < 2) return;
      const cols = sheet.getLastColumn();
      const data = sheet.getRange(2, 1, rows - 1, cols).getValues();
      const startIdx = LEAD_COLS.indexOf('Last Call Start');
      const agentIdx = LEAD_COLS.indexOf('Last Call Agent');
      data.forEach(row => {
        const d = row[startIdx];
        const a0 = row[agentIdx];
        if (d && dateInRange(d, cutoff) && inScope_(scope, a0)) {
          totals.calls++;
          const a = a0;
          if (a) {
            agents[a] = agents[a] || { agent: a, calls: 0, sales: 0, dcid: 0, wrong: 0, callbacks: 0, lastActive: '' };
            agents[a].calls++;
            const dStr = fmtDateTime(d);
            if (!agents[a].lastActive || dStr > agents[a].lastActive) agents[a].lastActive = dStr;
          }
        }
      });
    });

    s.callbacks = countInRange(ss, 'Callbacks', LEAD_COLS.length + 3, cutoff, totals, agents, 'callbacks', LEAD_COLS.length + 2, scope);
    s.dcid = countInRange(ss, 'DCID', LEAD_COLS.length + 1, cutoff, totals, agents, 'dcid', LEAD_COLS.length + 2, scope);
    s.sold = countInRange(ss, 'Sold', LEAD_COLS.length + 6, cutoff, totals, agents, 'sales', LEAD_COLS.length + 7, scope);
    s.wrong = countInRange(ss, 'Wrong Numbers', LEAD_COLS.length, cutoff, totals, agents, 'wrong', LEAD_COLS.length + 1, scope);
    s.review = ss.getSheetByName('Review').getLastRow() - 1;
    if (s.review < 0) s.review = 0;

    perState[state] = s;
  });

  return {
    range: range || 'today',
    perState: perState,
    totals: totals,
    agents: Object.values(agents).sort((a, b) => b.sales - a.sales || b.calls - a.calls)
  };
}

function countInRange(ss, tabName, dateColIdx, cutoff, totals, agents, agentKey, agentColIdx, scope) {
  const sheet = ss.getSheetByName(tabName);
  const lr = sheet.getLastRow();
  if (lr < 2) return 0;
  const cols = sheet.getLastColumn();
  const data = sheet.getRange(2, 1, lr - 1, cols).getValues();
  let count = 0;
  data.forEach(row => {
    const d = row[dateColIdx];
    const a0 = row[agentColIdx];
    if (d && dateInRange(d, cutoff) && inScope_(scope, a0)) {
      count++;
      totals[agentKey]++;
      const a = a0;
      if (a) {
        agents[a] = agents[a] || { agent: a, calls: 0, sales: 0, dcid: 0, wrong: 0, callbacks: 0, lastActive: '' };
        agents[a][agentKey]++;
        const dStr = fmtDateTime(d);
        if (!agents[a].lastActive || dStr > agents[a].lastActive) agents[a].lastActive = dStr;
      }
    }
  });
  return count;
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
  Object.keys(SHEETS).forEach(state => {
    const ss = SpreadsheetApp.openById(SHEETS[state]);
    const sheet = ss.getSheetByName('Leads');
    const lr = sheet.getLastRow();
    if (lr < 2) return;
    const data = sheet.getRange(2, 1, lr - 1, LEAD_COLS.length).getValues();
    const statusIdx = LEAD_COLS.indexOf('Status');
    const lockedByIdx = LEAD_COLS.indexOf('Locked By');
    const lockedAtIdx = LEAD_COLS.indexOf('Locked At');
    const nameIdx = LEAD_COLS.indexOf('Name');
    data.forEach((row, i) => {
      if (row[statusIdx] === 'In Progress' && inScope_(scope, row[lockedByIdx])) {
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
// HELPERS
// ══════════════════════════════════════════════════════════════════
const DATE_COLS = new Set(['DOB', 'Date Added', 'Last Call Start', 'Last Call End', 'Locked At']);
function rowToObj(row) {
  const obj = {};
  LEAD_COLS.forEach((col, i) => {
    const key = col.replace(/\s+/g, '_').toLowerCase();
    // Format Date-type columns as strings so JSON doesn't serialize them as ISO
    obj[key] = DATE_COLS.has(col) ? fmtDateTime(row[i]) : row[i];
  });
  return obj;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
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
    _cachedSheetTZ = SpreadsheetApp.openById(SHEETS.AZ).getSpreadsheetTimeZone();
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
