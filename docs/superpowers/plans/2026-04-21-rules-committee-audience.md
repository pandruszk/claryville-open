# Rules Committee Audience — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `rules_committee` flag to the distribution list, surface it in the Admin Contacts page, and add an audience selector on the Admin Email Compose page so broadcast emails can target the committee or a single clan.

**Architecture:** A new boolean column on `distribution_list` plus a one-time seed (guarded by a `settings` key). Queries stay inline in `routes/admin.js` following the existing pattern. No new model or service files. The audience filter is a single `<select>` with values `all` | `committee` | `clan:<name>`, validated server-side against an allowlist before touching SQL.

**Tech Stack:** Node 20 / Express 4 / better-sqlite3 / EJS — no new deps.

**Spec:** [`docs/superpowers/specs/2026-04-21-rules-committee-audience-design.md`](../specs/2026-04-21-rules-committee-audience-design.md)

**Working directory root:** `/Users/peter/Documents/Claude/Projects/Claryville Open`

**Deployment:** commits to `main` are deployed on the web-services LXC via `git fetch && git reset --hard origin/main && docker compose up -d --build web`. This happens once at the end of the plan (Task 6), not after every task.

**Testing strategy:** This codebase has no automated test framework. Each task has a concrete verification step (SQL query, `curl`, or a browser action) that the implementer runs before committing.

---

## Task 1: Add `rules_committee` column and seed committee members

**Files:**
- Modify: `src/models/db.js` (add migration near line 156; add seed block after existing distribution-list seed, around line 259)

**Why:** Establish the data model and flag the 6 committee members exactly once. Idempotent across restarts. Guarded by a `settings` row so manually-unflagged members stay unflagged after a reboot.

- [ ] **Step 1: Add the ALTER TABLE migration**

Open [`src/models/db.js`](../../../src/models/db.js). Find the migrations block (around line 151–156) and append one line so the block reads:

```js
// Migrations — add columns to existing tables
try { db.exec('ALTER TABLE players ADD COLUMN phone TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE distribution_list ADD COLUMN phone TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE draft_replies ADD COLUMN needs_review INTEGER DEFAULT 0'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE players ADD COLUMN display_name TEXT'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE groups ADD COLUMN tee_order INTEGER'); } catch (e) { /* already exists */ }
try { db.exec('ALTER TABLE distribution_list ADD COLUMN rules_committee INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* already exists */ }
```

- [ ] **Step 2: Add the one-time committee seed**

At the very end of [`src/models/db.js`](../../../src/models/db.js), immediately before `module.exports = db;`, insert:

```js
// Seed rules committee members — runs once per environment (guarded by settings key).
// Admins can unflag members via the UI without this re-flagging them on reboot.
const committeeSeeded = db.prepare("SELECT value FROM settings WHERE key = 'rules_committee_seeded'").get();
if (!committeeSeeded) {
  const upsertContact = db.prepare(`
    INSERT INTO distribution_list (first_name, last_name, email, clan, rules_committee)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(email) DO UPDATE SET rules_committee = 1
  `);
  const committee = [
    ['Peter', 'Andruszkiewicz', 'petera191@gmail.com', 'Andruszkiewicz'],
    ['Matt',  'Quinn',          'Mattq@kraftse.com',             'Quinn'],
    ['John',  'Quinn',          'JJQuinn62@gmail.com',           'Quinn'],
    ['Pete',  'Andruszkiewicz', 'pandruszk@gmail.com',           'Andruszkiewicz'],
    ['Bob',   'Quackenbush',    'bobquackenbush@gmail.com',      'Quackenbush'],
    ['Scott', 'Wellington',     'swellington@wellingtonsearch.com', 'Wellington'],
  ];
  const markDone = db.prepare("INSERT INTO settings (key, value) VALUES ('rules_committee_seeded', 'true')");
  const seedCommittee = db.transaction(() => {
    for (const [first, last, email, clan] of committee) {
      upsertContact.run(first, last, email, clan);
    }
    markDone.run();
  });
  seedCommittee();
}
```

- [ ] **Step 3: Verify the migration and seed locally**

Run from the project root:

```bash
node -e "const db = require('./src/models/db'); \
  console.log('schema:', db.prepare(\"PRAGMA table_info(distribution_list)\").all().map(c => c.name + ':' + c.type).join(', ')); \
  console.log('committee count:', db.prepare('SELECT COUNT(*) as c FROM distribution_list WHERE rules_committee = 1').get().c); \
  console.log('committee emails:', db.prepare(\"SELECT email FROM distribution_list WHERE rules_committee = 1 ORDER BY email\").all().map(r => r.email).join(', ')); \
  console.log('seed marker:', db.prepare(\"SELECT value FROM settings WHERE key = 'rules_committee_seeded'\").get());"
```

Expected:
- Schema includes `rules_committee:INTEGER`
- `committee count: 6`
- The 6 committee emails listed alphabetically
- `seed marker: { value: 'true' }`

If your local `data/claryville.db` doesn't exist yet, this will also create one and run the full seed; that's fine.

- [ ] **Step 4: Verify idempotency**

Re-run the same command. Expected: same output — no errors, same counts. The ALTER TABLE `try/catch` swallows the "duplicate column" error; the settings-key guard prevents re-seeding.

- [ ] **Step 5: Verify manual unflag is preserved across reboot**

```bash
node -e "const db = require('./src/models/db'); \
  db.prepare(\"UPDATE distribution_list SET rules_committee = 0 WHERE email = 'bobquackenbush@gmail.com'\").run(); \
  console.log('count after manual unflag:', db.prepare('SELECT COUNT(*) as c FROM distribution_list WHERE rules_committee = 1').get().c);"
```

Expected: `5`

Then re-require the module (simulates reboot):

```bash
node -e "const db = require('./src/models/db'); \
  console.log('count after reboot:', db.prepare('SELECT COUNT(*) as c FROM distribution_list WHERE rules_committee = 1').get().c);"
```

Expected: still `5` — the seed did not re-flag Bob.

Restore:

```bash
node -e "const db = require('./src/models/db'); \
  db.prepare(\"UPDATE distribution_list SET rules_committee = 1 WHERE email = 'bobquackenbush@gmail.com'\").run();"
```

- [ ] **Step 6: Commit**

```bash
git add src/models/db.js
git commit -m "Add rules_committee column and one-time seed for 6 committee members"
```

---

## Task 2: Contacts route — accept checkbox, expose flag and committee count

**Files:**
- Modify: `src/routes/admin.js` (the `GET /admin/contacts` handler, `POST /admin/contacts/add`, and `POST /admin/contacts/:id/edit`)

**Why:** The view needs `rules_committee` on every row, a `committeeCount` for the filter button, and the add/edit routes must persist the new flag.

- [ ] **Step 1: Locate the contacts GET handler**

Search for the current handler:

```bash
grep -n "admin/contacts\|/contacts'" src/routes/admin.js | head -20
```

You're looking for the `GET /contacts` (or `/admin/contacts`) handler that renders `admin/contacts.ejs`. Read ~30 lines of surrounding context before editing.

- [ ] **Step 2: Update the GET handler to include `rules_committee` and `committeeCount`**

In the handler, change the query to select `rules_committee` and pass both a count and the existing data to the view. The query should look like:

```js
const distList = db.prepare(
  'SELECT id, first_name, last_name, email, clan, rules_committee FROM distribution_list ORDER BY last_name, first_name'
).all();
const clans = [...new Set(distList.map(c => c.clan).filter(Boolean))].sort();
const committeeCount = distList.filter(c => c.rules_committee).length;
res.render('admin/contacts', { distList, clans, committeeCount });
```

(If the existing code uses `SELECT *`, that's also acceptable — the key is that `rules_committee` is available on each row and `committeeCount` is passed through.)

- [ ] **Step 3: Update the POST add handler**

Find the `POST /contacts/add` handler. Replace its body with:

```js
router.post('/contacts/add', express.urlencoded({ extended: true }), (req, res) => {
  const { first_name, last_name, email, clan } = req.body;
  const rules_committee = req.body.rules_committee ? 1 : 0;
  if (!email) return res.redirect('/admin/contacts');
  db.prepare(
    'INSERT OR IGNORE INTO distribution_list (first_name, last_name, email, clan, rules_committee) VALUES (?, ?, ?, ?, ?)'
  ).run(first_name || null, last_name || null, email, clan || null, rules_committee);
  res.redirect('/admin/contacts');
});
```

(If the existing handler differs in spacing/style, preserve its style; the substantive changes are: read `rules_committee` from the body, include it in the INSERT.)

- [ ] **Step 4: Update the POST edit handler**

Find the `POST /contacts/:id/edit` handler. Replace its body with:

```js
router.post('/contacts/:id/edit', express.urlencoded({ extended: true }), (req, res) => {
  const { first_name, last_name, email, clan } = req.body;
  const rules_committee = req.body.rules_committee ? 1 : 0;
  db.prepare(
    'UPDATE distribution_list SET first_name = ?, last_name = ?, email = ?, clan = ?, rules_committee = ? WHERE id = ?'
  ).run(first_name || null, last_name || null, email, clan || null, rules_committee, req.params.id);
  res.redirect('/admin/contacts');
});
```

- [ ] **Step 5: Verify routes render without errors**

Start the server locally:

```bash
npm start
```

In a second terminal, hit the health of the module graph:

```bash
node --check src/routes/admin.js && echo "syntax OK"
```

Expected: `syntax OK`.

Stop the server (Ctrl-C) — we'll verify the full flow after Task 3.

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin.js
git commit -m "Contacts routes: read/write rules_committee and expose committeeCount"
```

---

## Task 3: Contacts view — Committee column, filter button, checkboxes

**Files:**
- Modify: `src/views/admin/contacts.ejs`

**Why:** Admin needs to see who's on the committee, toggle membership, and filter the table by committee or clan.

- [ ] **Step 1: Add the "Committee" column header and cell**

In [`src/views/admin/contacts.ejs`](../../../src/views/admin/contacts.ejs), inside the `<thead>` (around line 43–49), change the `<tr>` so it reads:

```html
<tr>
  <th>First Name</th>
  <th>Last Name</th>
  <th>Email</th>
  <th>Clan</th>
  <th>Committee</th>
  <th>Actions</th>
</tr>
```

In the row-rendering loop (around line 52–65), after the `<td><%= c.clan || '—' %></td>` line, add:

```html
<td><%= c.rules_committee ? '⭐' : '' %></td>
```

Update the row's data attributes so the filter can find committee members — change the `<tr>` opening from `<tr data-clan="..." id="...">` to:

```html
<tr data-clan="<%= c.clan || '' %>" data-committee="<%= c.rules_committee ? '1' : '0' %>" id="row-<%= c.id %>">
```

- [ ] **Step 2: Add the "Rules Committee" filter button**

In the clan-filter bar (around lines 32–38), inside the `<% if (clans.length > 0) { %>` block, add a new button after the "All" button and before the per-clan loop:

```html
<button class="btn btn-small" onclick="filterCommittee()"><strong>Rules Committee (<%= committeeCount %>)</strong></button>
```

Also expose the filter even when `clans.length === 0` — wrap the block so committee filtering still works if the clans list is empty. Change the whole filter-bar section to:

```html
<div class="clan-filter" style="margin-bottom: 1rem;">
  <strong style="font-size: 0.82rem; color: var(--gray-500);">Filter:</strong>
  <button class="btn btn-small" onclick="filterClan('')" style="margin-left: 0.25rem;">All (<%= distList.length %>)</button>
  <button class="btn btn-small" onclick="filterCommittee()"><strong>Rules Committee (<%= committeeCount %>)</strong></button>
  <% for (const clan of clans) { %>
    <button class="btn btn-small" onclick="filterClan('<%= clan %>')"><%= clan %></button>
  <% } %>
</div>
```

- [ ] **Step 3: Add the `filterCommittee` JS function**

In the `<script>` block at the bottom of the file (around line 101), add `filterCommittee` alongside `filterClan`:

```html
<script>
function filterClan(clan) {
  const rows = document.querySelectorAll('#contacts-table tbody tr');
  rows.forEach(row => {
    row.style.display = (!clan || row.dataset.clan === clan) ? '' : 'none';
  });
}

function filterCommittee() {
  const rows = document.querySelectorAll('#contacts-table tbody tr');
  rows.forEach(row => {
    row.style.display = row.dataset.committee === '1' ? '' : 'none';
  });
}

function editContact(id, first, last, email, clan, rulesCommittee) {
  document.getElementById('edit-form').action = '/admin/contacts/' + id + '/edit';
  document.getElementById('edit-first').value = first;
  document.getElementById('edit-last').value = last;
  document.getElementById('edit-email').value = email;
  document.getElementById('edit-clan').value = clan;
  document.getElementById('edit-rules-committee').checked = rulesCommittee === 1 || rulesCommittee === '1';
  document.getElementById('edit-modal').style.display = 'flex';
}

function closeEdit() {
  document.getElementById('edit-modal').style.display = 'none';
}

document.getElementById('edit-modal').addEventListener('click', function(e) {
  if (e.target === this) closeEdit();
});
</script>
```

- [ ] **Step 4: Pass `rules_committee` to `editContact` from the row**

In the row-rendering loop, update the Edit button (around line 59) to pass the flag as the 6th argument:

```html
<button class="btn btn-small" onclick="editContact(<%= c.id %>, '<%= (c.first_name || '').replace(/'/g, "\\'") %>', '<%= (c.last_name || '').replace(/'/g, "\\'") %>', '<%= c.email.replace(/'/g, "\\'") %>', '<%= (c.clan || '').replace(/'/g, "\\'") %>', <%= c.rules_committee ? 1 : 0 %>)">Edit</button>
```

- [ ] **Step 5: Add the checkbox to the Add Contact form**

In the Add Contact form (around lines 20–27), add a checkbox before the submit button:

```html
<form method="POST" action="/admin/contacts/add" class="form-inline" style="gap: 0.5rem;">
  <input type="hidden" name="_csrf" value="<%= locals.csrfToken || "" %>">
  <input type="text" name="first_name" placeholder="First name">
  <input type="text" name="last_name" placeholder="Last name">
  <input type="email" name="email" placeholder="Email" required>
  <input type="text" name="clan" placeholder="Clan">
  <label style="display:inline-flex;align-items:center;gap:0.25rem;font-size:0.85rem;">
    <input type="checkbox" name="rules_committee" value="1"> Rules committee
  </label>
  <button type="submit" class="btn btn-small btn-primary">Add</button>
</form>
```

- [ ] **Step 6: Add the checkbox to the Edit modal**

In the Edit modal form (around lines 75–97), add a form-group for the checkbox before the actions row:

```html
<div class="form-group">
  <label>Clan</label>
  <input type="text" name="clan" id="edit-clan">
</div>
<div class="form-group">
  <label style="display:inline-flex;align-items:center;gap:0.5rem;">
    <input type="checkbox" name="rules_committee" id="edit-rules-committee" value="1">
    On the rules committee
  </label>
</div>
<div class="actions" style="gap: 0.5rem; margin-top: 1rem;">
  <button type="submit" class="btn btn-small btn-primary">Save</button>
  <button type="button" class="btn btn-small" onclick="closeEdit()">Cancel</button>
</div>
```

- [ ] **Step 7: Verify locally**

Start the server:

```bash
npm start
```

In a browser, log in to `/admin` and go to `/admin/contacts`. Verify:

- Table has a Committee column; 6 rows show ⭐ (Peter A., Matt Quinn, John Quinn, Pete A., Bob Q., Scott W. at swellington@wellingtonsearch.com).
- "Rules Committee (6)" button in the filter bar; clicking it filters to those 6.
- Clicking "All" (or any clan button) re-shows all/only-that-clan.
- Edit a committee member: modal opens with the checkbox already checked; uncheck + Save → row refreshes with no ⭐; Committee count in the filter button is stale until page reload (acceptable).
- Re-edit the same contact: checkbox reflects the unchecked state. Re-check + Save → ⭐ returns.
- Add Contact form: enter a test email, tick the Rules committee box, submit. Verify the new row has ⭐. Delete the test row via the Remove button.

Stop the server.

- [ ] **Step 8: Commit**

```bash
git add src/views/admin/contacts.ejs
git commit -m "Contacts view: show rules_committee flag, filter button, add/edit checkbox"
```

---

## Task 4: Email compose route — audience options and server-side filtering

**Files:**
- Modify: `src/routes/admin.js` (the `GET /admin/email` handler and `POST /admin/email/send`)

**Why:** The view needs an `audienceOptions` array so the `<select>` can render counts, and the send handler must filter recipients and refuse empty audiences. Validation is server-side; do not trust the incoming string beyond an allowlist match.

- [ ] **Step 1: Replace the GET handler**

In [`src/routes/admin.js`](../../../src/routes/admin.js), find this handler (currently around line 283):

```js
router.get('/email', (req, res) => {
  const sentEmails = EmailService.getSentEmails();
  const emailCount = db.prepare('SELECT COUNT(*) as c FROM distribution_list').get().c;
  res.render('admin/email-compose', { sentEmails, emailCount });
});
```

Replace it with:

```js
router.get('/email', (req, res) => {
  const sentEmails = EmailService.getSentEmails();
  const distList = db.prepare('SELECT clan, rules_committee FROM distribution_list').all();
  const total = distList.length;
  const committee = distList.filter(c => c.rules_committee).length;
  const byClan = {};
  for (const c of distList) {
    if (c.clan) byClan[c.clan] = (byClan[c.clan] || 0) + 1;
  }
  const audienceOptions = [
    { value: 'all', label: `All (${total})`, count: total },
    { value: 'committee', label: `Rules Committee (${committee})`, count: committee },
    ...Object.keys(byClan).sort().map(name => ({
      value: `clan:${name}`,
      label: `Clan: ${name} (${byClan[name]})`,
      count: byClan[name],
    })),
  ];
  res.render('admin/email-compose', { sentEmails, emailCount: total, audienceOptions });
});
```

- [ ] **Step 2: Replace the POST send handler**

Find this handler (currently around line 296):

```js
router.post('/email/send', express.urlencoded({ extended: true }), async (req, res) => {
  const { subject, body } = req.body;
  const recipients = db.prepare('SELECT email FROM distribution_list').all().map(r => r.email);
  if (recipients.length === 0) {
    return res.redirect('/admin/email');
  }
  const sent = await EmailService.sendBulk(recipients, subject, body);
  res.redirect('/admin/email');
});
```

Replace it with:

```js
router.post('/email/send', express.urlencoded({ extended: true }), async (req, res) => {
  const { subject, body } = req.body;
  const audience = req.body.audience || 'all';

  let rows;
  if (audience === 'all') {
    rows = db.prepare('SELECT email FROM distribution_list').all();
  } else if (audience === 'committee') {
    rows = db.prepare('SELECT email FROM distribution_list WHERE rules_committee = 1').all();
  } else if (audience.startsWith('clan:')) {
    const clanName = audience.slice('clan:'.length);
    rows = db.prepare('SELECT email FROM distribution_list WHERE clan = ?').all(clanName);
  } else {
    return res.status(400).send('Invalid audience');
  }

  const recipients = rows.map(r => r.email);
  if (recipients.length === 0) {
    return res.status(400).send('No recipients match the selected audience.');
  }

  await EmailService.sendBulk(recipients, subject, body);
  res.redirect('/admin/email');
});
```

`EmailService.sendBulk` already writes to the `emails_sent` table internally — do not add a duplicate `INSERT`.

- [ ] **Step 3: Verify syntax**

```bash
node --check src/routes/admin.js && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 4: Commit**

```bash
git add src/routes/admin.js
git commit -m "Email send: accept audience selector and filter recipients server-side"
```

---

## Task 5: Email compose view — audience select and dynamic label

**Files:**
- Modify: `src/views/admin/email-compose.ejs`

**Why:** The admin needs to pick an audience, see the count update, and get a confirm dialog that matches.

- [ ] **Step 1: Replace the static recipient hint with the audience select**

In [`src/views/admin/email-compose.ejs`](../../../src/views/admin/email-compose.ejs), replace the paragraph around line 20 (`<p class="form-hint">Will send to all...`) and the opening of the form down to the Subject field with:

```html
<section class="admin-section">
  <h2>Compose Email</h2>

  <div class="email-templates">
    <strong>Quick templates:</strong>
    <button class="btn btn-small" onclick="loadTemplate('save-the-date')">Save the Date</button>
    <button class="btn btn-small" onclick="loadTemplate('registration-open')">Registration Open</button>
    <button class="btn btn-small" onclick="loadTemplate('groups-details')">Groups & Details</button>
    <button class="btn btn-small" onclick="loadTemplate('final-call')">Final Call</button>
    <button class="btn btn-small" onclick="loadTemplate('recap')">Recap & Results</button>
  </div>

  <form method="POST" action="/admin/email/send" class="form" onsubmit="return confirmSend()">
    <input type="hidden" name="_csrf" value="<%= locals.csrfToken || "" %>">
    <div class="form-group">
      <label for="audience">Audience</label>
      <select id="audience" name="audience" onchange="updateSendLabel()">
        <% for (const opt of audienceOptions) { %>
          <option value="<%= opt.value %>" data-count="<%= opt.count %>"><%= opt.label %></option>
        <% } %>
      </select>
    </div>
    <div class="form-group">
      <label for="subject">Subject</label>
      <input type="text" id="subject" name="subject" required>
    </div>
    <div class="form-group">
      <label for="body">Body (HTML)</label>
      <textarea id="body" name="body" rows="15" required></textarea>
    </div>
    <div class="form-group">
      <label>Preview</label>
      <div id="preview" class="email-preview"></div>
    </div>
    <button type="submit" class="btn btn-primary" id="send-btn">Send to All (<%= emailCount %>)</button>
  </form>
</section>
```

- [ ] **Step 2: Add the `confirmSend` and `updateSendLabel` functions**

At the bottom of the existing `<script>` block (after the `loadTemplate` / `updatePreview` wiring), append:

```js
function updateSendLabel() {
  const sel = document.getElementById('audience');
  const opt = sel.options[sel.selectedIndex];
  const label = opt.textContent;
  document.getElementById('send-btn').textContent = 'Send — ' + label;
}

function confirmSend() {
  const sel = document.getElementById('audience');
  const opt = sel.options[sel.selectedIndex];
  return confirm('Send this email to: ' + opt.textContent + '?');
}

// Initialize label on page load in case the selected option isn't the default
updateSendLabel();
```

- [ ] **Step 3: Verify locally**

Start the server, log in, go to `/admin/email`. Verify:

- Audience select shows: `All (N)`, `Rules Committee (6)`, and one `Clan: X (n)` option per distinct clan, with counts.
- The Send button reads `Send — All (N)` by default.
- Changing the audience updates the button label immediately.
- Submitting triggers a `confirm` dialog whose text matches the selected audience.
- Cancel in the confirm dialog does not send (nothing appears in the Sent Emails table).
- Optional: pick "Rules Committee", enter a fake subject + body, send; verify the "Sent Emails" row shows `recipient_count = 6`. **Careful — this actually sends email.** Skip if you don't want to test the send path until production.

Stop the server.

- [ ] **Step 4: Commit**

```bash
git add src/views/admin/email-compose.ejs
git commit -m "Email compose: audience select with dynamic send-button label and confirm"
```

---

## Task 6: Deploy and verify in production

**Files:** none.

**Why:** Everything to this point has been local. Ship it.

- [ ] **Step 1: Push**

```bash
git push origin main
```

- [ ] **Step 2: Deploy on the server**

```bash
ssh web-services 'cd /opt/claryville-open && git fetch origin && git reset --hard origin/main && docker compose up -d --build web 2>&1 | tail -10 && sleep 3 && docker ps --filter name=claryville-open-web-1 --format "table {{.Names}}\t{{.Status}}" && docker logs --tail 20 claryville-open-web-1'
```

Expected: container `Up` and logs show `Claryville Open running at http://localhost:3000` with no errors.

- [ ] **Step 3: Verify the migration + seed ran on production**

```bash
ssh web-services 'docker exec claryville-open-web-1 sh -c "sqlite3 /app/data/claryville.db \"SELECT email FROM distribution_list WHERE rules_committee = 1 ORDER BY email\""'
```

Expected: the 6 committee emails. If `sqlite3` isn't in the container, instead run:

```bash
ssh web-services 'docker exec claryville-open-web-1 node -e "const db = require(\"./src/models/db\"); console.log(db.prepare(\"SELECT email FROM distribution_list WHERE rules_committee = 1 ORDER BY email\").all().map(r => r.email).join(\"\\n\"))"'
```

- [ ] **Step 4: Verify the live pages**

From your Mac:

```bash
curl -sSIk --resolve claryvilleopen.com:443:192.168.1.12 https://claryvilleopen.com/admin/contacts -w "HTTP %{http_code}\n" -o /dev/null
curl -sSIk --resolve claryvilleopen.com:443:192.168.1.12 https://claryvilleopen.com/admin/email    -w "HTTP %{http_code}\n" -o /dev/null
```

Expected: both return `HTTP 200` (admin will redirect to login — that's 302; either is fine as "page is reachable"). Then open both in a browser and walk through the verification steps from Tasks 3 and 5.

- [ ] **Step 5: Draft the operating-instructions email (do not send)**

Log in to `/admin/email`. Select Audience = Rules Committee (6). Paste the subject and body from the spec ([`docs/superpowers/specs/2026-04-21-rules-committee-audience-design.md`](../specs/2026-04-21-rules-committee-audience-design.md), section "Operating-instructions email — draft text"). **Leave the page open, edit as you see fit, and click Send when you're ready.** This plan does not send the email on your behalf.

---

## Rollback

If something goes wrong after deploy:

```bash
ssh web-services 'cd /opt/claryville-open && git reset --hard HEAD~N && docker compose up -d --build web'
```

(Replace `N` with the number of commits this plan landed on `main` — typically `5`.)

The `rules_committee` column survives rollback (SQLite has no `DROP COLUMN` pre-3.35 that we care about, and it's additive with a default of 0, so it's harmless if the code ignores it). The `settings` row `rules_committee_seeded` also survives; it's a no-op.
