# Rules Committee audience — design

## Goal

Give the admin the ability to send a broadcast email to a subset of the distribution list — specifically the Rules Committee or a single clan — rather than only to everyone. Populate the Rules Committee with the 6 current members and draft a first email to them.

## Scope

1. Add a `rules_committee` flag to the `distribution_list` table and populate the 6 current members.
2. Surface the flag in the Admin → Contacts page (read/write).
3. Add an audience selector to the Admin → Email (Compose) page — choose All, Rules Committee, or a specific clan.
4. Provide the text for a one-off operating-instructions email for the committee. **The email is not sent by this change** — the admin will paste the draft into the compose page, pick audience = Rules Committee, edit, and send themselves.

## Non-goals

- No one-click "Forward to Rules Committee" action on individual inbox messages (can add later).
- No general tag system — one boolean flag is enough for now.
- No permanent entry in the email-templates dropdown for this one-off draft.
- No changes to how AI drafts are generated or who they are signed by.

## Data model

Add one column to `distribution_list`:

```sql
ALTER TABLE distribution_list ADD COLUMN rules_committee INTEGER NOT NULL DEFAULT 0;
```

Run at boot as an idempotent migration (same pattern as any existing `ALTER TABLE` migrations in `src/db.js` — follow whatever's there). If the column already exists, skip silently.

Also at boot, upsert these 6 people with `rules_committee = 1` (insert if missing by email, set flag if present):

| First | Last | Email |
| --- | --- | --- |
| Peter | Andruszkiewicz | petera191@gmail.com |
| Matt | Quinn | Mattq@kraftse.com |
| John | Quinn | JJQuinn62@gmail.com |
| Pete | Andruszkiewicz | pandruszk@gmail.com |
| Bob | Quackenbush | bobquackenbush@gmail.com |
| Scott | Wellington | swellington@wellingtonsearch.com |

This seed only runs once per environment (guarded by a marker row or a "seed applied" key in a `meta` table — whichever the codebase already uses). If neither exists, guard by checking whether any row with `rules_committee = 1` already exists, and skip the seed if so. Unflagging a member later must not be reverted by a later boot.

## Admin → Contacts page

- New table column **Committee** showing ⭐ for flagged members, empty otherwise.
- **Add Contact** form gets a checkbox: "On the rules committee."
- **Edit** modal gets the same checkbox, pre-populated from the row.
- Filter bar gets a new button: **Rules Committee (n)** next to the existing clan buttons. It toggles a `data-committee="1"` filter on rows the same way clan filter works.
- Routes:
  - `POST /admin/contacts/add` accepts `rules_committee` (checkbox value → 0/1).
  - `POST /admin/contacts/:id/edit` accepts `rules_committee`.
  - No new delete route; existing one stands.

## Admin → Email (Compose) page

Add an **Audience** `<select>` above the Subject field. Options:

- `all` — "All (N)" (default)
- `committee` — "Rules Committee (n)"
- `clan:<name>` — one option per distinct clan with count, e.g. "Clan: Andruszkiewicz (12)"

Counts are computed server-side when rendering the page. The Send button label and the `onsubmit` confirm message read the current selection via a small inline script that updates the label (e.g., "Send to Rules Committee (6)?"). No fancy state management — one `<script>` block at the bottom of the template is fine.

Backend changes in `routes/admin.js` for `POST /admin/email/send`:

- Accept an `audience` form field. Values: `all`, `committee`, `clan:<name>`.
- Filter the recipient list server-side:
  - `all` → `SELECT ... FROM distribution_list`
  - `committee` → `... WHERE rules_committee = 1`
  - `clan:<name>` → `... WHERE clan = ?`
- If the resulting list is empty, re-render the compose page with an error banner and do not call Resend.
- Existing `recipient_count` in `sent_emails` captures the actual send size — no schema change there.

Security: audience value is validated against an allowlist (`all` / `committee` / `clan:<name>`) before it touches SQL. `<name>` is parameterized; never concatenated.

## Operating-instructions email — draft text

Admin pastes this into the compose page, selects audience = Rules Committee, edits as needed, sends.

**Subject:** The Claryville Open — Rules Committee Website Guide

**Body (HTML-friendly plain prose):**

> Hi all —
>
> You're on the Rules Committee for the Claryville Open website. The site uses AI to draft replies to rules questions that come in by email, and those replies go out signed "Claryville Open Rules Committee." This note is so you know what that means, and how to review/adjust what's being sent in your name.
>
> **Logging in**
> Go to https://claryvilleopen.com/admin — the password is in the group text. Bookmark it.
>
> **Your main workflow**
>
> 1. **Inbox** — every rules question sent to the site shows up here, with an AI-drafted reply attached.
> 2. **Review Draft** — click it to see the original question, the AI's proposed reply, and buttons to Send, Edit, Dismiss, or Regenerate. If the AI wasn't confident, you'll see a "Needs Review" badge.
> 3. **Rules & Suggestions** — when someone's email seems to propose a new rule, the AI flags it here. Accept or skip.
> 4. **Custom Tournament Rules** (bottom of the Rules page) — the list of rules the AI is told about when drafting replies. Add, edit, delete.
>
> **What the AI already knows**
> Our custom rules list, plus course info for Tarry Brae. If the AI says something wrong, fix the rules list and regenerate the draft — it'll incorporate the update.
>
> **Can you help us test the signup flow?**
> Before we open registration to everyone, please walk through a fake team signup at https://claryvilleopen.com/register as if you were a player. Try it on your phone too. If anything looks off — confusing wording, a broken button, an email that doesn't arrive, a layout that's hard to read — reply to this email and tell us what you saw. Even small things are useful.
>
> **Other admin pages (FYI, not rules-committee concerns):** Groups, Scores, Gallery, Contacts, Email, Past Winners — feel free to ignore unless you're curious.
>
> **Questions / access issues:** reply to this email.
>
> — Peter

This text lives in the spec, not in any permanent template dropdown.

## Acceptance criteria

- [ ] DB migration adds `rules_committee` column; booting twice is a no-op.
- [ ] Seed inserts/flags the 6 committee members once; re-booting does not re-seed or unflag manually-removed members.
- [ ] `/admin/contacts` shows the committee column, filter button with count, and a working checkbox in both Add and Edit.
- [ ] Toggling the checkbox and saving reflects in the row on refresh.
- [ ] `/admin/email` shows the Audience select with accurate counts; default = All.
- [ ] Changing the audience updates the button label and confirm-dialog count.
- [ ] Sending with audience = Rules Committee only hits those 6 recipients; `sent_emails.recipient_count` matches.
- [ ] Empty audience (e.g., clan with no members after deletions) shows an error and does not call Resend.
- [ ] CSRF protection still enforces; no new inline event handlers that require CSP changes.

## Testing

- Manual: log in to `/admin/contacts`, flag/unflag a test row, confirm UI + persistence.
- Manual: `/admin/email` — flip the audience, confirm label + count; send to a one-off test clan with a disposable email to confirm filtering works end-to-end.
- Automated: none required beyond what exists — this is a small CRUD + filter change, and the codebase currently has no test suite to extend.

## Out of scope for this spec

- Adding more committees (e.g., Scoring, Marshals). If needed later, consider a `contact_tags` table rather than more boolean columns.
- Changing the "from" address or AI draft signing.
- Per-recipient tracking of opens/clicks.
- Unsubscribe handling (already a gap; not widened by this change).
