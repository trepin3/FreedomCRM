// ══════════════════════════════════════════════════════════════════
// LEAD SCHEMA — one tab per state, rows never move
//
// Disposition changes Status in place, so a lead keeps its Lead ID for life.
// That is what makes ?lead_id= addressable and gives Trellus something stable
// to write back against.
//
// Column order is deliberate. Selecting a dial batch only needs the first
// block, so the hot path reads ~16 columns instead of ~58 — at 10k leads that
// is the difference between a fast fetch and a slow one.
// ══════════════════════════════════════════════════════════════════

// Hot: everything needed to filter, reserve and prioritise a batch.
const LEAD_HOT = [
  'Lead ID', 'Status', 'Owner ID', 'Visibility', 'Shared With',
  'Reserved By', 'Reserved At', 'Last Activity At', 'Call Open At',
  'Attempts', 'Last Call Start', 'Callback Hold Until',
  'Name', 'Phone', 'State', 'Date Added'
];

// Warm: shown on the lead card.
const LEAD_WARM = [
  'Email', 'Address', 'City', 'Lead Type', 'Beneficiary', 'Hobby', 'Age', 'DOB'
];

// Cold: provenance and disposition detail, read only when something needs it.
const LEAD_COLD = [
  'Lead Source', 'Batch ID', 'Uploaded By', 'Batch Status',
  'Status Reason', 'Status At', 'Status By',
  'Last Call Agent ID', 'Last Call Agent', 'Last Call End', 'Last Call Duration',
  'Callback Date', 'Callback Time', 'Callback Agent ID', 'Callback Set At',
  'DCID Reason', 'DCID At', 'DCID Agent ID', 'DCID Review', 'DCID Reviewed By', 'DCID Reviewed At',
  'Monthly Premium', 'AP Amount', 'Carrier', 'First Draft Date', 'Recurring Draft Date',
  'Reason For Policy', 'Sale Notes', 'Sold At', 'Sold By ID', 'Follow Up At',
  'Wrong At', 'Wrong By ID',
  'Archived At', 'Archived By'
];

const LEAD_COLS = LEAD_HOT.concat(LEAD_WARM).concat(LEAD_COLD);
const HOT_LEN   = LEAD_HOT.length;

// Column lookup by name, 1-based for getRange.
const COL = (function () {
  const m = {};
  LEAD_COLS.forEach(function (n, i) { m[n] = i + 1; });
  return m;
})();

// Status values. Rows carry these instead of moving between tabs.
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

const VISIBILITY = { POOL: 'pool', EXCLUSIVE: 'exclusive' };

// Reservation: 15 minutes idle releases a batch, but an open call holds it —
// with a ceiling so a crash mid-call cannot freeze 150 leads indefinitely.
const RESERVE_SIZE        = 150;
const IDLE_RELEASE_MS     = 15 * 60 * 1000;
const OPEN_CALL_CEILING_MS = 2 * 60 * 60 * 1000;   // a call still open after this is treated as abandoned
const CALLBACK_HOLD_MS    = 72 * 60 * 60 * 1000;   // booking agent keeps it this long
const SOLD_FOLLOWUP_DAYS  = 3;

const SEED_LEAD_SOURCES = ['$1 Bang Bang', '$1 Goat', 'DashlyPro'];

