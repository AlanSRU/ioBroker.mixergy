# Captures

Raw data taken from a live Mixergy tank's on-board Pi controller, 2026-08-20.
These are the fixtures behind the verified claims in [`../SCOPE.md`](../SCOPE.md) §3,
and the test data for Phase 2. Re-capturing means more LAN traffic — don't delete.

| File | What it is |
|---|---|
| `measurements.raw` | 5.9 s of `GET /measurements`, 78 NDJSON lines, tank idle at 41.7 % charge, no load |
| `meas.headers` | Response headers for the above — note the absent `content-type` |

Not captured yet: `GET /status`, and a `/measurements` run under a known load to
resolve `cp` units. See SCOPE.md §3.5.

## Second round, 2026-08-20 08:56–08:57 UTC

| File | What it is |
|---|---|
| `status.json` + `status.headers` | `GET /status` — tank charge, commanded vs relay heat source, system on/off |
| `measurements-2.raw` | 3.6 s of `/measurements`, 48 lines, independent connection 13 min after the first |

Tank was **idle** for both rounds (`i` = 0.0, `op` = false, `dro` = false), so `cp` units
remain unresolved. Still needed: a `/measurements` capture under immersion load — SCOPE.md §3.5.
