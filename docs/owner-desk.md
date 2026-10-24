# SCOUT owner desk & account emails

The `/admin` owner workspace uses the existing owner-authorized platform and beta APIs. No new environment variables, database migrations, email providers or runtime dependencies are required.

## Owner workspace

- **Overview:** all-time broadcast totals, headshot rate, access configuration and recent match activity. The headshot rate is headshots divided by kills; it displays zero before any kills are recorded.
- **Applications:** search name, email, organisation or country; filter by review status (including revoked); sort by application date; review the applicant’s use case and events. Approvals send invitations using the existing delivery service. Rejecting, replacing an invitation, or revoking an approved account requires confirmation (revocation can record a short reason, visible to reviewers only). Revoking signs the account out everywhere, cuts its launchers, invites, recovery tokens and queued mail in one decision. Delivery labels distinguish activated, sent, expired, queued and retry-queued invitations and show the provider error plus the recommended fix when delivery keeps failing.
- **Users & tournaments:** searchable organisers with per-user tournament and broadcast totals; sort by recent activity, email, tournament count or kills. “Last active” reflects reported tournament activity, not an online presence indicator.
- **Match activity:** filter the server’s latest 100 match events by event type, map or details. This is a recent feed, not a complete historical archive.
- **CSV exports:** application, user and activity exports include all rows matching the current filters, not just the visible page. Values are quoted and spreadsheet formula prefixes are neutralized. Files are created in the owner’s browser; no public export endpoint is added. Treat downloaded files as private account data.
- **Settings:** access switches, reviewer email addresses, tournament limits and map availability. Unsaved edits survive background refreshes and section changes. Discard restores the most recently fetched settings. Leaving/reloading the page with unsaved edits triggers the browser’s standard warning. Save pushes through the existing API.
- **Refresh:** runs every 15 seconds and can be paused. A failed refresh preserves the last successful snapshot and shows a warning. Authorization failures clear private data and show the owner sign-in gate.

Only an account matching `SCOUT_OWNER_EMAIL` can open this desk. Beta reviewers retain their existing review permissions; this redesign does not grant them platform settings access.

## Account email design

`server/email.ts` provides a shared branded layout for invitation and password-recovery messages:

- Dark SCOUT header, rose action button, preview text, expiration callout and security footer.
- Invitations include a short three-step onboarding guide; recovery messages use separate account-security copy.
- Table layout, inline styling, a fixed-width Outlook wrapper and padded button fallback. No external images, tracking pixels or fonts.
- Visible copy/paste action URL, escaped template values and a complete plain-text alternative.

Delivery, encryption, single-use tokens and expiry enforcement are unchanged. Deploy the server code to use the new templates. Messages already encrypted in the outbox retain the template used when queued; newly queued messages use the updated design. Browser rendering checks are not a substitute for testing real Outlook/Gmail clients.

## Verification

```sh
npm ci
npm test
npm run build
```

`tests/admin-model.test.ts` covers search, invitation states and safe CSV serialization. `tests/email.test.ts` covers branding/layout structure, escaped values, matching fallback links, expiry and distinct invitation/recovery guidance. The full existing account-service and beta test suites also exercise delivery and authorization.

The redesign was additionally checked in headless Chromium using isolated API fixtures (not production accounts): desktop and mobile layout, application search/approval, pagination, CSV download, activity filters, reviewer entry, settings save/discard, draft preservation and refresh failure handling. Both email layouts were checked at desktop and 320/390px widths. No live invitation or recovery email was sent during these checks.
