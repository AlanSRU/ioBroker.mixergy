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
var objects_exports = {};
__export(objects_exports, {
  CHANNELS: () => CHANNELS,
  COMMAND_STATES: () => COMMAND_STATES,
  LOCAL_CHANNEL: () => LOCAL_CHANNEL,
  LOCAL_STATES: () => LOCAL_STATES,
  READ_STATES: () => READ_STATES,
  SETTINGS: () => SETTINGS,
  tankId: () => tankId
});
module.exports = __toCommonJS(objects_exports);
function tankId(serial) {
  return serial.replace(/[^A-Za-z0-9_-]/g, "_");
}
const CHANNELS = {
  info: "Tank information",
  measurement: "Measurements",
  control: "Control",
  settings: "Settings",
  schedule: "Schedule and holiday"
};
const LOCAL_CHANNEL = { id: "local", name: "Local controller (LAN)" };
function ro(name, type, role, extra = {}) {
  const def = type === "string" ? "" : type === "boolean" ? false : void 0;
  return { name, type, role, read: true, write: false, ...def === void 0 ? {} : { def }, ...extra };
}
const READ_STATES = {
  "info.serialNumber": ro("Serial number", "string", "info.serial"),
  "info.modelCode": ro("Model code", "string", "info.model"),
  "info.firmwareVersion": ro("Firmware version", "string", "info.firmware"),
  "info.hasPvDiverter": ro("PV diverter fitted", "boolean", "indicator"),
  "info.recordedTime": ro("Time the tank recorded the latest measurement", "number", "date"),
  "info.stale": ro("Latest measurement is out of date", "boolean", "indicator"),
  "measurement.charge": ro("State of charge", "number", "value.fill", { unit: "%", min: 0, max: 100 }),
  "measurement.topTemperature": ro("Top (hot water) temperature", "number", "value.temperature", { unit: "\xB0C" }),
  "measurement.bottomTemperature": ro("Bottom (coldest water) temperature", "number", "value.temperature", {
    unit: "\xB0C"
  }),
  "measurement.heatSource": ro("Active heat source", "string", "text", {
    states: { electric: "Electric", indirect: "Indirect", heatpump: "Heat pump" }
  }),
  "measurement.heating": ro("Heating", "boolean", "indicator.working"),
  "measurement.electricHeat": ro("Heating with the electric immersion", "boolean", "indicator"),
  "measurement.indirectHeat": ro("Heating indirectly (boiler)", "boolean", "indicator"),
  "measurement.heatPumpHeat": ro("Heating with the heat pump", "boolean", "indicator"),
  "measurement.power": ro("Immersion power", "number", "value.power", { unit: "W" }),
  "measurement.energy": ro("Immersion energy (counted by the adapter)", "number", "value.energy.consumed", {
    unit: "kWh",
    def: 0
  }),
  "measurement.pvPower": ro("PV diverter power", "number", "value.power", { unit: "W" }),
  "measurement.clampPower": ro("CT clamp power", "number", "value.power", { unit: "W" }),
  "schedule.holidayMode": ro("Holiday mode active", "boolean", "indicator")
};
function setting(key, common) {
  return { key, min: common.min, max: common.max, common: { ...common, read: true, write: true } };
}
const SETTINGS = {
  "control.targetTemperature": setting("max_temp", {
    name: "Target temperature",
    type: "number",
    role: "level.temperature",
    unit: "\xB0C",
    min: 45,
    max: 70
  }),
  "settings.cleansingTemperature": setting("cleansing_temperature", {
    name: "Cleansing (anti-legionella) temperature",
    type: "number",
    role: "level.setting.temperature",
    unit: "\xB0C",
    min: 51,
    max: 55
  }),
  "settings.dsrEnabled": setting("dsr_enabled", {
    name: "Grid assistance (DSR)",
    type: "boolean",
    role: "switch.enable",
    def: false
  }),
  "settings.frostProtection": setting("frost_protection_enabled", {
    name: "Frost protection",
    type: "boolean",
    role: "switch.enable",
    def: false
  }),
  "settings.distributedComputing": setting("distributed_computing_enabled", {
    name: "Distributed computing",
    type: "boolean",
    role: "switch.enable",
    def: false
  }),
  "settings.divertExported": setting("divert_exported_enabled", {
    name: "Divert exported PV power",
    type: "boolean",
    role: "switch.enable",
    def: false
  }),
  "settings.pvCutInThreshold": setting("pv_cut_in_threshold", {
    name: "PV cut-in threshold",
    type: "number",
    role: "level.setting",
    unit: "W",
    min: 0,
    max: 500
  }),
  "settings.pvChargeLimit": setting("pv_charge_limit", {
    name: "PV charge limit",
    type: "number",
    role: "level.setting",
    unit: "%",
    min: 0,
    max: 100
  }),
  "settings.pvTargetCurrent": setting("pv_target_current", {
    name: "PV target current",
    type: "number",
    role: "level.setting",
    min: -1,
    max: 0,
    step: 0.1
  }),
  "settings.pvOverTemperature": setting("pv_over_temperature", {
    name: "PV over-temperature limit",
    type: "number",
    role: "level.setting.temperature",
    unit: "\xB0C",
    min: 45,
    max: 60
  })
};
const COMMAND_STATES = {
  "control.targetCharge": {
    name: "Target charge",
    type: "number",
    role: "level",
    unit: "%",
    min: 0,
    max: 100,
    read: true,
    write: true
  },
  "control.boost": {
    name: "Boost (charge to 100 %)",
    type: "boolean",
    role: "button",
    read: false,
    write: true
  },
  "schedule.defaultHeatSource": {
    name: "Default heat source",
    type: "string",
    role: "text",
    states: { electric: "Electric", indirect: "Indirect", heatpump: "Heat pump" },
    read: true,
    write: true,
    def: ""
  },
  "schedule.holidayStart": {
    name: "Holiday start (ISO 8601)",
    type: "string",
    role: "date.start",
    read: true,
    write: true,
    def: ""
  },
  "schedule.holidayEnd": {
    name: "Holiday end (ISO 8601)",
    type: "string",
    role: "date.end",
    read: true,
    write: true,
    def: ""
  },
  "schedule.holidayClear": {
    name: "Cancel holiday",
    type: "boolean",
    role: "button",
    read: false,
    write: true
  }
};
const LOCAL_STATES = {
  connected: ro("Local controller reachable", "boolean", "indicator.reachable"),
  charge: ro("State of charge", "number", "value.fill", { unit: "%", min: 0, max: 100 }),
  topTemperature: ro("Top temperature", "number", "value.temperature", { unit: "\xB0C" }),
  flowTemperature: ro("Flow temperature", "number", "value.temperature", { unit: "\xB0C" }),
  bottomTemperature: ro("Bottom temperature", "number", "value.temperature", { unit: "\xB0C" }),
  ambientTemperature: ro("Ambient temperature", "number", "value.temperature", { unit: "\xB0C" }),
  voltage: ro("Mains voltage", "number", "value.voltage", { unit: "V" }),
  current: ro("Tank current", "number", "value.current", { unit: "A" }),
  frequency: ro("Grid frequency", "number", "value.frequency", { unit: "Hz" }),
  heating: ro("Heating", "boolean", "indicator.working"),
  immersionRelay: ro("Direct (immersion) relay", "boolean", "indicator"),
  indirectRelay: ro("Indirect relay", "boolean", "indicator"),
  pumpRelay: ro("Pump output", "boolean", "indicator"),
  cpRaw: ro('Raw "cp" reading (units unknown)', "number", "value"),
  dpRaw: ro('Raw "dp" reading (units unknown)', "number", "value"),
  eRaw: ro('Raw "e" reading (meaning unknown)', "number", "value"),
  heatSource: ro("Effective heat source", "string", "text"),
  heatSourceCommanded: ro("Commanded heat source", "string", "text"),
  heatSourceActual: ro("Heat source relay position", "string", "text"),
  immersionCommanded: ro("Immersion commanded on", "boolean", "indicator"),
  immersionActual: ro("Immersion relay on", "boolean", "indicator"),
  systemOn: ro("System on", "boolean", "indicator")
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHANNELS,
  COMMAND_STATES,
  LOCAL_CHANNEL,
  LOCAL_STATES,
  READ_STATES,
  SETTINGS,
  tankId
});
//# sourceMappingURL=objects.js.map
