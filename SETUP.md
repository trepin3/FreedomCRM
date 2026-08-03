# FreedomCRM — Deployment Setup

## What was already done for you
- ✅ 3 Google Sheets created in your Drive:
  - **FreedomCRM - AZ Leads** (ID: `16XtlVoT_4XxtPzfH9THF0f9eWnpN4-g6LSJ7Jkeqdic`)
  - **FreedomCRM - VA Leads** (ID: `1Rofg1YZwb1l7RN2pZ9_LbBoP28_zOLeakYGJqSqaFoc`)
  - **FreedomCRM - OH Leads** (ID: `1Z8qf3oprwWpek3LdDCEJnEjOs2OE1eJdJc2mqsVoB4M`)
- ✅ Sheet IDs already hardcoded in `Code.gs`
- ✅ App pushed to `https://github.com/trepin3/FreedomCRM` and live at `https://trepin3.github.io/FreedomCRM/`

## Your one-time setup (5 minutes)

### Step 1 — Open Apps Script for one of your sheets
1. Open **FreedomCRM - AZ Leads** in Google Sheets
2. Menu: **Extensions → Apps Script**
3. In the script editor, delete any starter code
4. Copy the entire contents of `Code.gs` (from this folder) and paste it in
5. Click the 💾 save icon (name the project "FreedomCRM")

### Step 2 — Run the setup function (creates tabs + dummy leads)
1. In the Apps Script editor, in the function dropdown at the top, select **`initSetup`**
2. Click **▶ Run**
3. You'll see an authorization prompt — click **Review Permissions**
4. Pick your Google account, click **Advanced → Go to FreedomCRM (unsafe)** → **Allow**
5. Wait ~10 seconds. Check the execution log — you should see "Setup complete for all 3 state sheets."
6. Verify: open each sheet, you should now see 6 tabs (Leads, Callbacks, DCID, Sold, Wrong Numbers, Review) with the Leads tab pre-populated with 10 dummy leads

### Step 3 — Deploy the web app
1. In the Apps Script editor, click **Deploy → New deployment** (top right)
2. Click the ⚙️ gear icon next to "Select type" → choose **Web app**
3. Fill in:
   - **Description:** FreedomCRM API
   - **Execute as:** Me (your@email)
   - **Who has access:** Anyone
4. Click **Deploy**
5. Click **Authorize access** if prompted, pick your account, allow permissions
6. **Copy the Web App URL** — it looks like:
   `https://script.google.com/macros/s/AKfycb.../exec`

### Step 4 — Paste the URL into FreedomCRM
1. Open `https://github.com/trepin3/FreedomCRM/blob/main/index.html`
2. Click the pencil icon (edit)
3. Find this line near the top of the `<script>` block:
   ```js
   APPS_SCRIPT_URL: 'REPLACE_WITH_YOUR_APPS_SCRIPT_WEB_APP_URL',
   ```
4. Replace `REPLACE_WITH_YOUR_APPS_SCRIPT_WEB_APP_URL` with your Web App URL from Step 3
5. Scroll down, click **Commit changes** → confirm
6. Do the same on the `gh-pages` branch (switch the branch dropdown to `gh-pages` and repeat)

### Step 5 — Test the live app
Open `https://trepin3.github.io/FreedomCRM/` (may take 60 seconds after commit)

- Login: **Get / Money**
- Enter your name
- Pick AZ, VA, or OH
- You should see the dummy leads (alternating your number and Jon's)
- Tap Call → opens phone dialer
- Tap Done → try Sold / DCID / Wrong / Callback flows
- Open sheet after each action → verify the row moved to the correct tab

Admin login: **BOSS / L1FE** → skips to admin dashboard

---

## Configuration Reference (in `index.html`)

```js
const CONFIG = {
  APPS_SCRIPT_URL: '',        // ← paste your web app URL here
  AGENT_USER: 'Get',
  AGENT_PASS: 'Money',
  ADMIN_USER: 'BOSS',
  ADMIN_PASS: 'L1FE',
  SCRIPT_TOOL_URL: 'https://trepin3.github.io/The-Basics/',
  BATCH_SIZE: 5,              // leads locked per fetch
  TCPA_START_HOUR: 8,         // 8am
  TCPA_END_HOUR: 21           // 9pm
};
```

## Switching from test data to real leads
1. Open each state's Google Sheet
2. Delete the 10 dummy rows in the `Leads` tab (keep headers on row 1)
3. Paste your real lead rows in
4. No code changes needed — the app immediately serves real leads

## If Apps Script hits quota limits
Google's free tier gives ~90 min/day of script execution. With 20+ agents this could be reached on heavy days. Options:
- Upgrade to Google Workspace ($6/mo)
- Split traffic across 2 Apps Script deployments
- Cache reads in the app more aggressively

## Managing DCID / Sold / Wrong Numbers manually
All 6 tabs are just Google Sheets — sort, filter, edit, delete rows directly. To restore a DCID or Wrong Number lead:
1. Open the state's sheet
2. Cut the row from `DCID` (or `Wrong Numbers`)
3. Paste into the `Leads` tab
4. Clear the Status column
