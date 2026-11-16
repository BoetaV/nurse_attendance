# ECDoH Weekly Nursing Attendance & Absenteeism Register (Google Apps Script)

A web app on a Google Sheet that puts the SOP *Weekly Nursing Attendance & Absenteeism Register* into practice:
- users sign in
- units capture Plan and Actual figures
- the SOP checks and totals are calculated
- the Operational Manager, Area Manager and Nursing Manager each sign electronically
- nursing administration gets the monthly roll-up.

`ECDoH_Weekly_Absenteeism_Register.html` is the original stand-alone version. The Apps Script project is in [apps_script/](apps_script/).

You can open the app in two ways. Both use the same Google Sheet backend:
- **GitHub Pages:** `https://boetav.github.io/nurse_attendance/`, built and published by GitHub Actions on every push.
- **Apps Script web app:** the `…/exec` URL itself.

## How it works

| Area | Behaviour |
|---|---|
| **Login** | Username and password, stored in the `Users` sheet as a salted hash. Nurses do not need Google accounts. 5 failed attempts lock the account for 15 minutes. Sessions last 6 hours. A temporary password must be changed at first login. |
| **Hospital → Area → Unit** | Units come from [reporting_units.csv](reporting_units.csv) (`Hospital;Area;Unit Name`). For now that is **Livingstone Hospital** with 65 units in OPD, Theatre and Ward. On the dashboard you choose **Hospital**, then **Area**, then **Unit**; each list shows only what belongs to the choice before it. Lists and the monthly roll-up can be filtered by area. |
| **Week / month / dates** | Pick the unit, the month and the week. The app fills in the Monday–Sunday dates, the week number, the month and the due time (Tuesday 12:00). A week belongs to the month its **Thursday** falls in, so a week that crosses two months is counted in one month only (4–5 weeks a month). |
| **Register** | The six fixed rows from SOP 4.1, with live totals, Absent, % Absent and colour bands (>10% amber, >15% red). It also has Absence details, Comments and the SOP checks. Values are whole numbers or halves (0.5 for 7–1 or 1–7 shifts). |
| **Sign-off (SOP 5.4)** | `Draft` → **Operational Manager** completes and signs → `Completed` → **Area Manager** checks and signs → `Checked` → **Nursing Manager** approves → `Approved`. Each signature records the signed-in user's full name and the time. The submission time is recorded at approval and marked **LATE** if it is after 12:00 on the Tuesday. The AM or NM can *return* a register to draft with a note. The Admin can *reopen* an approved register. |
| **Blocking checks** | A register cannot be signed while it has blank cells, a shortfall with no absent nurses listed, absence rows with missing details, Actual > Plan without a comment, or absenteeism above 10% without an explanation in Comments. |
| **Sheets created** | The database tabs are `Users`, `Units`, `Registers`, `DailyData` (one row per day, category and shift, ready for pivot tables), `Absences` and `AuditLog`. There is also one printout spreadsheet per facility per month, *Absenteeism – Facility – yyyy-MM*, in a **Register printouts** folder. It has a formatted tab per register with live formulas (filled automatically at approval) and a *Monthly summary* tab. |
| **Outputs** | A4 landscape PDF of a register, browser print, monthly roll-up on screen with **area subtotals** and the weeks that were not captured, CSV export. |

### Roles

| Role | Can do |
|---|---|
| Administrator | Manage users, facilities and units. Reopen approved registers. See everything. |
| Operational Manager | Start and capture registers for their units. **Complete & sign**. |
| Shift Leader (delegated) | Start and capture registers for their units. Cannot sign. |
| Area Manager | View their units. **Check & sign** or return. |
| Nursing Manager | View their facility. **Approve** or return. |
| Nursing Admin / Info Office | View, monthly roll-up, create Google Sheets and CSV. |

Each user is limited to one facility (or `All`) and to all units, **whole areas**, or single units. A whole area (for example an Area Manager given *Ward*) also covers units added to that area later. The server enforces this on every request.

## Installation

### 1. Google side (once)

1. Create a new **Google Sheet** in the Drive account that will own the data, for example *ECDoH Absenteeism Register – DB*. Use a departmental account if you can.
2. In the Sheet, open **Extensions → Apps Script**, then **Project Settings ⚙**. Copy the **Script ID**.
3. Get the code into the project, either way:
   - **With GitHub (recommended):** complete step 2 below, then push. The workflow uploads every file.
   - **By hand:** create each `apps_script/*.gs` file as a Script file and each `*.html` file as an HTML file (names without `.html`). Paste in `appsscript.json` after ticking *Show "appsscript.json" manifest file* in Project Settings.
4. Reload the Sheet and choose **Absenteeism → Set up / repair sheets**. Accept the permissions.
   - The 65 reporting units from `reporting_units.csv` are loaded under **Livingstone Hospital**. The hospital comes from the file, so you are not asked for it.
   - Write down the **admin** username and **temporary password** shown.
5. In the script editor, choose **Deploy → New deployment → Web app**:
   - *Execute as*: **Me**
   - *Who has access*: **Anyone** (needed for GitHub Pages; the app has its own login).
   - Copy the **web app URL** (ending in `/exec`) and the **Deployment ID**.

### 2. GitHub side (repo `BoetaV/nurse_attendance`)

Push this folder to the repo:
```bash
git init -b main
git add .
git commit -m "Weekly absenteeism register"
git remote add origin https://github.com/BoetaV/nurse_attendance.git
git push -u origin main
```

Then in the repo **Settings**:

| Where | Name | Value |
|---|---|---|
| *Pages → Build and deployment → Source* | | **GitHub Actions** |
| *Secrets and variables → Actions → **Variables*** | `API_URL` | Web app URL ending in `/exec` |
| *Secrets and variables → Actions → **Secrets*** | `SCRIPT_ID` | Script ID from step 1.2 |
| | `DEPLOYMENT_ID` | Deployment ID from step 1.5 |
| | `CLASPRC_JSON` | Contents of your `.clasprc.json` (see below) |

**To get `CLASPRC_JSON`:**
1. Turn on *Google Apps Script API* at <https://script.google.com/home/usersettings>.
2. On your PC, run `npm i -g @google/clasp@2.4.2` and then `clasp login`, using the account that owns the script.
3. Copy the whole contents of `.clasprc.json` from your Windows user folder (`%USERPROFILE%`) into the secret. It is a login token: keep it only in GitHub Secrets and never commit it. `.gitignore` already excludes it.

Re-run the workflow under **Actions → Deploy → Run workflow**. It:
1. Checks the syntax.
2. Runs `clasp push` to upload the code, then `clasp deploy` to update the same web-app deployment (the URL stays the same).
3. Builds the front end with your `API_URL` and publishes it to **https://boetav.github.io/nurse_attendance/**.

After that, **every push to `main` redeploys both**. If the Apps Script secrets are not set yet, only the Pages site is published.

### 3. First sign-in

Open the Pages URL and sign in as `admin`, then set your own password. Under **Users & units**, create the users. For each one:
- choose the role
- choose the facility
- tick whole areas or single units.

The temporary password is shown **once**. Give it to the person directly.

### Updating the unit list

- **Adding a hospital:** in **Users & units**, open the **Hospital** dropdown and choose **+ Add hospital…**. Then add or import its units; the hospital is saved with its first unit. To have it in the dropdown from the start, add it to `HOSPITALS` in `apps_script/Config.gs`.
- **In the app (no code change):** go to **Users & units → Import reporting units (CSV)**. Use the same `Hospital;Area;Unit Name` format. If the file has no Hospital column, the units go to the hospital selected in the dropdown. New units are added and existing units get their area updated. Nothing is deleted; use *Deactivate* to retire a unit.
- **For a fresh install:** edit `reporting_units.csv`, then run `node tools/seed-units.js` to regenerate `apps_script/SeedUnits.gs` and commit.

## Daily use (matches SOP section 5)

1. **Monday (OM / shift leader):** Dashboard → choose **Area → Unit**, month and week → **Open register**. Enter **Plan** from the duty roster. **Copy Plan → Actual** is a quick start.
2. **Daily:** enter **Actual**. For each shortfall, add the absent nurse under *Absence details*. Explain any Actual > Plan in *Comments*. Press **Save** (or Ctrl+S).
3. **Sunday:** clear every red SOP check, then **Complete & sign**.
4. **AM:** *Waiting for you* → open → **Check & sign**, or **Return for correction**.
5. **NM:** **Approve & submit** before 12:00 on Tuesday. The register is locked and archived to the monthly printout spreadsheet.
6. **Nursing admin:** **Monthly roll-up** → choose facility, area (or all areas) and month → review the weeks that were not captured → **Export CSV** or **Create Google Sheet**.

## Security and privacy notes

- Absence reasons such as sick leave are personal health information under POPIA. **Do not share the database spreadsheet.** Users get to the data only through the web app, which runs as the owner and filters by role and unit.
- The owner account can read everything. Use a departmental or service account, not a personal one.
- `AuditLog` records sign-ins, saves, signatures, returns, reopens, PDF downloads and user changes.
- Lost admin access: in the Sheet, run **Absenteeism → Reset "admin" password**. This works only for the owner.
- Sessions use the Apps Script cache. Signing out, or deactivating a user, ends their access straight away.

## Files

| File | Purpose |
|---|---|
| `Config.gs` | SOP constants: categories, reasons, roles, 10% threshold, sheet columns |
| `Db.gs` | Sheet read/write helpers, locking, week and month date logic |
| `Auth.gs` | Login, sessions, password hashing, access scope, user and unit admin |
| `Code.gs` | `doGet`, `doPost` (JSON API for GitHub Pages), API dispatcher, setup, spreadsheet menu |
| `SeedUnits.gs` | Reporting units loaded at setup (generated from `reporting_units.csv`) |
| `Registers.gs` | Create, save, SOP validation and the sign-off workflow |
| `Reports.gs` | Monthly roll-up, generated register and summary sheets, PDF export |
| `Index.html`, `Styles.html`, `App.html`, `Logo.html` | The web interface (served by Apps Script, or built into the Pages site) |
| `tools/build-pages.js` | Builds `dist/index.html` for GitHub Pages with `API_URL` |
| `tools/seed-units.js` | Regenerates `SeedUnits.gs` from `reporting_units.csv` |
| `.github/workflows/deploy.yml` | On push: clasp push and deploy to Apps Script, then publish to GitHub Pages |
