# ioBroker.mixergy — Research & Project Scope

Research date: 2026-08-20. There is no official Mixergy developer documentation.

- **§2 (cloud API)** is **reverse-engineered from community integrations** and is entirely
  unverified against a real tank.
- **§3 (local LAN API)** was **captured live from a real tank on 2026-08-20** and supersedes
  what the community projects claim. Verified items are marked ✅.

---

## 1. What already exists

### ioBroker
**Nothing.** No adapter on the ioBroker adapter list, no `iobroker.mixergy` on npm, no
issue in `ioBroker/AdapterRequests`. This would be the first.

### Other platforms

| Platform | Project | Notes |
|---|---|---|
| Home Assistant (cloud) | [tomasmcguinness/homeassistant-mixergy](https://github.com/tomasmcguinness/homeassistant-mixergy) | The original. HACS custom repo, active since 2021. 30 s poll. Best source for the raw API shape. |
| Home Assistant (cloud) | [CaputoDavide93/Mixergy-Home-Assistant](https://github.com/CaputoDavide93/Mixergy-Home-Assistant) | Newer, heavily engineered fork-in-spirit (v2.x). **Its [`docs/api.md`](https://github.com/CaputoDavide93/Mixergy-Home-Assistant/blob/main/docs/api.md) is the best written API reference that exists** — token lifecycle, error taxonomy, HATEOAS walk, write model. |
| Home Assistant (**LAN**) | [cpaius/mixergy-local](https://github.com/cpaius/mixergy-local) | Talks to the on-tank Pi controller directly over HTTP. Read-only, but sub-second data. |
| Homebridge / HomeKit | [holamellamocd/homebridge-mixergy](https://github.com/holamellamocd/homebridge-mixergy) ([npm](https://npm.im/homebridge-mixergy)) | **TypeScript, Node 18+ — the closest thing to reusable code for a Node adapter.** |
| Ruby | [njh/ruby-mixergy](https://github.com/njh/ruby-mixergy) | Gem + CLI (`mixergy status/boost/charge/temperature`). Handy for manual API poking. |
| Domoticz | [forum thread](https://forum.domoticz.com/viewtopic.php?t=42612) | Python + cron, 5 min interval. Confirms no energy counter in the API. |
| Loxone | [google group](https://groups.google.com/g/loxone-english/c/Ogw8MUAsMxE) | Virtual HTTP Input + Virtual Output for token handling. |
| Matter / ESP32 | [tomasmcguinness/matter-esp32-mixergy-control](https://github.com/tomasmcguinness/matter-esp32-mixergy-control) | Physical control puck. |
| Pico W display | [wdj2005/mixergyPicoDisplay](https://github.com/wdj2005/mixergyPicoDisplay) | Charge-level display. |

### Official Mixergy position
No public developer API or documentation. [Apps & Dashboards](https://www.mixergy.co.uk/solutions/apps-and-dashboards/)
markets the consumer app, the "Mixergy IO" portfolio dashboard, Octopus Agile tariff
integration, and — notably — **MODBUS TCP for building-management-system integration**.
That MODBUS path is worth an email to Mixergy if this is for a commercial install;
it would be a far more stable contract than the reverse-engineered cloud API.

---

## 2. The cloud API contract (v2)

Root: `https://www.mixergy.io/api/v2`. HATEOAS — only the root is a fixed path;
everything else is discovered via `_links`.

### Auth
1. `GET /api/v2` → `_links.account.href`
2. `GET <account>` → `_links.login.href`
3. `POST <login>` `{username, password}` → **201** `{token, ttl}`
4. All subsequent calls: `Authorization: Bearer <token>`

### Discovery
5. `GET /api/v2` (authed) → `_links.tanks.href`
6. `GET <tanks>` → `_embedded.tankList[]`, each with `serialNumber`, `firmwareVersion`, `_links.self`
7. `GET <tank self>` → `tankModelCode`, `configuration` (a **JSON string**, contains `mixergyPvType`),
   and `_links`: `latest_measurement`, `control`, `settings`, `schedule`

### Read endpoints

| Endpoint | Fields |
|---|---|
| `latest_measurement` | `charge`, `topTemperature`, `bottomTemperature`, `state` (**JSON string**), `pvEnergy`, `clampPower`, `recordedTime`, `receivedTime` (epoch ms) |
| `settings` | `max_temp`, `cleansing_temperature`, `dsr_enabled`, `frost_protection_enabled`, `distributed_computing_enabled`, `divert_exported_enabled`, `pv_charge_limit`, `pv_cut_in_threshold`, `pv_target_current`, `pv_over_temperature` |
| `schedule` | `holiday: {departDate, returnDate}` (epoch ms), `defaultHeatSource` |

`state` parses to `{current: {target, heat_source, immersion, source?}}`.
`heat_source` ∈ `indirect | electric | heatpump`; `immersion` ∈ `on | off`.
`source` only appears when it equals `"Vacation"` (holiday mode).

### Write endpoints

| Call | Body | Clamp |
|---|---|---|
| `PUT control` | `{charge}` | 0–100 % |
| `PUT settings` | `{max_temp}` | 45–70 °C |
| `PUT settings` | `{cleansing_temperature}` | 51–55 °C |
| `PUT settings` | `{pv_cut_in_threshold}` | 0–500 W |
| `PUT settings` | `{pv_charge_limit}` | 0–100 % |
| `PUT settings` | `{pv_target_current}` | −1–0 |
| `PUT settings` | `{pv_over_temperature}` | 45–60 °C |
| `PUT settings` | `{dsr_enabled\|frost_protection_enabled\|distributed_computing_enabled\|divert_exported_enabled}` | bool |
| `PUT schedule` | **whole object** | read-modify-write |

### Quirks that will bite

1. **`settings` and `schedule` return `Content-Type: text/plain`.** Parse the body as text
   then `JSON.parse` — axios will hand you a string, not an object. Don't trust the header.
2. **Nested JSON strings** — `state` and `configuration` are strings inside the JSON.
3. **No energy counter.** The API exposes instantaneous power only; kWh must be integrated
   locally. Both the HA and Domoticz integrations do this. This matters for ioBroker's
   `sql`/`history` + `energymanager` style use.
4. **`pvEnergy` → power conversion is `pvEnergy / 60000` in the HA integration** — units
   undocumented and unverified. Validate against a real tank before trusting it.
5. **`heatpump` vs `heat_pump`** — the API spells it without the underscore.
6. **Schedule writes are lost-update-prone** — no field-level PATCH. GET → mutate → PUT
   must be serialised behind a mutex.
7. **HATEOAS links must be validated before sending the bearer token** (HTTPS + exact host).
   A misconfigured upstream returning `http://` or an off-host link would leak credentials.
   Don't follow redirects.
8. **The original HA integration sets `verify_ssl=False`.** Test with normal cert
   verification first; only relax it if there's a demonstrated chain problem.
9. **Token TTL** — refresh proactively (~5 min before expiry); retry a mid-poll 401 exactly
   once after re-login, then treat as bad credentials.
10. **Rate limits unknown.** Community consensus is 30–60 s polling. Don't go below 30 s.

---

## 3. The local (LAN) API — **verified against a real tank, 2026-08-20**

The tank ships with a Pi-based controller ("mixpi") exposing an **unauthenticated** HTTP API
on the LAN. Everything below marked ✅ was captured from a live tank; ✳️ is still inferred.

### 3.1 `GET /measurements` ✅

Response is `HTTP/1.1 200`, `transfer-encoding: chunked`, and — note — **no `content-type`
header at all**. The stream never ends; the server pushes until the client disconnects.

**It is newline-delimited JSON (NDJSON), one object per line.** The earlier assumption that
this needed an incremental `raw_decode` parser was wrong — 78/78 captured lines parsed
cleanly by splitting on `\n`. A buffer-until-newline reader is sufficient. (You must still
buffer across chunk boundaries: a TCP chunk can split mid-line.)

Three interleaved message classes, distinguished by which keys are present:

| Class | Discriminator | Measured cadence | Fields |
|---|---|---|---|
| **fast** | has `cp` | **100 ms** (60 msgs / 5.9 s) | `cp`, `dp`, `e`, `f` |
| **slow** | has `soc` | **501 ms** (12 msgs / 5.5 s) | `soc`, `tt`, `ft`, `bt`, `op`, `v`, `i`, `ats` |
| **relay** | has `dro` | **1049 ms** (6 msgs / 5.2 s) | `dro`, `iro`, `po` |

Every message also carries `ts` and `time`:
- `time` — epoch **ms**, wall clock ✅ (first sample decoded to 2026-08-20T08:44:35Z)
- `ts` — **ms since stream start**, monotonic, resets on every new connection ✅
  (26 → 5967 over the capture). Do *not* mistake this for a timestamp.

Field meanings — observed values from a tank sitting idle at 41.7 % charge:

| Key | Meaning | Observed | Confidence |
|---|---|---|---|
| `soc` | state of charge, % | 41.7 | ✅ |
| `tt` | top temperature, °C | 56.5 | ✅ |
| `ft` | flow temperature, °C | 55.7 | ✅ |
| `bt` | bottom temperature, °C | 21.2 | ✅ |
| `v` | mains voltage, V | 240.06–240.19 | ✅ |
| `i` | tank current, A | 0.0 (idle) | ✅ |
| `f` | grid frequency, Hz | 49.898–49.907 | ✅ |
| `op` | operating / heating flag | false | ✅ |
| `ats` | ambient (air) temperature, °C | 27.1 | ✳️ name inferred |
| `cp` | consumption/clamp power | 3.34–3.44 | ✳️ **units unresolved** |
| `dp` | discharge (export) power | 0 | ✳️ |
| `e` | energy counter? | 0 | ✳️ **unknown — undocumented anywhere** |
| `dro` | direct (immersion) relay | false | ✅ |
| `iro` | indirect relay | false | ✅ |
| `po` | pump output | false | ✅ |

**`cp` units are the open question.** 3.4 is implausible as whole-house watts and the tank
was drawing nothing (`i` = 0.0). Re-capture while a known load is running to resolve it.
Until then, expose `cp` raw and do not integrate it into a kWh counter.

**Cadences reconfirmed** on a second, independent connection 13 minutes later: 100 / 499 /
1045 ms. `ts` restarted at 22 ✅. Between the two captures grid frequency moved 49.90 → 50.08 Hz
and voltage 240 → 237 V, which is a useful sanity check that these are live measurements and
not stubbed constants.

**Concurrency: safe.** ✅ Three simultaneous stream clients were opened; all three received
byte-identical data from the same starting point. The Pi broadcasts one shared stream rather
than sampling per-connection, so an ioBroker adapter polling alongside anything else (or
alongside the tank's own cloud uploader) is fine.

### 3.2 `GET /status` ✅ — it *does* carry tank data

Captured 2026-08-20 08:56 UTC. Unlike `/measurements`, this one is a normal
`content-type: application/json` request/response — no streaming, no chunking.

```json
{"charge":41.6,
 "state":{"current":{"heat_source":"Indirect","immersion":"Off"},
          "heat_source":"Indirect",
          "relay":{"heat_source":"Indirect","immersion":"Off"},
          "system":"On"},
 "wifi_state":"unavailable"}
```

This **confirms the `mixergy-local` claim** and closes the last read gap: heat-source mode
and immersion state are available locally after all. Earlier scepticism here was misplaced —
the Pi's web UI is only a WiFi provisioning portal and simply never reads the tank fields,
but the endpoint serves both purposes.

| Field | Meaning | Confidence |
|---|---|---|
| `charge` | state of charge, % — agrees with `soc` on the stream (41.6 vs 41.6) | ✅ |
| `state.current.heat_source` | **commanded** heat source | ✅ |
| `state.current.immersion` | **commanded** immersion state | ✅ |
| `state.relay.heat_source` | **actual** relay position | ✅ |
| `state.relay.immersion` | **actual** immersion relay | ✅ |
| `state.heat_source` | top-level effective heat source | ✅ |
| `state.system` | system on/off | ✅ |
| `wifi_state` | WiFi association state; `"unavailable"` on this tank (wired) | ✅ |

**Quirks that will bite:**

1. **`state` is a real nested object here.** On the *cloud* API the equivalent `state` is a
   **JSON string** needing a second `JSON.parse` (§2). The two transports disagree — don't
   share a parser between them.
2. **Values are Capitalised** — `"Indirect"`, `"Off"`, `"On"`. The cloud API uses lower-case
   (`indirect`, `off`). Normalise to one casing before writing states, or the same tank will
   report differently depending on which transport is live.
3. **`current` vs `relay`** is a genuine commanded-vs-actual split the cloud API does not
   expose. Worth surfacing as separate states — it's how you'd see a relay that failed to
   follow a command.
4. **The setup portal reads `b.data.wifi`, but this firmware returns `wifi_state`.** The
   bundled UI's SSID display is therefore broken on this tank. Harmless for us — but it means
   the shipped portal and the shipped firmware are out of sync, so treat the JS bundle as a
   weak source of truth about response shapes.

### 3.3 Safety and security notes

⚠️ **`/connect`, `/disconnect` and `/rescanwifi` are unauthenticated writes.** A stray `GET
/disconnect` will knock the tank off the network and it will need re-provisioning at the
appliance. The adapter must issue **only `GET /measurements` and `GET /status`** — both confirmed safe,
read-only and unauthenticated — and any exploratory work must avoid those three routes
entirely.

⚠️ This is an unauthenticated control surface on the local network — anyone on the same network
can deprovision the tank. Worth raising with Mixergy and worth a VLAN if this goes onto a
shared network.

### 3.4 Verdict for the adapter

**Read-only** — no write path exists locally (the WiFi routes don't count). Local mode is a
data-quality upgrade, not a replacement for cloud control: sub-second temperatures, voltage,
current and grid frequency that the cloud API simply does not expose, at zero rate-limit
risk. Cloud remains mandatory for control. Layer local on top as an *additional* source.

**Local read coverage is now near-complete.** What each transport can give you:

| Data | Local | Cloud |
|---|---|---|
| charge % | ✅ `/status` + `soc` | ✅ |
| top / bottom temperature | ✅ | ✅ |
| **flow temperature** | ✅ `ft` | ❌ |
| **ambient temperature** | ✳️ `ats` | ❌ |
| heat source (commanded + actual) | ✅ | ✅ commanded only |
| immersion / indirect / pump relays | ✅ | partial |
| system on/off | ✅ | ❌ |
| **mains voltage / current / grid frequency** | ✅ | ❌ |
| power | ✳️ `cp`/`dp` units unresolved | ✅ `clampPower`, `pvEnergy` |
| target charge, settings, schedule/holiday | ❌ | ✅ |
| serial, model, firmware | ❌ | ✅ |
| **any write at all** | ❌ | ✅ |

So local wins decisively on physical measurement and latency; cloud remains mandatory for
identity, configuration and every write. Neither replaces the other.

Remaining gaps before Phase 5 can start: `cp`/`dp` units, and behaviour on controller reboot
or stream stall (needs a watchdog — no heartbeat is documented, and `ts` resetting to ~0 is
the only reconnect signal).

### 3.5 Outstanding capture — run this by hand

One unknown blocks Phase 5. Run it by hand in a normal terminal and paste the output back into this doc.

**`cp` / `dp` units.** Two idle captures 13 minutes apart both sat at **3.23–3.44** with
`i` = 0.0, `op` = false and `dro` = false, so nothing so far has moved the number. Re-capture
*while a known load is running* — put the tank on immersion boost so it draws ~3 kW:

```sh
curl -sN --max-time 10 http://<tank-ip>/measurements > mix-load.raw
```

Interpretation once you have it: if loaded `cp` lands near **3000** it's watts; near **3**
it's kW; near **13** it's amps. If `cp` does *not* move at all, it isn't the tank circuit —
most likely a whole-house/site CT clamp, in which case its baseline is unrelated site load
and it needs a different state entirely. The same run also confirms the `dro` immersion-relay
mapping and whether `i` rises to ~13 A.

Worth noting the idle baseline is suspiciously close to a Raspberry Pi's own ~3.4 W draw,
which would make `cp` a watts reading of the controller's own supply. That is a guess, not
a finding.

⚠️ Do **not** curl `/connect`, `/disconnect` or `/rescanwifi` — see §3.3.

---

## 4. Proposed ioBroker adapter scope

### Identity
- Repo `ioBroker.mixergy`, npm `iobroker.mixergy`, TypeScript
- `common.connectionType: "cloud"`, `common.dataSource: "poll"`, `common.tier: 3`
- `common.adminUI.config: "json"`, license MIT

### Configuration (`admin/jsonConfig.json`)
| Field | Type | Notes |
|---|---|---|
| `username` | text | Mixergy account email |
| `password` | password | must be in `protectedNative` + `encryptedNative` |
| `pollInterval` | number | 30–300 s, default 60 |
| `tanks` | table / multi-select | populated by a "Discover tanks" button → `sendTo` → `onMessage` |
| `enableLocal` | checkbox | opt-in LAN transport |
| `localHost` | text | Pi controller IP (field name `localHost` or `ip`, **not** `bind` — we don't listen) |

Requires `messagebox: true` for the discovery button.

### State tree

Multi-tank by default (one device per tank on the account) — an improvement on HA's
one-serial-per-entry model.

```
mixergy.0
├─ info
│  ├─ connection            indicator.connected   bool   r
│  └─ lastUpdate            value.time            number r
└─ <SERIAL>                                       device
   ├─ info                                        channel
   │  ├─ serialNumber       text                  string r
   │  ├─ modelCode          text                  string r
   │  ├─ firmwareVersion    text                  string r
   │  ├─ hasPvDiverter      indicator             bool   r
   │  ├─ recordedTime       value.time            number r
   │  └─ stale              indicator             bool   r
   ├─ measurement                                 channel
   │  ├─ charge             value                 number r  %
   │  ├─ targetCharge       value                 number r  %
   │  ├─ topTemperature     value.temperature     number r  °C
   │  ├─ bottomTemperature  value.temperature     number r  °C
   │  ├─ heatSource         text                  string r
   │  ├─ heating            indicator             bool   r
   │  ├─ electricHeat       indicator             bool   r
   │  ├─ indirectHeat       indicator             bool   r
   │  ├─ heatPumpHeat       indicator             bool   r
   │  ├─ power              value.power           number r  W
   │  ├─ energy             value.power.consumption number r kWh  (integrated locally)
   │  ├─ pvPower            value.power           number r  W
   │  ├─ clampPower         value.power           number r  W
   │  ├─ lowCharge          indicator             bool   r  (<5 %)
   │  └─ noCharge           indicator             bool   r  (=0 %)
   ├─ control                                     channel
   │  ├─ targetCharge       level                 number rw 0–100
   │  ├─ boost              button                bool   w
   │  └─ targetTemperature  level.temperature     number rw 45–70
   ├─ settings                                    channel
   │  ├─ cleansingTemperature  level.temperature  number rw 51–55
   │  ├─ dsrEnabled            switch.enable      bool   rw
   │  ├─ frostProtection       switch.enable      bool   rw
   │  ├─ distributedComputing  switch.enable      bool   rw
   │  ├─ divertExported        switch.enable      bool   rw
   │  ├─ pvCutInThreshold      level              number rw 0–500 W
   │  ├─ pvChargeLimit         level              number rw 0–100 %
   │  ├─ pvTargetCurrent       level              number rw −1–0
   │  └─ pvOverTemperature     level.temperature  number rw 45–60
   └─ schedule                                    channel
      ├─ defaultHeatSource  text                  string rw  electric|indirect|heat_pump
      ├─ holidayMode        indicator             bool   r
      ├─ holidayStart       text                  string rw  ISO 8601
      ├─ holidayEnd         text                  string rw  ISO 8601
      └─ holidayClear       button                bool   w
```

Notes for passing the ioBroker object checker:
- Every parent segment (`<SERIAL>`, and each of the five channels) needs an explicit
  `device`/`channel` object — missing intermediates are error **E3009** and it only fires
  against the live object dump attached to the submission PR.
- Writable string → role `text`; writable number → role `level`; write-only trigger → role
  `button`. Never `info.*` roles on writable states.
- Every `write: true` state above must have a matching branch in `onStateChange` — a
  writable state with no handler is flagged in manual review. If a state turns out to be
  read-only, set `write: false`.
- `instanceObjects` must include `info.connection` with role `indicator.connected`.

### Implementation notes
- `axios` client, 30 s timeout, response interceptor for logging
- `this.setInterval` / `this.setTimeout` only — never native timers
- Cache discovered HATEOAS links; clear them on 404/410 and re-discover next poll
- Single-flight locks for: auth refresh, discovery, schedule read-modify-write
- Measurement fetch is mandatory to a poll's success; settings + schedule fall back to
  last-known-good so a transient failure doesn't blank every state
- After a successful write, trigger an immediate re-poll so states converge
- On write failure, re-poll to restore the true value rather than leaving an unacked state
- Preserve `null` for missing/malformed readings rather than manufacturing zeroes

---

## 5. Delivery plan

| Phase | Work | Verify |
|---|---|---|
| 0 | Confirm **cloud** API access against a real tank using the Ruby CLI or a curl script — dump `latest_measurement`, `settings`, `schedule` verbatim | Real payloads captured; `pvEnergy` units resolved; content-type quirks confirmed |
| 1 | `npx @iobroker/create-adapter`, TypeScript, jsonConfig, encrypted password | `iobroker add mixergy` installs; admin config renders |
| 2 | Standalone API client module (no adapter deps): auth, discovery, link validation, fetch, write, clamps | Unit tests against recorded fixtures from Phase 0 |
| 3 | Object tree + read path + `info.connection` + energy integration | States populate from a real tank; values match the Mixergy app |
| 4 | Write path: control, settings, schedule (mutex) + `onStateChange` | Every writable state round-trips; app reflects the change |
| 5 | Optional local transport — NDJSON line reader for `/measurements` (§3.1), watchdog on stream stall | Fast temps/power update sub-second; survives controller reboot. **Blocked on the §3.5 captures.** |
| 6 | README, changelog, i18n, `engines.node >= 22`, CI green, `nogit: true` | `npx @iobroker/repochecker` clean of errors |
| 7 | npm publish, `npm owner add bluefox`, forum post, PR to `ioBroker.repositories` | Adapter checker "no errors" + object-structure gate green |

Phases 0–4 give a genuinely useful adapter. Phase 5 is optional. Phases 6–7 are the
community-repo tax and are the part most likely to take longer than expected (maintainer
review typically queues 1–2 weeks).

Rough effort: **3–5 days** to a working private adapter, plus a further 1–2 days spread over
weeks for submission cleanup.

---

## 6. Decisions to make before starting

1. **Cloud only, or cloud + local?** Recommend starting cloud-only (it's the only write
   path) and adding local in a later minor version.
2. **Is a MODBUS TCP contract available?** If this is a commercial deployment, ask
   Mixergy — it's their documented BMS integration route and would avoid the whole
   reverse-engineered-cloud-API risk class. Could be a separate `connectionType: local`
   adapter, or a third transport here.
3. **Publish to the community repo, or keep it private?** Publishing means committing to the
   repochecker/object-checker gates and ongoing maintenance of an undocumented upstream API.
4. **Single-tank (mirror HA) or multi-tank?** Recommend multi-tank device-per-serial —
   marginal extra work, and it removes the "find your serial number" setup step.

## 7. Risks

- **No official API, no terms of use.** Mixergy can change or close it without notice; the
  existing integrations all carry that risk today.
- **Password-based auth only.** No OAuth, no API keys — the adapter must store account
  credentials (ioBroker's `encryptedNative` handles this, but it's still a plaintext-equivalent
  secret at runtime).
- **Rate limits undocumented.** A too-aggressive default poll could get accounts throttled.
- **`pvEnergy` scaling is unverified** — it comes from reading other people's code, not a spec.
- **Local `/measurements` field names are now verified** (§3.1) except `cp` units, `e`, and `ats`.
- **The local API is an unauthenticated control surface on the LAN** (§3.3). Anyone on the
  network can deprovision the tank via `GET /disconnect`. This is a pre-existing property of
  the appliance, not something the adapter introduces, but it should inform network design.
- **Endpoint security tooling may flag LAN probing.** Plain-HTTP requests to a bare internal
  IP, several concurrent held-open streaming connections, and pulling a JS bundle off an
  internal host all look unusual. Run LAN captures by hand (§3.5) and keep them short and
  sequential.
