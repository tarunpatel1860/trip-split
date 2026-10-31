# Trip Split

A tiny, offline-first expense splitter for a trip. Six people, one link, one 4-digit code.

- Static frontend on GitHub Pages — no build step, no npm, no dependencies.
- Google Sheet as the database, reached through one Apps Script Web App.
- Works offline; changes queue locally and sync when back online.
- Admin page at `/admin/` for creating people and groups.

```
GitHub Pages (static)  ──POST JSON──▶  Apps Script Web App  ──▶  private Google Sheet
index.html / app.js                    Code.gs                   users, groups, members,
admin/                                 LockService               expenses, settlements
```

## What it does

**Admin (you), once**

1. Open `/admin/`, create the admin with your name and phone.
2. Copy the 4-digit admin secret shown once.
3. Add the other people (name + phone).
4. Create a group, copy the 4-digit group code.
5. Share the app link and the code.

**Members**

1. Open the app, enter their phone, tap Login.
2. See the groups they are already in, or enter the 4-digit code to join.
3. Add expenses, split equally or exact, record payments.

No signup, no profile editing, no passwords for members.

## Setup

### 1. Create the Google Sheet

1. Go to <https://sheets.new> and name it something like `Trip Split`.
2. Keep it **private**. Do not publish it. The Apps Script is the only thing that reads it.

### 2. Add the Apps Script backend

1. In the Sheet: **Extensions → Apps Script**.
2. Delete the default `myFunction` code.
3. Paste the contents of `backend/Code.gs`.
4. Open **Project Settings** and tick **Show `appsscript.json` manifest file**.
5. Replace `appsscript.json` with `backend/appsscript.json`.
6. Save, then run the `setup` function once and approve the permissions.
   - This creates the tabs: `admins`, `users`, `groups`, `members`, `expenses`, `settlements`.

### 3. Deploy the Web App

1. **Deploy → New deployment → Web app**.
2. Description: `trip-split`.
3. **Execute as: Me**.
4. **Who has access: Anyone**.
5. Deploy, authorize, and copy the **Web App URL** (it ends in `/exec`).

> `Anyone` is required so members do not need Google accounts. The Sheet itself stays private.

### 4. Point the app at the backend

Open `config.js` and replace the placeholder:

```js
window.APP_CONFIG = {
  API_URL: "https://script.google.com/macros/s/XXXXXXXX/exec"
};
```

### 5. Host on GitHub Pages

1. Create a **public** repo (Pages on the free plan needs a public repo).
2. Push this folder to the repo root.
3. Repo **Settings → Pages → Build and deployment → Deploy from a branch**.
4. Branch `main`, folder `/ (root)`, save.
5. The app is at `https://<you>.github.io/<repo>/` and admin at `https://<you>.github.io/<repo>/admin/`.

No GitHub Actions, no build step. Every push is live.

### 6. Create the admin

1. Open `/admin/` **before sharing the app link**.
2. Enter your name and phone → **Create admin**.
3. Copy the 4-digit secret. It is shown once.
4. Add people, create a group, copy the group code.

If you ever lose the secret: in Apps Script, run `resetAdmin('9876543210')` and read the new secret in **Execution log**.

## Using it

| Action | Where |
|---|---|
| Add expense | Group home → `+` |
| Split equally | Default; untick anyone who was not there |
| Split exact | Toggle **Exact**, type each person's amount |
| Edit / delete | Tap an expense |
| Record a payment | **Record payment** under Settle up; it prefills the next suggested payment |
| See balances | Group home |
| Join a group | Enter the 4-digit code on the groups screen |
| Work offline | Everything; the pill shows `Offline · N pending` |
| Force sync | Tap the sync pill |

Editing an expense that was split equally reopens it in **Equally** mode, so changing the total rebalances it. An exact split reopens in **Exact** mode with its original amounts.

Sync runs on open, after each change, every 15 seconds while the tab is visible, when the tab regains focus, and when the connection returns.

## Conflict rule

Each expense and payment has an `id` and `updatedAt`. The newest `updatedAt` wins, with `updatedBy` breaking ties. Different expenses are never merged or dropped. Retries are idempotent because the `id` is fixed. If two people edit the *same* expense at the same moment, the later save wins and the earlier one is replaced — the detail screen shows who edited last.

Keep phone clocks on automatic time; the merge uses the client timestamp.

## Data model

```
admins:      adminId | phone | name | secretHash | salt | failed | lockedUntil | createdAt
users:       userId | phone | name | active | createdAt
groups:      groupId | code | name | createdBy | createdAt
members:     groupId | userId | addedBy | addedAt | active
expenses:    id | groupId | amountPaise | note | paidBy | sharesJSON | date | createdAt | updatedAt | updatedBy | deleted
settlements: id | groupId | fromUser | toUser | amountPaise | date | createdAt | updatedAt | updatedBy | deleted
```

Money is always integer paise. Balances are derived, never stored. Removing a person from a group sets `active = 0`; their past expenses still count and still show their name.

## Files

```
index.html              member app shell
logic.js                split math, balances, merge, formatting
app.js                  member app screens and sync
style.css               shared styles, light + dark
config.js               the one line you edit (Apps Script URL)
sw.js                   offline cache
manifest.webmanifest    installable app metadata
icon.svg
admin/index.html        admin page
admin/admin.js          admin screens
backend/Code.gs         all backend actions
backend/appsscript.json Apps Script manifest
.nojekyll               tells GitHub Pages to serve files as-is
```

## Limits and trade-offs

- **4-digit group code**: 10,000 combinations. Fine for a private trip, not a secret. Anyone who guesses a code and knows a registered phone can join and act as that person.
- **4-digit admin secret**: also not strong, but the admin endpoint locks out after 5 wrong tries for 15 minutes. Set up the admin before sharing the link.
- **No realtime push**: Apps Script cannot push. Other people's changes appear within ~15 seconds.
- **Cold starts**: the first request after a quiet period can take 1–3 seconds.
- **No leaving/removing yourself**: the admin can remove someone from a group; members cannot.
- **INR only**, dates are date-only (`YYYY-MM-DD`).

## Troubleshooting

**"Set the Apps Script URL in config.js first"** — `config.js` still has the placeholder, or the browser cached the old file. Hard-refresh.

**"Missing tab ... Run setup()"** — run `setup()` in the Apps Script editor once.

**Network error / CORS** — confirm the deployment is **Anyone** access and you copied the `/exec` URL. Re-deploy after changing `Code.gs` (**Deploy → Manage deployments → Edit → New version**).

**"This number is not registered"** — the admin has not added that phone, or the person was deactivated.

**Changes not appearing on another phone** — tap the sync pill, or wait 15 seconds. Check the pill says `Synced`.

**Expenses show as "Undated"** — an older backend stored the `date` column as a Sheets date value. Deploy the latest `Code.gs` (**Manage deployments → Edit → New version**), then run `fixDates()` once in the Apps Script editor. New entries are written as `YYYY-MM-DD` text and read back in IST.

**Sheet is filling up** — each group reads all its rows on every sync. That is fine for a trip (hundreds of rows). For years of use, archive old groups.

**Lost admin secret** — run `resetAdmin('your-phone')` in Apps Script and check the execution log.

## Local development

Because there is no build step, any static server works:

```bash
cd trip-split
python3 -m http.server 8080
# open http://localhost:8080
```

Point `config.js` at the deployed Apps Script URL. Apps Script accepts requests from `localhost`, so no proxy is needed.

## License

MIT. Do whatever you want with it.
