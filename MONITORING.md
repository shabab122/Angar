# Production monitoring and incident alerts

The application records bounded, sanitized technical incidents across branches. Main/installation administrators with `monitoring.view` can review them in **Technical incidents**. `monitoring.manage` controls acknowledgement and email policy. Existing restaurant operations alerts remain separate.

## Signals

- API responses with status 500–599 create incidents grouped by branch, HTTP method and route template. Only counters and route labels are retained: no body, query, cookies, addresses, tokens or raw error messages. Quiet API incidents resolve after five minutes without another observed failure.
- Background task failures and subsequent successes create failure/recovery signals. Worker heartbeat age detects stalled operations; ordinary tasks use 90 seconds, backup/off-site tasks allow 15 minutes for larger jobs.
- The monitor inspects the latest backup, off-site copy, printer, customer-notification and staff-alert delivery job in each branch. Failed/uncertain results require review; the original feature panels retain full job-specific histories. A later successful replacement clears the latest-job subsystem incident. This monitor does not automatically resend business jobs.
- `/readyz` checks the database and local worker freshness. It returns 503 if unavailable/stale and contains no credentials. `/healthz` retains its existing behavior. Process counters reset at restart; this is operational monitoring, not a durable metrics/time-series service. Incident/delivery history expires after 30 days and stale process instances after three minutes.

## Technical email alerts

Use the existing SMTP fields and add recipients:

```dotenv
MAIL_MODE=smtp
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
MAIL_FROM=
MONITOR_EMAIL_TO=operator@example.com
MONITOR_EMAIL_ENABLED=false
```

Set actual SMTP details and replace the example recipient. Restart, then enable email from the monitoring panel with the administrator password. `MONITOR_EMAIL_ENABLED` is the initial policy when no saved policy exists; the panel policy takes precedence thereafter. Local `MAIL_MODE=outbox` is available for development and is prohibited in production, as before. No messages are sent by installing this ZIP.

An incident generation produces at most one open alert and one recovery alert. Acknowledgement marks operator review; it does not falsely resolve a still-failing subsystem. A lost SMTP acknowledgement is **uncertain** and is not automatically retried. Review actual mail delivery, then use the password-protected retry action with acceptance of a possible duplicate.

## Independent downtime watchdog

The application cannot send alerts while it or its host is down. Run the watchdog under a separate process supervisor; use a different host/network and separate SMTP access for host/network outage detection. Running it beside the web process only detects application/database/worker failure while that machine remains alive.

Configure the target and a private, persistent state file in that watchdog environment:

```dotenv
MONITOR_URL=https://your-restaurant.example/readyz
MONITOR_STATE_FILE=/var/lib/angar-monitor/watchdog.json
```

The watchdog uses the same configuration loader and SMTP settings, but never connects to MongoDB. Its `.env` still needs the required base configuration variables. Keep the state file and credentials outside public paths. One process may own each state file; the lock directory prevents simultaneous senders. After a crashed process, verify that it has stopped before removing a stale `.lock` directory. Keep the JSON state to retain outage deduplication.

```bash
npm run monitor:watch
```

Probes every 30 seconds with a five-second timeout. Two consecutive failures produce one down alert; a later healthy probe produces one recovery alert. Redirects are rejected. The probe expects a JSON `ready: true` result. SMTP intent is saved atomically before sending, so restarting after an uncertain send does not automatically duplicate the outage alert. Uncertain sends remain visible in the watchdog's private JSON/log output for operator review; they are not automatically requeued.

```bash
npm run monitor:watch -- --once
```

Runs one probe using the same persistent state. Repeated scheduled `--once` invocations must use that same state path for the two-failure rule and recovery tracking. Target only your own readiness endpoint.

## Recovery and verification

Database restore clears process-instance and pending technical-email records and disables the saved technical email policy. Review SMTP/recipients, then explicitly re-enable after recovery. The external watchdog has its own independent persistent state; preserve/review it separately.

Tests use isolated MongoDB databases, controlled mail functions and a pure watchdog cycle; no production SMTP or third-party monitoring account is required. Production use additionally requires the operator's SMTP credentials and independently supervised watchdog deployment.
