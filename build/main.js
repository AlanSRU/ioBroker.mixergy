"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_cloud = require("./lib/cloud");
var import_local = require("./lib/local");
var import_objects = require("./lib/objects");
var import_parse = require("./lib/parse");
const POLL_MIN_S = 30;
const POLL_MAX_S = 300;
const POLL_DEFAULT_S = 60;
const AUTH_RETRY_MS = 30 * 6e4;
const REPOLL_AFTER_WRITE_MS = 2e3;
const STALE_MIN_MS = 5 * 6e4;
const LOCAL_STATUS_INTERVAL_MS = 1e4;
const LOCAL_RETRY_MIN_MS = 5e3;
const LOCAL_RETRY_MAX_MS = 6e4;
const LOCAL_STABLE_MS = 6e4;
const LOCAL_NUMBER_THROTTLE_MS = 1e3;
const HEAT_SOURCES = ["electric", "indirect", "heatpump"];
class Mixergy extends utils.Adapter {
  cloud = null;
  tanks = /* @__PURE__ */ new Map();
  pollIntervalMs = POLL_DEFAULT_S * 1e3;
  pollTimer;
  polling = false;
  pollAgain = false;
  cloudFailures = 0;
  /** Keys of problems already logged, so a repeating failure warns once. */
  warned = /* @__PURE__ */ new Set();
  /** Set first thing in onUnload, so in-flight work stops before writing or opening resources. */
  unloaded = false;
  localHost = null;
  localTankId = null;
  localStream = null;
  localUp = false;
  localOpenedAt = 0;
  localRetryMs = LOCAL_RETRY_MIN_MS;
  localRetryTimer;
  localStatusTimer;
  localCache = /* @__PURE__ */ new Map();
  constructor(options = {}) {
    super({
      ...options,
      name: "mixergy"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    var _a;
    await this.setState("info.connection", false, true);
    this.pollIntervalMs = ((_a = (0, import_parse.toClampedNumber)(this.config.pollInterval, POLL_MIN_S, POLL_MAX_S)) != null ? _a : POLL_DEFAULT_S) * 1e3;
    const username = this.config.username.trim();
    if (username && this.config.password) {
      this.cloud = new import_cloud.MixergyCloud({ username, password: this.config.password });
    } else {
      this.log.error("Enter your Mixergy account email and password in the instance settings.");
    }
    const localSerial = this.config.localSerial.trim().toUpperCase();
    if (this.config.enableLocal) {
      this.localHost = (0, import_local.parseLocalHost)(this.config.localHost);
      if (!this.localHost) {
        this.log.error(
          `Local controller address "${this.config.localHost}" is not a valid IP address or hostname.`
        );
      } else if (!this.cloud && !localSerial) {
        this.log.error("Without a Mixergy account, enter the tank serial number for the local controller.");
      }
    }
    this.subscribeStates("*.control.*");
    this.subscribeStates("*.settings.*");
    this.subscribeStates("*.schedule.*");
    if (this.localHost && localSerial) {
      await this.startLocal(localSerial);
    }
    if (this.cloud && !this.unloaded) {
      await this.pollCycle();
    }
  }
  // --- object tree -------------------------------------------------------------------------
  async ensureTank(serial) {
    var _a;
    const id = (0, import_objects.tankId)(serial);
    const known = this.tanks.get(id);
    if (known) {
      return known;
    }
    await this.setObjectNotExistsAsync(id, {
      type: "device",
      common: { name: `Mixergy tank ${serial}` },
      native: {}
    });
    for (const [channel, name] of Object.entries(import_objects.CHANNELS)) {
      await this.extendObject(`${id}.${channel}`, { type: "channel", common: { name }, native: {} });
    }
    const states = { ...import_objects.READ_STATES, ...import_objects.COMMAND_STATES };
    for (const [key, def] of Object.entries(import_objects.SETTINGS)) {
      states[key] = def.common;
    }
    for (const [key, common] of Object.entries(states)) {
      await this.extendObject(`${id}.${key}`, { type: "state", common, native: {} });
    }
    const energy = await this.getStateAsync(`${id}.measurement.energy`);
    const tank = { serial, id, energy: (_a = (0, import_parse.toNumber)(energy == null ? void 0 : energy.val)) != null ? _a : 0, lastPower: null, lastSampleAt: null };
    this.tanks.set(id, tank);
    await this.write(`${id}.info.serialNumber`, serial);
    return tank;
  }
  // --- cloud polling -----------------------------------------------------------------------
  async pollCycle() {
    if (!this.cloud || this.unloaded) {
      return;
    }
    this.polling = true;
    this.pollAgain = false;
    let delay = this.pollIntervalMs;
    try {
      const tanks = await this.cloud.listTanks();
      if (tanks.length === 0) {
        this.warnOnce("no-tanks", "No tanks found on this Mixergy account.");
      }
      for (const tank of tanks) {
        if (this.unloaded) {
          return;
        }
        await this.pollTank(tank);
      }
      await this.startLocalFromAccount(tanks);
      await this.cloudSucceeded();
    } catch (err) {
      if (err instanceof import_cloud.MixergyAuthError) {
        delay = Math.max(delay, AUTH_RETRY_MS);
      }
      await this.cloudFailed(err);
    } finally {
      this.polling = false;
    }
    if (this.unloaded) {
      return;
    }
    if (this.pollAgain) {
      delay = Math.min(delay, REPOLL_AFTER_WRITE_MS);
    }
    this.pollTimer = this.setTimeout(() => void this.pollCycle(), delay);
  }
  /** Polls soon, so states converge after a write. */
  requestPoll() {
    if (!this.cloud || this.unloaded) {
      return;
    }
    if (this.polling) {
      this.pollAgain = true;
      return;
    }
    this.clearTimeout(this.pollTimer);
    this.pollTimer = this.setTimeout(() => void this.pollCycle(), REPOLL_AFTER_WRITE_MS);
  }
  async pollTank(entry) {
    var _a, _b;
    const cloud = this.cloud;
    const detail = await cloud.getDetail(entry.serial);
    const tank = await this.ensureTank(entry.serial);
    const id = tank.id;
    await this.write(`${id}.info.firmwareVersion`, entry.firmwareVersion);
    await this.write(`${id}.info.modelCode`, detail.modelCode);
    await this.write(`${id}.info.hasPvDiverter`, detail.hasPvDiverter);
    const m = (0, import_parse.parseCloudMeasurement)(await cloud.getMeasurement(entry.serial));
    const reported = (_a = m.receivedTime) != null ? _a : m.recordedTime;
    const stale = reported !== null && Date.now() - reported > Math.max(STALE_MIN_MS, 3 * this.pollIntervalMs);
    await this.write(`${id}.info.recordedTime`, m.recordedTime);
    await this.write(`${id}.info.stale`, stale);
    await this.write(`${id}.measurement.charge`, m.charge);
    await this.write(`${id}.measurement.topTemperature`, m.topTemperature);
    await this.write(`${id}.measurement.bottomTemperature`, m.bottomTemperature);
    await this.write(`${id}.measurement.heatSource`, (_b = m.heatSource) != null ? _b : "");
    await this.write(`${id}.measurement.heating`, m.heating);
    await this.write(`${id}.measurement.electricHeat`, m.electricHeat);
    await this.write(`${id}.measurement.indirectHeat`, m.indirectHeat);
    await this.write(`${id}.measurement.heatPumpHeat`, m.heatPumpHeat);
    await this.write(`${id}.measurement.power`, m.power);
    await this.write(`${id}.measurement.pvPower`, m.pvPower);
    await this.write(`${id}.measurement.clampPower`, m.clampPower);
    await this.write(`${id}.schedule.holidayMode`, m.holidayMode);
    if (m.targetCharge !== null) {
      await this.write(`${id}.control.targetCharge`, m.targetCharge);
    }
    this.accumulateEnergy(tank, stale ? null : m.power);
    await this.write(`${id}.measurement.energy`, tank.energy);
    try {
      const settings = (0, import_parse.asObject)(await cloud.getSettings(entry.serial));
      if (!settings) {
        throw new Error("empty response");
      }
      for (const [key, def] of Object.entries(import_objects.SETTINGS)) {
        const raw = settings[def.key];
        const val = def.common.type === "boolean" ? (0, import_parse.toBoolean)(raw) : (0, import_parse.toNumber)(raw);
        if (val !== null) {
          await this.write(`${id}.${key}`, val);
        }
      }
      this.clearWarning(`settings-${id}`);
    } catch (err) {
      this.warnOnce(
        `settings-${id}`,
        `Reading settings of tank ${entry.serial} failed: ${err.message}`
      );
    }
    try {
      const schedule = (0, import_parse.parseSchedule)(await cloud.getSchedule(entry.serial));
      if (schedule.defaultHeatSource !== null) {
        await this.write(`${id}.schedule.defaultHeatSource`, schedule.defaultHeatSource);
      }
      await this.writeUnlessPending(`${id}.schedule.holidayStart`, schedule.holidayStart);
      await this.writeUnlessPending(`${id}.schedule.holidayEnd`, schedule.holidayEnd);
      this.clearWarning(`schedule-${id}`);
    } catch (err) {
      this.warnOnce(
        `schedule-${id}`,
        `Reading schedule of tank ${entry.serial} failed: ${err.message}`
      );
    }
  }
  /**
   * Integrates immersion power into kWh using the previous sample (left rectangle). The gap
   * is capped at two poll intervals so an outage never credits a fictitious spike.
   *
   * @param tank - the tank
   * @param power - current power in W, or null when unknown
   */
  accumulateEnergy(tank, power) {
    const now = Date.now();
    if (tank.lastSampleAt !== null && tank.lastPower !== null && tank.lastPower > 0) {
      const elapsedMs = Math.min(Math.max(0, now - tank.lastSampleAt), 2 * this.pollIntervalMs);
      tank.energy = Math.round((tank.energy + tank.lastPower * elapsedMs / 36e8) * 1e4) / 1e4;
    }
    tank.lastPower = power;
    tank.lastSampleAt = now;
  }
  async cloudSucceeded() {
    this.cloudFailures = 0;
    if (this.clearWarning("cloud")) {
      this.log.info("Mixergy cloud reachable again.");
    }
    await this.write("info.connection", true);
    await this.write("info.lastUpdate", Date.now());
  }
  async cloudFailed(err) {
    this.cloudFailures++;
    for (const tank of this.tanks.values()) {
      tank.lastPower = null;
    }
    if (err instanceof import_cloud.MixergyAuthError) {
      if (!this.warned.has("cloud")) {
        this.warned.add("cloud");
        this.log.error(`${err.message}. Check the account email and password in the instance settings.`);
      }
      await this.write("info.connection", false);
      return;
    }
    this.warnOnce("cloud", `Mixergy cloud request failed: ${err.message}`);
    if (this.cloudFailures >= 2) {
      await this.write("info.connection", false);
    }
  }
  // --- writes ------------------------------------------------------------------------------
  async onStateChange(id, state) {
    if (!state || state.ack || this.unloaded) {
      return;
    }
    const rel = id.slice(this.namespace.length + 1);
    const dot = rel.indexOf(".");
    const tank = this.tanks.get(rel.slice(0, dot));
    const key = rel.slice(dot + 1);
    if (!tank) {
      return;
    }
    if (!this.cloud) {
      this.log.warn(`Cannot change ${key}: changes need a Mixergy account in the instance settings.`);
      return;
    }
    let wrote;
    try {
      wrote = await this.handleWrite(tank, key, state.val);
    } catch (err) {
      this.log.warn(`Changing ${key} on tank ${tank.serial} failed: ${err.message}`);
      wrote = true;
    }
    if (wrote) {
      this.requestPoll();
    }
  }
  /**
   * Sends one state change to the cloud.
   *
   * @param tank - the tank
   * @param key - state id relative to the tank
   * @param val - the requested value
   * @returns whether anything was sent
   */
  async handleWrite(tank, key, val) {
    var _a, _b;
    const cloud = this.cloud;
    const setting = import_objects.SETTINGS[key];
    if (setting) {
      const value = setting.common.type === "boolean" ? (0, import_parse.toBoolean)(val) : (0, import_parse.toClampedNumber)(val, (_a = setting.min) != null ? _a : -Infinity, (_b = setting.max) != null ? _b : Infinity);
      if (value === null) {
        throw new Error(`invalid value ${JSON.stringify(val)}`);
      }
      await cloud.putSettings(tank.serial, { [setting.key]: value });
      await this.write(`${tank.id}.${key}`, value);
      return true;
    }
    switch (key) {
      case "control.targetCharge": {
        const charge = (0, import_parse.toClampedNumber)(val, 0, 100);
        if (charge === null) {
          throw new Error(`invalid value ${JSON.stringify(val)}`);
        }
        await cloud.setTargetCharge(tank.serial, charge);
        await this.write(`${tank.id}.${key}`, charge);
        return true;
      }
      case "control.boost":
        if (!val) {
          return false;
        }
        await cloud.setTargetCharge(tank.serial, 100);
        return true;
      case "schedule.defaultHeatSource": {
        const source = (0, import_parse.normaliseText)(val);
        if (source === null || !HEAT_SOURCES.includes(source)) {
          throw new Error(`heat source must be one of ${HEAT_SOURCES.join(", ")}`);
        }
        await cloud.mutateSchedule(tank.serial, (schedule) => {
          schedule.defaultHeatSource = source;
        });
        await this.write(`${tank.id}.${key}`, source);
        return true;
      }
      case "schedule.holidayStart":
      case "schedule.holidayEnd":
        return this.writeHoliday(tank, key, val);
      case "schedule.holidayClear":
        if (!val) {
          return false;
        }
        await cloud.mutateSchedule(tank.serial, (schedule) => {
          delete schedule.holiday;
        });
        return true;
      default:
        return false;
    }
  }
  /**
   * The API takes start and end together, so a holiday is sent once both states hold valid
   * dates. Until then the written state stays unacknowledged and polling leaves it alone.
   *
   * @param tank - the tank
   * @param key - schedule.holidayStart or schedule.holidayEnd
   * @param val - the requested value
   */
  async writeHoliday(tank, key, val) {
    var _a, _b;
    const isStart = key === "schedule.holidayStart";
    const other = await this.getStateAsync(`${tank.id}.schedule.${isStart ? "holidayEnd" : "holidayStart"}`);
    const start = Date.parse(String((_a = isStart ? val : other == null ? void 0 : other.val) != null ? _a : ""));
    const end = Date.parse(String((_b = isStart ? other == null ? void 0 : other.val : val) != null ? _b : ""));
    if (Number.isNaN(start) || Number.isNaN(end)) {
      this.log.info(`Holiday for tank ${tank.serial} is sent once both start and end hold valid dates.`);
      return false;
    }
    if (end <= start) {
      throw new Error("holiday end must be after its start");
    }
    await this.cloud.mutateSchedule(tank.serial, (schedule) => {
      schedule.holiday = { departDate: start, returnDate: end };
    });
    await this.write(`${tank.id}.schedule.holidayStart`, new Date(start).toISOString());
    await this.write(`${tank.id}.schedule.holidayEnd`, new Date(end).toISOString());
    return true;
  }
  // --- local controller --------------------------------------------------------------------
  async startLocalFromAccount(tanks) {
    if (!this.localHost || this.localTankId) {
      return;
    }
    if (tanks.length === 1) {
      await this.startLocal(tanks[0].serial);
    } else if (tanks.length > 1) {
      this.warnOnce(
        "local-serial",
        "Several tanks are on this Mixergy account: enter the serial number of the tank the local controller belongs to."
      );
    }
  }
  async startLocal(serial) {
    if (!this.localHost || this.localTankId || this.unloaded) {
      return;
    }
    const tank = await this.ensureTank(serial);
    await this.extendObject(`${tank.id}.${import_objects.LOCAL_CHANNEL.id}`, {
      type: "channel",
      common: { name: import_objects.LOCAL_CHANNEL.name },
      native: {}
    });
    for (const [key, common] of Object.entries(import_objects.LOCAL_STATES)) {
      await this.extendObject(`${tank.id}.${import_objects.LOCAL_CHANNEL.id}.${key}`, { type: "state", common, native: {} });
    }
    if (this.unloaded) {
      return;
    }
    this.localTankId = tank.id;
    this.log.info(`Reading tank ${serial} from the local controller at ${this.localHost}.`);
    this.connectLocal();
    void this.pollLocalStatus();
  }
  connectLocal() {
    if (this.unloaded || !this.localHost) {
      return;
    }
    this.localOpenedAt = Date.now();
    this.localStream = new import_local.LocalStream(this.localHost, {
      onMessage: (message) => this.onLocalMessage(message),
      onClose: (reason) => this.onLocalClose(reason)
    });
    this.localStream.start();
  }
  onLocalMessage(m) {
    if (!this.localUp) {
      this.localUp = true;
      this.writeLocal("connected", true);
      if (this.clearWarning("local")) {
        this.log.info("Local controller reachable again.");
      }
    }
    switch (m.kind) {
      case "fast":
        this.writeLocal("frequency", m.f);
        this.writeLocal("cpRaw", m.cp);
        this.writeLocal("dpRaw", m.dp);
        this.writeLocal("eRaw", m.e);
        break;
      case "slow":
        this.writeLocal("charge", m.soc);
        this.writeLocal("topTemperature", m.tt);
        this.writeLocal("flowTemperature", m.ft);
        this.writeLocal("bottomTemperature", m.bt);
        this.writeLocal("ambientTemperature", m.ats);
        this.writeLocal("voltage", m.v);
        this.writeLocal("current", m.i);
        this.writeLocal("heating", m.op);
        break;
      case "relay":
        this.writeLocal("immersionRelay", m.dro);
        this.writeLocal("indirectRelay", m.iro);
        this.writeLocal("pumpRelay", m.po);
        break;
    }
  }
  onLocalClose(reason) {
    this.localStream = null;
    if (this.unloaded) {
      return;
    }
    if (this.localUp) {
      this.localUp = false;
      this.writeLocal("connected", false);
    }
    if (Date.now() - this.localOpenedAt >= LOCAL_STABLE_MS) {
      this.localRetryMs = LOCAL_RETRY_MIN_MS;
    }
    this.warnOnce("local", `Local controller at ${this.localHost} unavailable (${reason}), retrying.`);
    this.localRetryTimer = this.setTimeout(() => this.connectLocal(), this.localRetryMs);
    this.localRetryMs = Math.min(this.localRetryMs * 2, LOCAL_RETRY_MAX_MS);
  }
  async pollLocalStatus() {
    if (this.unloaded || !this.localHost) {
      return;
    }
    try {
      const s = await (0, import_local.fetchLocalStatus)(this.localHost);
      this.writeLocal("heatSource", s.heatSource);
      this.writeLocal("heatSourceCommanded", s.heatSourceCommanded);
      this.writeLocal("heatSourceActual", s.heatSourceActual);
      this.writeLocal("immersionCommanded", s.immersionCommanded);
      this.writeLocal("immersionActual", s.immersionActual);
      this.writeLocal("systemOn", s.systemOn);
    } catch (err) {
      this.log.debug(`Local controller status request failed: ${err.message}`);
    }
    if (!this.unloaded) {
      this.localStatusTimer = this.setTimeout(() => void this.pollLocalStatus(), LOCAL_STATUS_INTERVAL_MS);
    }
  }
  /**
   * Writes a local state when it changed. Numbers change on nearly every 100 ms message, so
   * each is written at most once per second.
   *
   * @param key - state id under the local channel
   * @param val - the value; null (not reported) is skipped
   */
  writeLocal(key, val) {
    if (val === null || this.unloaded || !this.localTankId) {
      return;
    }
    const id = `${this.localTankId}.${import_objects.LOCAL_CHANNEL.id}.${key}`;
    const now = Date.now();
    const last = this.localCache.get(id);
    if (last && (last.val === val || typeof val === "number" && now - last.ts < LOCAL_NUMBER_THROTTLE_MS)) {
      return;
    }
    this.localCache.set(id, { val, ts: now });
    this.setState(id, val, true).catch((err) => this.log.debug(`Writing ${id} failed: ${err.message}`));
  }
  // --- helpers -----------------------------------------------------------------------------
  async write(id, val) {
    if (!this.unloaded) {
      await this.setStateChangedAsync(id, val, true);
    }
  }
  /**
   * Writes unless the user has a change waiting (ack false), e.g. half of a holiday.
   *
   * @param id - state id
   * @param val - the value
   */
  async writeUnlessPending(id, val) {
    const current = await this.getStateAsync(id);
    if (current && !current.ack) {
      return;
    }
    await this.write(id, val);
  }
  warnOnce(key, message) {
    if (this.warned.has(key)) {
      this.log.debug(message);
    } else {
      this.warned.add(key);
      this.log.warn(message);
    }
  }
  /**
   * @param key - warning key
   * @returns whether a warning had been logged for this key
   */
  clearWarning(key) {
    return this.warned.delete(key);
  }
  onUnload(callback) {
    var _a;
    this.unloaded = true;
    try {
      (_a = this.localStream) == null ? void 0 : _a.stop();
      this.localStream = null;
      this.clearTimeout(this.pollTimer);
      this.clearTimeout(this.localRetryTimer);
      this.clearTimeout(this.localStatusTimer);
      callback();
    } catch {
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Mixergy(options);
} else {
  (() => new Mixergy())();
}
//# sourceMappingURL=main.js.map
