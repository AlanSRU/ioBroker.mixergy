"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var parse_exports = {};
__export(parse_exports, {
  LineSplitter: () => LineSplitter,
  asObject: () => asObject,
  hasPvDiverter: () => hasPvDiverter,
  normaliseText: () => normaliseText,
  parseCloudMeasurement: () => parseCloudMeasurement,
  parseLocalLine: () => parseLocalLine,
  parseLocalStatus: () => parseLocalStatus,
  parseNested: () => parseNested,
  parseSchedule: () => parseSchedule,
  toBoolean: () => toBoolean,
  toClampedNumber: () => toClampedNumber,
  toNumber: () => toNumber
});
module.exports = __toCommonJS(parse_exports);
const MAX_IMMERSION_POWER_W = 1e4;
function toNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function toClampedNumber(value, min, max) {
  const n = toNumber(value);
  return n === null ? null : Math.min(max, Math.max(min, n));
}
function toBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}
function asObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function normaliseText(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const lower = value.trim().toLowerCase();
  return lower === "heat_pump" ? "heatpump" : lower;
}
function parseNested(value) {
  if (typeof value === "string") {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return asObject(value);
}
function toEpochMs(value) {
  const n = toNumber(value);
  return n !== null && n > 0 ? n : null;
}
function parseCloudMeasurement(raw) {
  var _a, _b;
  const data = (_a = asObject(raw)) != null ? _a : {};
  const current = asObject((_b = parseNested(data.state)) == null ? void 0 : _b.current);
  const heatSource = current ? normaliseText(current.heat_source) : null;
  const immersion = current ? normaliseText(current.immersion) : null;
  const heating = immersion === null ? null : immersion === "on";
  const flag = (source) => heating === null ? null : heating && heatSource === source;
  const electricHeat = flag("electric");
  const clampPower = "clampPower" in data ? toNumber(data.clampPower) : null;
  let power;
  if ("energy" in data) {
    const joules = toNumber(data.energy);
    power = joules !== null && joules >= 0 && joules / 60 <= MAX_IMMERSION_POWER_W ? joules / 60 : null;
  } else if (electricHeat) {
    power = clampPower;
  } else {
    power = heating === null ? null : 0;
  }
  const pvEnergy = "pvEnergy" in data ? toNumber(data.pvEnergy) : null;
  return {
    charge: toNumber(data.charge),
    topTemperature: toNumber(data.topTemperature),
    bottomTemperature: toNumber(data.bottomTemperature),
    targetCharge: current ? toNumber(current.target) : null,
    heatSource,
    heating,
    electricHeat,
    indirectHeat: flag("indirect"),
    heatPumpHeat: flag("heatpump"),
    // `source` only appears when it is "Vacation"
    holidayMode: current ? normaliseText(current.source) === "vacation" : null,
    power,
    pvPower: pvEnergy === null ? null : pvEnergy / 60,
    clampPower,
    recordedTime: toEpochMs(data.recordedTime),
    receivedTime: toEpochMs(data.receivedTime)
  };
}
function parseSchedule(raw) {
  var _a;
  const data = (_a = asObject(raw)) != null ? _a : {};
  const holiday = asObject(data.holiday);
  const iso = (value) => {
    const ms = toEpochMs(value);
    return ms === null ? "" : new Date(ms).toISOString();
  };
  return {
    defaultHeatSource: normaliseText(data.defaultHeatSource),
    holidayStart: holiday ? iso(holiday.departDate) : "",
    holidayEnd: holiday ? iso(holiday.returnDate) : ""
  };
}
function hasPvDiverter(configuration) {
  var _a;
  const type = (_a = parseNested(configuration)) == null ? void 0 : _a.mixergyPvType;
  return typeof type === "string" && type !== "NO_INVERTER";
}
function parseLocalLine(line) {
  if (line.trim() === "") {
    return null;
  }
  let data;
  try {
    data = asObject(JSON.parse(line));
  } catch {
    return null;
  }
  if (!data) {
    return null;
  }
  if ("cp" in data) {
    return { kind: "fast", cp: toNumber(data.cp), dp: toNumber(data.dp), e: toNumber(data.e), f: toNumber(data.f) };
  }
  if ("soc" in data) {
    return {
      kind: "slow",
      soc: toNumber(data.soc),
      tt: toNumber(data.tt),
      ft: toNumber(data.ft),
      bt: toNumber(data.bt),
      op: toBoolean(data.op),
      v: toNumber(data.v),
      i: toNumber(data.i),
      ats: toNumber(data.ats)
    };
  }
  if ("dro" in data) {
    return { kind: "relay", dro: toBoolean(data.dro), iro: toBoolean(data.iro), po: toBoolean(data.po) };
  }
  return null;
}
class LineSplitter {
  /**
   * @param maxBuffer - discard a partial line longer than this, so a stream without
   *                    newlines cannot grow memory without bound
   */
  constructor(maxBuffer = 65536) {
    this.maxBuffer = maxBuffer;
  }
  buffer = "";
  /**
   * Adds a chunk and returns every line it completed.
   *
   * @param chunk - decoded text chunk
   */
  push(chunk) {
    var _a;
    const parts = (this.buffer + chunk).split("\n");
    this.buffer = (_a = parts.pop()) != null ? _a : "";
    if (this.buffer.length > this.maxBuffer) {
      this.buffer = "";
    }
    return parts.map((line) => line.replace(/\r$/, ""));
  }
}
function parseLocalStatus(raw) {
  var _a;
  const state = asObject((_a = asObject(raw)) == null ? void 0 : _a.state);
  const current = asObject(state == null ? void 0 : state.current);
  const relay = asObject(state == null ? void 0 : state.relay);
  const onOff = (value) => {
    const text = normaliseText(value);
    return text === "on" ? true : text === "off" ? false : null;
  };
  return {
    heatSource: normaliseText(state == null ? void 0 : state.heat_source),
    heatSourceCommanded: normaliseText(current == null ? void 0 : current.heat_source),
    heatSourceActual: normaliseText(relay == null ? void 0 : relay.heat_source),
    immersionCommanded: onOff(current == null ? void 0 : current.immersion),
    immersionActual: onOff(relay == null ? void 0 : relay.immersion),
    systemOn: onOff(state == null ? void 0 : state.system)
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LineSplitter,
  asObject,
  hasPvDiverter,
  normaliseText,
  parseCloudMeasurement,
  parseLocalLine,
  parseLocalStatus,
  parseNested,
  parseSchedule,
  toBoolean,
  toClampedNumber,
  toNumber
});
//# sourceMappingURL=parse.js.map
