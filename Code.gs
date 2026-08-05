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
function doGet(e) {
  try {
    const action = (e.parameter.action || 'getLeads');
    let result;
    switch (action) {
      case 'getLeads': result = getLeads(e.parameter.state, e.parameter.agent); break;
      case 'search': result = search(e.parameter.q); break;
      case 'myCallbacks': result = myCallbacks(e.parameter.agent); break;
      case 'leaderboard': result = leaderboard(); break;
      case 'adminStats': result = adminStats(e.parameter.range); break;
      case 'adminLocks': result = adminLocks(); break;
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
    const dateStr = fmtDate(dateVal);
    const timeStr = fmtTime(timeVal);
    if (!dateStr || !timeStr) return null;
    return new Date(dateStr + 'T' + timeStr + ':00');
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
  return moveLead(body.state, body.rowIndex, 'Callbacks', CALLBACK_EXTRA, [
    body.callbackDate || '',
    body.callbackTime || '',
    body.agent || '',
    Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss')
  ], body);
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
function adminStats(range) {
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
      data.forEach(row => {
        if (row[statusIdx] === 'In Progress') s.inProgress++;
        else s.available++;
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
        if (d && dateInRange(d, cutoff)) {
          totals.calls++;
          const a = row[agentIdx];
          if (a) {
            agents[a] = agents[a] || { agent: a, calls: 0, sales: 0, dcid: 0, wrong: 0, callbacks: 0, lastActive: '' };
            agents[a].calls++;
            const dStr = fmtDateTime(d);
            if (!agents[a].lastActive || dStr > agents[a].lastActive) agents[a].lastActive = dStr;
          }
        }
      });
    });

    s.callbacks = countInRange(ss, 'Callbacks', LEAD_COLS.length + 3, cutoff, totals, agents, 'callbacks', LEAD_COLS.length + 2);
    s.dcid = countInRange(ss, 'DCID', LEAD_COLS.length + 1, cutoff, totals, agents, 'dcid', LEAD_COLS.length + 2);
    s.sold = countInRange(ss, 'Sold', LEAD_COLS.length + 6, cutoff, totals, agents, 'sales', LEAD_COLS.length + 7);
    s.wrong = countInRange(ss, 'Wrong Numbers', LEAD_COLS.length, cutoff, totals, agents, 'wrong', LEAD_COLS.length + 1);
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

function countInRange(ss, tabName, dateColIdx, cutoff, totals, agents, agentKey, agentColIdx) {
  const sheet = ss.getSheetByName(tabName);
  const lr = sheet.getLastRow();
  if (lr < 2) return 0;
  const cols = sheet.getLastColumn();
  const data = sheet.getRange(2, 1, lr - 1, cols).getValues();
  let count = 0;
  data.forEach(row => {
    const d = row[dateColIdx];
    if (d && dateInRange(d, cutoff)) {
      count++;
      totals[agentKey]++;
      const a = row[agentColIdx];
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
function adminLocks() {
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
      if (row[statusIdx] === 'In Progress') {
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

// Dates return MM/dd/yyyy. Sheets stores Date/Time cells in the SCRIPT's timezone,
// so we use Session.getScriptTimeZone() to read the raw value that was written.

function scriptTZ() {
  try { return Session.getScriptTimeZone(); } catch (e) { return TZ; }
}

function fmtDate(v) {
  if (!v && v !== 0) return '';
  if (v instanceof Date) return Utilities.formatDate(v, scriptTZ(), 'MM/dd/yyyy');
  const s = String(v);
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[2] + '/' + isoMatch[3] + '/' + isoMatch[1];
  return s;
}

function fmtTime(v) {
  if (!v && v !== 0) return '';
  if (v instanceof Date) return Utilities.formatDate(v, scriptTZ(), 'HH:mm');
  return String(v);
}

function fmtDateTime(v) {
  if (!v && v !== 0) return '';
  if (v instanceof Date) {
    const stz = scriptTZ();
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
