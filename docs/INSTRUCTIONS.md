# SCOUT — Website, Closed-Beta Platform & Desktop Integration
## Phased Implementation Specification for an AI Coding Agent

### Your role

Act as a senior full-stack engineer, desktop application engineer, security engineer, and QA engineer responsible for evolving the existing **SCOUT CS2 tournament overlay** into a reliable, owner-managed closed-beta platform.

Repository: https://github.com/ArliT1-F/SCOUT

Your task is to implement the website improvements, platform architecture, account and invitation system, desktop authentication, offline authorization, secure automatic updates, and operational improvements described below.

This is an implementation task, not merely a design proposal. Inspect the repository, understand the current implementation, make changes in small verified increments, run the available checks, and document any limitations.

Do not assume the current technology stack, desktop packaging method, authentication implementation, or backend structure without inspecting the code.

---

# 1. Non-negotiable engineering principles

## 1.1 Preserve existing functionality

SCOUT already has working tournament-overlay functionality on Windows. The existing application includes tournament and match functionality, a web-based control interface, CS2 Game State Integration (GSI), and OBS-related workflows.

Do not break or unnecessarily rewrite these systems.

Before changing anything:

- Inspect the complete repository structure and current Git state.
- Identify the frontend framework, backend/API, database, authentication system, desktop runtime, build pipeline, and packaging method.
- Locate the existing website, including `src/site.tsx` if it still exists in the current branch.
- Identify how the desktop application communicates with its local control interface.
- Identify the GSI receiver, match lifecycle, overlay rendering, OBS integration, settings persistence, and existing authentication code.
- Read existing documentation, configuration, environment examples, and tests.
- Run the current project and establish a baseline of working behavior.
- Record existing bugs separately from newly introduced bugs.
- Identify all existing API routes, data models, environment variables, and configuration formats before modifying them.

Create a concise architecture and dependency map before implementing changes.

**Do not replace an existing backend, database, authentication system, or desktop framework merely because another technology seems more convenient.** Extend the current implementation unless there is a documented, evidence-based reason that a change is necessary.

If a migration is unavoidable, use an incremental migration strategy with compatibility adapters, versioned interfaces, and an explicit removal phase for legacy behavior.

## 1.2 Every phase must remain usable

Each phase must leave SCOUT in a buildable and testable state.

Do not create a temporary architecture that only works after several future phases have been completed.

In particular:

- Never replace a working API contract before a compatible replacement is available.
- Never make the desktop application depend on an endpoint that has not been implemented and tested.
- Never remove an existing login, local storage format, configuration field, or API response before its replacement is ready.
- Never merge a database schema change that makes the current application unusable while the next phase is pending.
- Never disable working overlay functionality to make room for website or account infrastructure.
- Keep local tournament functionality separate from optional cloud-platform features.
- Use feature flags or compatibility layers where a transition requires them.
- Provide database migrations and rollback procedures for schema changes.
- Keep each phase independently reviewable, testable, and suitable for a separate commit or pull request.

At the end of every phase, the repository must build, the relevant tests must pass, and any unfinished feature must fail safely rather than leaving a partially functional application.

## 1.3 Use real implementations

Do not satisfy requirements with:

- Placeholder pages presented as finished features.
- Fake API responses or hardcoded account data.
- Mock authentication in production code.
- Buttons that do nothing.
- Simulated update success.
- Client-controlled authorization decisions.
- Hardcoded secrets or private signing keys.
- Unverified assumptions about the desktop packaging system.
- Empty tests that merely assert that a function exists.

Mocks are acceptable in isolated tests when clearly separated from production implementations.

## 1.4 Establish a stable baseline

Before Phase 1 implementation, create a baseline report containing:

1. Current stack and repository architecture.
2. Existing website routes and components.
3. Existing API contracts and database models.
4. Existing authentication and authorization behavior.
5. Current Windows development and packaging commands.
6. Current test, lint, type-check, and build commands.
7. Existing functionality that must remain unchanged.
8. Confirmed defects, suspected defects, and unverified assumptions.
9. External services and credentials required for deployment.
10. Known gaps in automated and manual testing.

Do not claim a test passed unless it was actually run.

---

# 2. Product architecture and locked decisions

SCOUT consists of two connected products.

### A. Public website and managed platform

The website provides:

- A professional landing page.
- Closed-beta applications.
- Application review and approval.
- Account invitations and authentication.
- User profiles and account security.
- Desktop installation linking and revocation.
- Authorized downloads and release information.
- Owner and authorized-admin management tools.
- Minimal, privacy-conscious analytics.
- Secure desktop authorization and update services.

### B. SCOUT desktop application

The desktop application remains responsible for local tournament operations, including:

- Tournament and match management.
- CS2 GSI ingestion and processing.
- Local match state.
- Overlay rendering.
- OBS integration and output configuration.
- Local settings and tournament state.
- Local operator workflows and diagnostics.

**The website is not a cloud tournament host.** Organizers run tournaments on their own machines using SCOUT.exe.

The website must not become a relay for live GSI packets, match state, player data, OBS traffic, or tournament events by default.

Desktop-to-platform communication should be limited to the functions required for authentication, account and installation linking, authorization leases, update metadata and downloads, and explicitly approved minimal telemetry.

Local tournament operations must continue during website outages when the application's valid offline authorization permits them to continue.

## 2.1 Locked product decisions

Implement these as requirements, not suggestions:

- Accounts are required to use the authorized desktop application.
- There is no public account-registration endpoint or public self-service account creation.
- Anyone may submit a closed-beta application using an email address.
- Submitting an application does not create an account.
- The owner and explicitly authorized administrators can approve or reject applications.
- An approved applicant receives a single-use, expiring email invitation.
- The applicant sets a password through the invitation flow before the account is activated.
- Activated users can access their profile, authorized download, and linked installations.
- Desktop installations are linked to accounts and can be revoked.
- The platform uses a managed hosting model.
- Analytics must be minimal and privacy-conscious.
- Desktop updates should be automatic and cryptographically verified.
- Offline authorization permits up to **three tournament starts per authorization lease**.
- Successful online reauthentication can issue a new lease and refresh the allowance.
- The allowance is not three lifetime tournaments.
- An active tournament must not be terminated simply because an authorization lease expires or its allowance is exhausted mid-tournament.
- Reauthentication is required before the next tournament start when the current allowance has been exhausted.
- A tournament session counts once, not once per match.
- Opening settings, opening OBS, reopening the application, or restarting the same tournament session must not consume another start.
- Desktop packaging technology is not yet confirmed. Inspect the existing packaging/build system before choosing an updater or framework-specific solution.
- The platform must not require port forwarding for ordinary account or authorization functionality.
- Preserve existing authentication and lease behavior where already implemented, adapting it incrementally rather than rebuilding it without evidence.

---

# 3. Website and user experience improvements

## 3.1 Landing page

Improve the current landing page without discarding its existing identity or structure unnecessarily.

The existing design has included a hero section, interface/HUD mockup, feature sections, scene showcase, beta flow, FAQ, and final call to action. Inspect the current implementation to determine what is still present.

The landing page should communicate the product's value to CS2 tournament organizers and broadcasters immediately.

Recommended primary message:

**“A better broadcast for every CS2 tournament.”**

Explain the benefits in straightforward language before introducing technical terms.

The first screen should answer:

- What is SCOUT?
- Who is it for?
- What problem does it solve?
- Does it work with CS2 and OBS?
- How can someone join the closed beta?

Provide clear actions such as:

- **Join the Closed Beta**
- **Watch Demo**, if a real demo is available.
- **Get SCOUT**, when the visitor is authorized to download it.

Do not show an active download action to unauthorized visitors if downloads require an account. Instead, direct them to the appropriate beta or login flow.

Communicate relevant supported platforms and requirements accurately. A Windows 10/11 statement may be used only if current compatibility is verified.

Do not claim that an installer is ready or that installation is automatic until the real packaged application has been tested.

### Visual improvements

- Use genuine screenshots or recordings from the current SCOUT interface where available.
- Ensure promotional images accurately represent the actual application.
- Avoid invented interface screenshots that imply nonexistent functionality.
- Reduce an oversized nine-map showcase to a more focused selection, with an optional way to see more.
- Move technical jargon and implementation details lower on the page.
- Improve typography, spacing, contrast, visual hierarchy, and CTA clarity.
- Keep the existing brand identity unless a change is justified by the actual implementation.
- Optimize images and avoid unnecessary large assets.
- Ensure the page remains attractive on smaller screens.

Do not spend disproportionate effort redesigning a landing page that is already functioning well. Prioritize correctness, clarity, and measurable usability improvements.

## 3.2 Navigation and public pages

Review and implement the appropriate navigation for:

- Home.
- Features.
- Demo or screenshots, if available.
- Closed-beta application.
- Login.
- Documentation or setup guide.
- Release notes.
- Privacy information.
- Terms or other legal pages where appropriate.

Only link to pages that actually exist. Avoid dead routes, misleading CTAs, and placeholder content.

Separate marketing content from authenticated account functionality where practical, while preserving the current framework and shared components.

## 3.3 Closed-beta application form

Implement a working public application form with:

- Email address.
- Name or display name, if justified by the existing application design.
- A concise explanation of the application process.
- Input validation on both client and server.
- Loading, success, validation-error, rate-limit, and server-error states.
- Duplicate-submission handling.
- Spam and abuse protection that does not make legitimate applications unnecessarily difficult.
- Accessible labels and keyboard navigation.

Submission must create an application record, not an account.

Do not reveal whether an email already belongs to an existing account or application through a publicly distinguishable response.

Provide an appropriate application-status flow without introducing a public account-creation endpoint.

## 3.4 Responsive design and accessibility

Test the actual pages at desktop, tablet, and mobile widths.

Ensure:

- Navigation remains usable on narrow screens.
- Forms are easy to complete.
- Dialogs and menus work with a keyboard.
- Focus states are visible.
- Text contrast is sufficient.
- Semantic HTML and accessible names are used.
- Images have appropriate alternative text.
- Reduced-motion preferences are respected.
- Interactive elements have clear states.
- Loading and error states do not cause confusing layout shifts.

## 3.5 SEO and metadata

Implement appropriate:

- Page titles and descriptions.
- Canonical URLs where applicable.
- Open Graph and social-sharing metadata.
- Favicons and site identity.
- Search-engine indexing rules for public pages.
- Appropriate `noindex` rules for private account and administrative pages.

Do not expose private account information through page metadata or public indexing.

## 3.6 Privacy-conscious analytics

Implement only analytics that help the owner understand platform usage and reliability.

Potential events include:

- Public landing-page visits.
- Beta application submissions.
- Invitation acceptance.
- Successful desktop linking.
- Update success or failure.
- Application crashes, if explicitly enabled and sufficiently anonymized.

Define an explicit event allowlist.

Do not collect raw GSI payloads, live match state, player information, OBS data, tournament contents, passwords, tokens, invitation secrets, or other unnecessary sensitive information.

Document exactly what is collected, why it is collected, how long it is retained, and how it can be deleted.

Do not add third-party tracking scripts by default. Prefer minimal first-party analytics unless there is a clear, documented reason otherwise.

---

# 4. User account and profile system

Create a reliable account experience integrated with the existing backend.

Authenticated users should be able to:

- View their account details.
- Update permitted profile fields.
- View their beta-application status when applicable.
- Access the authorized desktop download.
- View linked installations.
- See installation and authorization status.
- Revoke an installation where policy permits.
- Change their password.
- Sign out.
- Request password recovery.
- Review relevant account security information.

The profile must use actual authenticated API data rather than hardcoded examples.

Enforce authorization on the server for every account-specific resource. Hiding a button in the frontend is not authorization.

Implement:

- Secure session handling consistent with the current stack.
- Secure cookie settings when cookies are used.
- CSRF protections when applicable.
- Password hashing with a suitable modern password-hashing algorithm.
- Password recovery tokens that are single-use, time-limited, and stored safely.
- Session revocation where supported.
- Rate limits for login, recovery, invitation, and sensitive operations.
- Validation and normalization of account data.
- Generic authentication errors that avoid account enumeration.

Do not introduce public registration as a shortcut.

---

# 5. Owner and authorized-admin panel

Implement an authenticated management interface that uses server-enforced permissions.

The owner needs to manage the platform without manually editing database rows.

The panel should include:

### Beta applications

- List and filter applications.
- Review application details.
- Approve or reject an application.
- View the current application state.
- Resend an invitation where appropriate.
- See relevant timestamps and review history.

### Users and access

- View user accounts.
- Inspect account and entitlement status.
- Suspend or reactivate users according to permissions.
- Inspect linked installations.
- Revoke installations or authorization leases.
- Inspect relevant security and audit events.

### Release management

- View releases and their publication state.
- Upload or register a release artifact.
- Validate artifact metadata and checksums.
- Publish, withdraw, or roll out releases when authorized.
- View rollout status and release failures.

### Platform health

- Display meaningful service-health information.
- Show relevant error rates and update failures.
- Avoid exposing secrets, raw tokens, private server configuration, or unnecessary user data.

### Role model

Use server-side role and permission enforcement.

Suggested roles:

- `USER`
- `BETA_REVIEWER`
- `ADMIN`
- `OWNER`

The owner and explicitly authorized administrators may approve or reject beta applications, according to their assigned permissions.

Use least privilege. Do not grant every reviewer access to user suspension, release signing, or owner-level settings.

Only the owner or a suitably authorized role may grant elevated roles. Administrators must not be able to elevate themselves.

Every privileged action must be checked on the server and recorded in an audit log.

Protect destructive actions with confirmation and clear feedback. Use pagination and filtering rather than loading unbounded records.

---

# 6. Account approval and invitation lifecycle

Implement this complete lifecycle:

`Application submitted → Pending review → Approved or rejected → Invitation issued → Invitation accepted → Account activated`

### Application submission

- Normalize email addresses consistently.
- Validate all input on the server.
- Prevent duplicate pending applications for the same normalized email.
- Use generic responses where necessary to prevent account enumeration.
- Rate-limit repeated submissions.
- Record application timestamps and status changes.

### Approval

Only the owner or an explicitly authorized administrator may approve or reject applications.

Approval must not immediately activate a user account.

On approval, issue an invitation and arrange for an email to be sent.

### Invitations

- Generate cryptographically random tokens.
- Store only a secure hash of the invitation token.
- Make invitations single-use.
- Give invitations a configurable expiry; use 24 hours as the initial default unless the existing infrastructure requires another documented value.
- Invalidate older invitations when a replacement is issued.
- Never place raw invitation tokens in application logs.
- Prevent invitation tokens from leaking through analytics, referrer headers, or third-party scripts.
- Use an appropriate outbox or reliable delivery mechanism so database state and email delivery cannot silently diverge.
- Make invitation acceptance atomic so simultaneous requests cannot activate an account twice.
- Return clear errors for expired or already-used invitations.

### Account activation

After validating the invitation, the applicant sets a password and activates the account.

The server must atomically verify and consume the invitation, create or activate the account, assign the initial role, and record the audit event.

Ensure retries cannot create duplicate accounts.

Email delivery must be configured through environment variables or a supported provider integration. Do not hardcode credentials.

---

# 7. Desktop identity, installation linking, and revocation

Integrate SCOUT.exe with the managed platform using the existing desktop architecture.

Inspect the actual desktop packaging and runtime before choosing the implementation.

Do not assume SCOUT uses Tauri, Electron, or another particular desktop framework until verified.

Each installation should have a distinct server-recognized installation identity and credential lifecycle.

Implement an appropriate pairing flow that allows a user to authenticate and link their desktop installation to their account without exposing account passwords to insecure local interfaces.

The flow should:

- Authenticate the user through an appropriate trusted mechanism.
- Associate the installation with the authenticated account.
- Issue an installation-specific credential.
- Store credentials using the platform's secure credential-storage facilities where available.
- Support credential rotation.
- Allow installation revocation.
- Reject revoked credentials.
- Prevent one installation from silently impersonating another.
- Avoid putting long-lived credentials in URLs, logs, source code, or ordinary configuration files.

If the current desktop runtime exposes a local web server or browser-based control interface, assess its trust boundaries. Do not assume that a locally hosted page is automatically secure.

Do not weaken local protections while adding account authentication.

If the current desktop application already has a functional authentication or authorization flow, preserve its API and behavior during migration through a compatibility adapter.

---

# 8. Offline authorization leases

Implement offline authorization without making the website a dependency for every match or every tournament operation.

## 8.1 Lease rules

An online authorization request must validate:

- Account status.
- Installation status.
- Entitlement.
- Applicable release or client-version policy.
- Any relevant revocation or suspension state.

The server then issues a signed authorization lease containing the necessary policy and binding information.

The lease should include fields equivalent to:

- Unique lease identifier.
- Account identifier.
- Installation identifier.
- Issue time.
- Expiration time.
- Maximum offline tournament-start allowance.
- Entitlement or authorization version.
- Policy version.
- Signing key identifier.
- Any required compatibility information.

Use a seven-day maximum lease lifetime as the initial proposal, configurable by the server. Document this decision so it can be changed through policy rather than an emergency client rewrite.

The initial allowance must be no greater than three starts per lease.

The desktop client must verify the signature and all relevant bindings. It must not trust a client-supplied allowance or a locally editable `startsRemaining` value as proof of authorization.

Use an established cryptographic signing implementation rather than inventing a protocol.

Keep signing private keys outside the desktop application and ordinary application runtime configuration.

Support key rotation and key identifiers.

## 8.2 Exactly-once tournament-start accounting

The application must count tournament sessions, not individual matches.

Introduce a stable `tournament_session_id` or equivalent identifier that persists across restarts of the same tournament session.

Rules:

- Starting a genuinely new tournament session consumes one start.
- Starting another match inside the same tournament does not consume another start.
- Opening settings or OBS does not consume a start.
- Restarting SCOUT must not charge the same session again.
- Retrying a request must not double-charge a session.
- Crashes must not permit an already-consumed start to be counted twice or silently restore an allowance.
- The same lease/session pair must be idempotent.
- Exhausted leases must prevent starting a new tournament until online reauthentication succeeds.
- An already-active tournament must not be abruptly terminated because the lease expires or the allowance reaches zero.
- An online refresh may issue a new lease with an allowance of up to three starts.
- Failed authentication must never refresh the allowance.

Use a durable local journal or equivalent persistence, atomic writes, and appropriate locking or transaction semantics.

Use a unique constraint equivalent to:

`UNIQUE(lease_id, tournament_session_id)`

The backend must enforce relevant constraints atomically. If the client communicates usage records, retries must be idempotent and the server must validate the records rather than blindly trusting client-reported remaining allowance.

Do not claim that offline accounting on a user-controlled computer is impossible to tamper with. Use signed leases, secure local storage, durable records, server-side reconciliation, and reauthentication to reduce abuse. Document residual limitations such as executable patching or local-state rollback.

## 8.3 Offline failure behavior

If the platform becomes unavailable:

- A valid lease may continue to authorize permitted local operation.
- Local GSI processing must remain functional.
- The overlay must remain functional.
- OBS integration must remain functional.
- The current tournament must continue.
- The application must explain when online reauthentication is required.
- No repeated background network failures should freeze the interface or spam logs.
- Network errors must be distinguished from revoked or invalid authorization.

Do not confuse a temporary network failure with a confirmed account suspension or lease revocation.

Preserve the existing five-second GSI signal-loss behavior unless testing demonstrates a defect that justifies a separately documented change.

Preserve the distinction between missing GSI data and an authoritative empty value.

---

# 9. Secure automatic updates

Implement a secure automatic-update mechanism that fits the actual packaging technology discovered during the baseline audit.

Do not select an updater library until the current executable, installer, runtime, and distribution format have been identified.

The update system must provide:

- Versioned release metadata.
- Release channels where justified, such as stable and beta.
- Signed update manifests.
- Cryptographic artifact hash verification.
- Signature verification before installation.
- Protected signing keys.
- Version compatibility checks.
- Protection against unauthorized downgrades.
- Interrupted-download recovery.
- Installation-failure handling.
- Safe restart behavior.
- Release withdrawal.
- Staged rollout and rollout cancellation.
- Clear update status and error reporting.

Where appropriate for the Windows distribution, use Authenticode-signed executables and installers.

Never embed an artifact-signing private key in SCOUT.exe or commit it to the repository.

Separate signing authority from the public metadata API and normal application runtime.

The client must verify the downloaded artifact independently; a successful HTTP response or matching version string is not proof of authenticity.

Updates must not silently overwrite user data, tournament state, or configuration.

Provide a recovery strategy if an update fails. Do not promise automatic rollback unless the actual updater implementation supports it.

Test updates from a clean install and from supported existing versions.

Do not distribute an update mechanism that is only simulated or that installs unverified artifacts.

---

# 10. Database design and integrity

Adapt these logical entities to the existing database and ORM. They are a proposed domain model, not a requirement to create duplicate tables if equivalent models already exist.

- `beta_applications`
- `users`
- `user_roles`
- `account_invitations`
- `installations`
- `installation_credentials`
- `entitlements`
- `offline_leases`
- `tournament_sessions`
- `offline_lease_consumptions`
- `releases`
- `audit_logs`
- `telemetry_events`

Use appropriate foreign keys, indexes, timestamps, and explicit status fields.

Important invariants:

1. One pending application per normalized email, enforced in the database where supported.
2. Invitation tokens are stored as hashes and can be consumed only once.
3. Account activation and invitation consumption are atomic.
4. Lease allowances are bounded between zero and three starts.
5. Lease expiration must be later than issue time.
6. Each lease has a unique identifier.
7. The same `(lease_id, tournament_session_id)` cannot consume two starts.
8. Revoked installations cannot obtain or refresh authorization.
9. Suspended users cannot obtain or refresh authorization.
10. Only authorized roles may perform administrative actions.
11. Published releases must have validated metadata, artifact hashes, and appropriate signature information.
12. Version and channel combinations must obey an explicit uniqueness or release-history policy.
13. Audit records must preserve the identity of the actor and the action performed.
14. Application retries must not duplicate invitations, activations, lease charges, or releases.
15. Secrets and raw authentication tokens must not be stored in audit records.

Use transactions for multi-record operations and appropriate uniqueness constraints to prevent race conditions.

Do not rely exclusively on frontend validation or ORM-level checks for security-critical invariants.

Use database migrations that are safe to apply to existing data. If an invariant requires a database-specific partial index or constraint, implement it through the appropriate migration mechanism.

Document any fields that are derived, cached, or authoritative.

Do not treat a client-maintained remaining-start counter as the authoritative source of authorization.

---

# 11. API contracts

Inspect existing endpoints before creating new ones. Reuse compatible routes and version interfaces where appropriate.

The following are logical endpoint contracts to implement or map onto the existing API.

Base path, if consistent with the existing architecture:

`/api/v1`

### Public and account endpoints

- `POST /beta-applications`
- `GET /beta-applications/me`, where an appropriate verification or authenticated flow exists.
- `POST /account-invitations/accept`
- `POST /auth/login`
- `POST /auth/logout`
- `POST /auth/password-recovery`
- `POST /auth/password-recovery/complete`

No public registration endpoint.

### Administrative endpoints

- `GET /admin/beta-applications`
- `POST /admin/beta-applications/{id}/approve`
- `POST /admin/beta-applications/{id}/reject`
- `POST /admin/beta-applications/{id}/resend-invitation`
- Appropriate user, role, installation, lease, audit, and release-management endpoints.

Every endpoint must perform server-side authentication, authorization, input validation, and audit logging where appropriate.

### Desktop identity and installation endpoints

- `POST /desktop/pairing-requests`
- Appropriate endpoints to authorize or complete pairing.
- `POST /desktop/token/refresh`
- `GET /desktop/me`
- `GET /installations`
- `DELETE /installations/{id}`
- An authorized endpoint for revoking another installation when permitted.

Choose pairing semantics that fit the actual desktop UI and authentication system. Do not implement an insecure device-code flow simply to match these route names.

### Lease endpoints

- `POST /desktop/leases/issue`
- `POST /desktop/leases/refresh`
- `POST /desktop/leases/usage`
- `GET /desktop/leases/current`

Define request and response schemas, authentication requirements, error handling, idempotency behavior, and rate limits for every endpoint.

### Update endpoints

- `GET /desktop/updates/latest`
- `GET /desktop/updates/manifest/{version}`
- Authorized release-management endpoints for creating, validating, publishing, withdrawing, and rolling out releases.

Public update metadata must not expose signing secrets or internal deployment configuration.

### Consistent errors

Use a predictable error envelope, adapted to the existing API convention. For example:

`{ error: { code, message, requestId } }`

Provide stable error codes for conditions such as:

- `ACCOUNT_PENDING`
- `ACCOUNT_SUSPENDED`
- `INVITATION_EXPIRED`
- `INVITATION_ALREADY_USED`
- `INSTALLATION_REVOKED`
- `ENTITLEMENT_REQUIRED`
- `LEASE_EXHAUSTED`
- `LEASE_EXPIRED`
- `LEASE_REVOKED`
- `UPDATE_SIGNATURE_INVALID`
- `UPDATE_VERSION_BLOCKED`
- `RATE_LIMITED`
- `VALIDATION_FAILED`

Do not return stack traces, secret values, database details, or internal server information to end users.

Document the final request and response schemas, not just route names.

---

# 12. Desktop reliability and operator experience

In addition to the website, address the highest-priority desktop reliability issues identified in previous SCOUT reviews.

Prioritize reliability and validation on real tournament machines over speculative new features.

## 12.1 Guided first-run workflow

Where compatible with the existing application, improve first-run setup with a clear sequence:

1. Verify CS2 and GSI setup.
2. Configure teams.
3. Configure players.
4. Create or select a match.
5. Configure overlay output.
6. Configure OBS integration.
7. Run a preflight check.
8. Start the tournament.

Avoid forcing existing users through the wizard on every launch. Preserve existing configurations.

## 12.2 Preflight and health dashboard

Implement actionable readiness checks for relevant systems:

- CS2/GSI connectivity.
- Required configuration.
- Match and team readiness.
- Overlay output.
- OBS connection or output status where detectable.
- Required files and permissions.
- Platform authentication and offline authorization status.
- Available update and version status.
- Critical local errors.

Clearly distinguish blocking failures from warnings.

Each diagnostic should explain the problem and, where possible, give a specific corrective action.

Add watchdog and recovery behavior where justified by confirmed issues. Do not create aggressive restart loops.

## 12.3 Reliability and lifecycle testing

Test:

- CS2 starting and stopping.
- Missing, delayed, stale, and malformed GSI data.
- GSI disconnect and reconnect.
- Match restart and tournament restart.
- App restart and crash recovery.
- OBS starting, stopping, and reconnecting.
- Network loss and recovery.
- Platform outage during an active tournament.
- Overlay positioning and display changes.
- Performance and memory usage during extended sessions.
- Keyboard shortcuts and operator controls.
- Local persistence and recovery from interrupted writes.

Keep the existing five-second signal-loss behavior unless a deliberate, tested change is justified.

Do not implement automatic spectator-camera switching, a plugin ecosystem, Replay Studio, extra tournament run modes, elaborate dashboard customization, or advanced analytics as part of these phases. Those features are not prerequisites for the website and closed-beta platform.

---

# 13. Security, privacy, and operations

Implement security controls appropriate to the actual architecture.

### Web security

- Authentication and server-side authorization.
- CSRF protection where applicable.
- Secure cookies and session handling.
- Rate limiting and abuse prevention.
- Input validation and output encoding.
- Protection against cross-account IDOR vulnerabilities.
- Secure invitation and password-recovery flows.
- No secrets in client bundles.
- No tokens in URLs or logs.
- Safe administrative operations.
- Audit trails for privileged actions.
- Appropriate HTTP security headers and content security policy.

### Desktop security

- Validate local IPC and local HTTP trust boundaries.
- Protect installation credentials.
- Verify lease signatures.
- Verify update manifests and artifacts.
- Handle revoked credentials safely.
- Avoid exposing sensitive state through debug logs.
- Do not treat client-side checks as a substitute for server-side authorization.

### Infrastructure

- Store credentials and configuration in environment-specific secret management.
- Provide an `.env.example` containing placeholders, never real secrets.
- Add readiness and liveness checks where supported.
- Configure structured logs with secret redaction.
- Implement database backups and document restoration.
- Add database migrations and a recovery plan.
- Document deployment, domain, TLS, email, database, storage, and signing-key requirements.
- Use appropriate timeouts and bounded retries.
- Avoid uncontrolled background polling.
- Monitor API errors, email delivery, authorization failures, and update failures without collecting unnecessary tournament data.

The public website and API should be deployable independently of a user's local tournament session.

Do not require the website to be available for every local overlay operation.

---

# 14. Mandatory implementation phases

Execute these phases in order. Do not skip the validation gates.

## Phase 0 — Repository audit and baseline

Tasks:

- Inspect the repository and identify the actual stack.
- Run the existing application and build.
- Document current frontend, backend, database, desktop runtime, packaging, API contracts, and authentication.
- Establish a list of verified working flows.
- Identify confirmed bugs and high-risk areas.
- Create a testing plan and a compatibility map.
- Identify which proposed platform entities and endpoints already exist.
- Record unresolved deployment choices without inventing answers.

Do not begin a wholesale rewrite.

**Exit criteria:**

A written baseline report exists, current build commands are known, working functionality is documented, and a minimal regression test suite is in place or its absence is explicitly documented.

## Phase 1 — Website polish and functional public flows

Tasks:

- Improve landing-page clarity, hierarchy, imagery, and CTAs.
- Review navigation and route correctness.
- Improve responsive layouts and accessibility.
- Add or correct SEO and social metadata.
- Validate forms and all existing CTAs.
- Add meaningful loading, success, empty, and error states.
- Optimize assets.
- Add privacy-conscious analytics only where the backend and consent/privacy model support them.
- Test the existing closed-beta application flow without introducing a new account system prematurely.

Do not rebuild the backend during this phase.

Do not change existing API contracts unless necessary; if an endpoint must change, provide a backward-compatible transition.

**Exit criteria:**

The landing page and existing public routes work; beta applications can be submitted and errors are handled correctly; responsive and accessibility checks pass; existing desktop functionality remains unchanged.

## Phase 2 — Database foundations and compatible API boundaries

Tasks:

- Map existing models to the target domain model.
- Add only the missing schema and migrations.
- Define or version API contracts.
- Add validation, structured errors, request IDs, and consistent authorization middleware.
- Implement audit-log foundations.
- Add database constraints and indexes.
- Add integration tests for existing and new API behavior.

Do not yet switch the desktop client to a new authentication or lease protocol unless its compatible server implementation and tests are already available.

Keep existing clients operational throughout the transition.

**Exit criteria:**

Migrations apply safely, existing flows still work, API contracts are documented, and no existing production or development workflow depends on an endpoint that has been removed.

## Phase 3 — Beta applications, invitations, and account lifecycle

Tasks:

- Implement the application state machine.
- Implement owner and explicitly authorized-admin review.
- Implement invitation generation, secure storage, delivery, expiry, and single-use acceptance.
- Implement account activation and password setup.
- Implement login, logout, and password recovery.
- Enforce role-based authorization.
- Implement the initial account profile.
- Add abuse prevention and audit events.

If an existing authentication system is present, extend it rather than replacing it.

If email delivery is not configured, fail visibly and provide an actionable operational error. Do not simulate successful invitation delivery.

**Exit criteria:**

A complete application-to-activated-account flow passes automated integration tests, including expired invitations, reused invitations, duplicate submissions, unauthorized approvals, and concurrent acceptance attempts.

## Phase 4 — Profile, administration, and installation identity

Tasks:

- Complete the authenticated profile and account-security pages.
- Implement the administrative application queue.
- Add authorized user, installation, entitlement, and audit views.
- Implement secure desktop pairing.
- Implement installation credential storage and revocation.
- Add server-side enforcement of account and installation status.
- Integrate the desktop client using an adapter compatible with the existing runtime.

Do not remove the previous desktop authentication path until the new path has been tested against it and a safe migration or fallback strategy exists.

**Exit criteria:**

An approved user can activate an account, authenticate, link an installation, view its status, and revoke it. Unauthorized users and revoked installations are rejected by the server. The existing tournament and overlay workflows remain functional.

## Phase 5 — Signed offline leases and durable accounting

Tasks:

- Implement server-issued signed authorization leases.
- Implement client-side signature and binding verification.
- Implement a maximum of three tournament starts per lease.
- Implement stable tournament session identifiers.
- Implement durable local usage accounting.
- Enforce idempotent consumption and recovery after restart or crash.
- Implement online refresh and lease renewal.
- Implement clear handling for exhausted, expired, revoked, and temporarily unverifiable leases.
- Ensure an active tournament continues when a lease expires or the website becomes unavailable.
- Document the limitations of offline anti-tampering.

Do not deploy a client that depends on an unfinished lease endpoint.

Use a staged rollout, test build, or feature flag so old and new clients can coexist safely during the transition.

**Exit criteria:**

All lease tests pass, including the first three starts, rejection of a fourth start, renewal after reauthentication, duplicate-session retries, restarts, crashes, temporary network outages, revoked installations, and continued operation of an already-active tournament.

## Phase 6 — Secure automatic updates

Tasks:

- Implement the updater appropriate to the verified desktop packaging technology.
- Add signed manifests and artifact integrity verification.
- Protect signing keys.
- Implement version policy, update channels, release publication, staged rollout, and withdrawal.
- Add interrupted-download and failed-install recovery.
- Preserve user configuration and tournament data.
- Test clean installation and upgrades from supported versions.
- Document release and signing procedures.

Do not enable automatic production updates until verification and recovery have been tested.

If signing infrastructure or packaging prerequisites are unavailable, implement and test the safe release-management foundations first. Do not ship a fake updater or an updater that accepts unverified artifacts.

**Exit criteria:**

A valid release can be published and installed, a tampered release is rejected, interrupted updates recover safely, and a failed update does not silently corrupt the existing installation or its user data.

## Phase 7 — Operational hardening and desktop reliability

Tasks:

- Complete the first-run workflow and preflight diagnostics.
- Add or improve recovery for confirmed GSI, OBS, overlay, and persistence failures.
- Verify clean Windows installation and startup.
- Test network and platform outages during active tournaments.
- Harden local IPC and authentication boundaries.
- Add CI for applicable linting, type checking, tests, and builds.
- Add appropriate frontend regression checks and desktop integration tests.
- Validate deployment, backup restoration, secret configuration, logging, and health checks.
- Confirm privacy and telemetry policies.

**Exit criteria:**

The release candidate passes the full regression suite, installation and recovery tests, security acceptance tests, and the documented manual tournament validation checklist.

## Phase 8 — Closed-beta release readiness

Tasks:

- Verify the complete application, approval, invitation, activation, download, installation-linking, lease, and update journey.
- Confirm role permissions using real test accounts.
- Confirm owner and authorized-admin workflows.
- Test fresh installation, upgrade, revoked installation, suspended account, and offline scenarios.
- Review privacy and security documentation.
- Verify production configuration contains no committed secrets.
- Verify backups and restoration procedures.
- Confirm release artifacts and manifests are signed and verified.
- Prepare a rollback and incident-response plan.
- Publish only features that have passed their acceptance tests.

**Exit criteria:**

The platform is ready for a controlled closed-beta release with documented operational procedures and no unresolved critical security or data-integrity defects.

---

# 15. Phase-to-phase compatibility rules

These rules apply to every phase.

### Rule A — Expand, migrate, contract

When changing a schema or API:

1. **Expand:** Add the new schema, endpoint, or field without removing the old one.
2. **Migrate:** Update and test the relevant client or service to use the new interface.
3. **Verify:** Confirm both the new flow and required legacy flows work.
4. **Contract:** Remove obsolete compatibility code only in a later change, after evidence shows it is no longer needed.

Never combine a breaking backend replacement and a future client fix into a single multi-phase assumption.

### Rule B — Deploy compatible dependencies first

Before changing a desktop client to require a new endpoint, ensure the endpoint is implemented, deployed or available in the same release, documented, and tested.

If the platform is not yet deployed, the development environment must still provide a complete working integration.

### Rule C — No broken intermediate states

At the end of each phase:

- Build the frontend.
- Build the backend.
- Run applicable unit and integration tests.
- Apply migrations to a representative database.
- Verify existing API contracts.
- Verify the desktop app still builds.
- Run relevant overlay, GSI, and OBS regression tests.
- Update `.env.example`, API documentation, and setup instructions.
- Record remaining issues and the next phase's prerequisites.

Do not mark a phase complete merely because the code compiles.

### Rule D — Use explicit interfaces

Keep clear boundaries between:

- Marketing website.
- Account and administrative API.
- Desktop authentication.
- Authorization lease service.
- Update metadata and artifact distribution.
- Local tournament engine.
- GSI and OBS integration.
- Analytics and audit logging.

Do not let marketing components directly access the database. Do not let cloud services become the default transport for live tournament events.

### Rule E — Database migration safety

- Use forward migrations.
- Back up relevant data before destructive operations.
- Test migration and recovery procedures.
- Avoid dropping fields while old code still depends on them.
- Make migrations safe to retry where practical.
- Use transactions where supported.
- Document migrations that cannot be reversed automatically.
- Preserve existing accounts, settings, tournaments, and configuration.

### Rule F — Keep incomplete features disabled

If a feature requires a later phase, keep it behind a feature flag or leave it inaccessible until its complete dependency chain is ready.

A disabled feature must not interfere with current users.

### Rule G — Preserve local operation

The website, account service, analytics, and release service must not become accidental runtime dependencies for local tournament operations.

An online outage must not crash SCOUT, break OBS output, reset a tournament, or destroy local state.

---

# 16. Required automated security acceptance tests

Create tests in the conventions of the existing repository. Use the following as the minimum acceptance criteria.

## Authentication and administration

- Public account registration is unavailable.
- A public application creates no account.
- Only the owner or explicitly authorized admins can approve applications.
- Unauthorized reviewers cannot grant themselves elevated roles.
- An invitation expires correctly.
- An invitation cannot be accepted twice.
- Concurrent invitation acceptance does not create duplicate accounts.
- Suspended users cannot obtain new authorization.
- Users cannot access another user's profile or installations.
- Sensitive authentication operations are rate-limited.
- Tokens and secrets are not written to logs.

## Offline authorization

- A valid lease verifies successfully.
- A tampered signature is rejected.
- A lease bound to another installation is rejected.
- A lease bound to another account is rejected.
- Exactly three distinct new tournament sessions can be authorized per lease.
- A fourth new session is blocked until successful online refresh.
- Retrying the same session does not consume another start.
- Restarting SCOUT does not consume another start for the same session.
- Starting a new match inside the same tournament does not consume another start.
- A crash or interrupted write does not silently restore an already-consumed allowance.
- An expired lease does not terminate an active tournament.
- A temporary website outage does not break a valid offline session.
- A revoked installation cannot refresh its lease.
- Failed reauthentication cannot replenish the allowance.
- A forged client-side remaining-start count is not accepted as authoritative.

## Updates

- A valid signed update can be verified.
- An artifact with a modified hash is rejected.
- An invalid manifest signature is rejected.
- Unauthorized release publication is blocked.
- Downgrade policy is enforced.
- Interrupted downloads are handled safely.
- Failed installation does not silently corrupt configuration or tournament data.
- Release withdrawal and rollout cancellation work.
- No signing private key is shipped in the client or committed to the repository.

## Website and operational security

- Cross-account resource access is rejected.
- Administrative endpoints enforce role permissions server-side.
- CSRF protections work where applicable.
- Invitation and recovery tokens are excluded from logs.
- Rate limits work.
- Validation rejects malformed and unexpected input.
- Audit events are generated for privileged actions.
- Telemetry rejects or excludes unapproved event fields.
- Local GSI and OBS behavior remains functional during platform outages.
- A migration preserves existing user and tournament data.
- Backup restoration is tested.

---

# 17. UI and regression testing

Implement automated checks appropriate to the current frontend framework and test stack.

Cover:

- Landing page rendering.
- Navigation and all major CTAs.
- Beta application validation and submission feedback.
- Login and invitation flows.
- Profile loading, empty states, and errors.
- Admin permission boundaries.
- Mobile and tablet layouts.
- Accessible labels and keyboard navigation.
- Download authorization.
- Installation status and revocation.
- Update status and failure feedback.

Use screenshots or visual regression testing for important pages when practical, but do not let fragile pixel-perfect tests replace functional assertions.

For desktop functionality, add automated tests where feasible and maintain a documented manual checklist for behavior that requires a real Windows machine, CS2, or OBS.

Do not claim full end-to-end desktop validation based only on frontend tests.

---

# 18. Implementation workflow and deliverables

Work phase by phase.

For each phase, provide:

1. **Scope:** What will change and why.
2. **Dependencies:** Which earlier work must already exist.
3. **Files and components:** The actual areas of the repository being modified.
4. **Implementation:** The working code and required migrations.
5. **Tests:** The tests added and commands executed.
6. **Results:** Actual build and test outcomes.
7. **Compatibility:** How existing clients and functionality remain operational.
8. **Security:** Relevant risks and mitigations.
9. **Documentation:** Any API, environment, deployment, or operational changes.
10. **Remaining work:** Anything explicitly deferred to a later phase.

Use small, logically grouped commits or equivalent reviewable changes.

Do not silently skip a failed test. Investigate it, fix it where within scope, or report the exact blocker and why it prevents the phase from being considered complete.

Do not implement all phases as one unreviewable rewrite.

Before starting a later phase, verify that its dependencies are actually complete rather than assuming earlier phases succeeded.

If the current architecture contradicts a requirement, explain the conflict and propose the smallest safe migration. Do not silently make a major architectural decision.

### Required final deliverables

- Updated source code.
- Database migrations.
- Automated tests.
- Documented API contracts.
- Updated environment-variable example.
- Developer setup instructions.
- Deployment and configuration instructions.
- Desktop packaging and updater documentation based on the actual discovered technology.
- Security and privacy documentation.
- Closed-beta administration instructions.
- A release-readiness checklist.
- A list of remaining known issues and any acceptance criteria not yet satisfied.

---

# 19. Definition of done

The project is complete only when all applicable criteria are satisfied:

- The website presents SCOUT clearly and works across supported screen sizes.
- Public applications work without creating accounts.
- Owner and authorized-admin approval works.
- Invitation-based account activation works securely.
- Users can access their profile and authorized download.
- Desktop installations can be linked and revoked.
- The desktop client can obtain and validate signed authorization leases.
- Three offline tournament starts per lease are enforced without double-counting the same session.
- Online reauthentication refreshes the allowance.
- Active local tournaments survive platform outages and lease expiration.
- Automatic updates verify artifact authenticity before installation.
- Existing SCOUT overlay, GSI, OBS, and local tournament functionality remains intact.
- Database migrations preserve existing data.
- Administrative permissions are enforced on the server.
- Critical security and regression tests pass.
- Deployment and recovery procedures are documented.
- No unfinished phase leaves the application dependent on future work to function.

**Start with Phase 0. Do not jump directly into implementation of the new backend or desktop authorization system.** First establish the actual repository architecture, then proceed through the phases in order, preserving a working build at every boundary.
