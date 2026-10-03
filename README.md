![Logo](admin/mixergy.png)
# ioBroker.mixergy

[![NPM version](https://img.shields.io/npm/v/iobroker.mixergy.svg)](https://www.npmjs.com/package/iobroker.mixergy)
[![Downloads](https://img.shields.io/npm/dm/iobroker.mixergy.svg)](https://www.npmjs.com/package/iobroker.mixergy)
![Number of Installations](https://iobroker.live/badges/mixergy-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/mixergy-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.mixergy.png?downloads=true)](https://nodei.co/npm/iobroker.mixergy/)

**Tests:** ![Test and Release](https://github.com/AlanSRU/ioBroker.mixergy/workflows/Test%20and%20Release/badge.svg)

## Mixergy adapter for ioBroker

Monitors and controls [Mixergy](https://www.mixergy.co.uk/) smart hot water tanks. Every tank on
your Mixergy account appears as a device. Control goes through the Mixergy cloud. An optional
local connection to the tank's on-board controller adds sub-second temperatures, mains voltage,
current and grid frequency.

Mixergy publishes no developer API. This adapter uses the same unofficial cloud API as the
community Home Assistant and Homebridge integrations, so Mixergy may change it without notice.

Requires Node.js 22 or newer.

## Configuration

| Setting | Notes |
|---|---|
| Account email / Password | Your Mixergy app login. The password is stored encrypted. |
| Poll interval | 30 to 300 seconds, default 60. |
| Read the tank's local controller | Optional. Enter the controller's IP address. |
| Tank serial number | Only needed for the local controller when the account has several tanks, or when no account is entered. |

## States

Under `mixergy.0.<SERIAL>`:

- `info`: serial number, model, firmware, PV diverter, time of the latest measurement, and `stale` when that measurement is old.
- `measurement`: charge, top and bottom temperature, heat source and heating flags, immersion power, PV and CT clamp power, and `energy`.
- `control`: `targetCharge`, `boost` (charge to 100 %), and `targetTemperature`.
- `settings`: cleansing temperature, grid assistance (DSR), frost protection, distributed computing, and the PV diverter settings.
- `schedule`: default heat source and holiday. To book a holiday, write `holidayStart` and `holidayEnd` as ISO 8601 dates; it is sent once both are valid. `holidayClear` cancels it.
- `local` (only with the local controller): live readings from the tank, commanded and actual relay positions, and `connected`.

`measurement.energy` is a kWh total that the adapter integrates from immersion power, because
the cloud reports power only. It starts at zero when the adapter is installed.

The local `cpRaw`, `dpRaw` and `eRaw` states are passed through unscaled because their units
are not yet known.

## Local network note

The tank's controller answers unauthenticated HTTP on your network. The adapter only reads
`/measurements` and `/status`. Anyone on the same network can also reach the controller's
Wi-Fi setup routes, which can disconnect the tank, so consider putting it on its own VLAN.

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (Alan Paris) initial release

## License
MIT License

Copyright (c) 2026 Alan Paris <alan.paris@scottish.rugby>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.