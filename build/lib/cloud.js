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
var cloud_exports = {};
__export(cloud_exports, {
  API_ROOT: () => API_ROOT,
  MixergyApiError: () => MixergyApiError,
  MixergyAuthError: () => MixergyAuthError,
  MixergyCloud: () => MixergyCloud,
  requireSafeLink: () => requireSafeLink
});
module.exports = __toCommonJS(cloud_exports);
var import_mutex = require("./mutex");
var import_parse = require("./parse");
const API_ROOT = "https://www.mixergy.io/api/v2";
const API_ORIGIN = "https://www.mixergy.io";
const REQUEST_TIMEOUT_MS = 3e4;
const TOKEN_REFRESH_BUFFER_MS = 5 * 6e4;
const DEFAULT_TOKEN_TTL_S = 3600;
class MixergyApiError extends Error {
  /**
   * @param message - error text
   * @param status - HTTP status, when there was a response
   */
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "MixergyApiError";
  }
}
class MixergyAuthError extends MixergyApiError {
  /**
   * @param message - error text
   * @param status - HTTP status, when there was a response
   */
  constructor(message, status) {
    super(message, status);
    this.name = "MixergyAuthError";
  }
}
function requireSafeLink(href, name) {
  if (typeof href !== "string" || href === "") {
    throw new MixergyApiError(`Missing "${name}" link in API response`);
  }
  let url;
  try {
    url = new URL(href);
  } catch {
    throw new MixergyApiError(`Invalid "${name}" link in API response`);
  }
  if (url.protocol !== "https:" || url.origin !== API_ORIGIN || url.username || url.password) {
    throw new MixergyApiError(`Refusing "${name}" link outside ${API_ORIGIN}: ${url.origin}`);
  }
  return url.toString();
}
function linkOf(body, name) {
  var _a, _b, _c;
  const href = (_c = (0, import_parse.asObject)((_b = (0, import_parse.asObject)((_a = (0, import_parse.asObject)(body)) == null ? void 0 : _a._links)) == null ? void 0 : _b[name])) == null ? void 0 : _c.href;
  return requireSafeLink(href, name);
}
class MixergyCloud {
  /** @param options - account credentials and test hooks */
  constructor(options) {
    this.options = options;
    var _a, _b;
    this.fetchImpl = (_a = options.fetch) != null ? _a : fetch;
    this.now = (_b = options.now) != null ? _b : Date.now;
  }
  fetchImpl;
  now;
  token = null;
  tokenExpiry = 0;
  loginUrl = null;
  tanks = null;
  details = /* @__PURE__ */ new Map();
  authLock = new import_mutex.Mutex();
  discoveryLock = new import_mutex.Mutex();
  scheduleLock = new import_mutex.Mutex();
  /** Lists the tanks on the account. Cached until a stale link forces re-discovery. */
  async listTanks() {
    return this.discoveryLock.run(async () => {
      var _a, _b, _c, _d;
      if (this.tanks) {
        return this.tanks;
      }
      const root = await this.request("GET", API_ROOT);
      const list = await this.request("GET", linkOf(root, "tanks"));
      const entries = (_b = (0, import_parse.asObject)((_a = (0, import_parse.asObject)(list)) == null ? void 0 : _a._embedded)) == null ? void 0 : _b.tankList;
      if (!Array.isArray(entries)) {
        throw new MixergyApiError("Tank list missing from API response");
      }
      const tanks = [];
      for (const entry of entries) {
        const serial = (_c = (0, import_parse.asObject)(entry)) == null ? void 0 : _c.serialNumber;
        if (typeof serial !== "string" || serial === "") {
          continue;
        }
        const firmware = (_d = (0, import_parse.asObject)(entry)) == null ? void 0 : _d.firmwareVersion;
        tanks.push({
          serial: serial.toUpperCase(),
          firmwareVersion: typeof firmware === "string" ? firmware : "",
          selfUrl: linkOf(entry, "self")
        });
      }
      this.tanks = tanks;
      return tanks;
    });
  }
  /**
   * Static details and endpoints for a tank. Cached until a stale link forces re-discovery.
   *
   * @param serial - tank serial number
   */
  async getDetail(serial) {
    var _a, _b;
    const cached = this.details.get(serial);
    if (cached) {
      return cached;
    }
    const tank = (await this.listTanks()).find((t) => t.serial === serial);
    if (!tank) {
      throw new MixergyApiError(`Tank ${serial} is not on this account`);
    }
    const body = await this.request("GET", tank.selfUrl);
    const model = (_a = (0, import_parse.asObject)(body)) == null ? void 0 : _a.tankModelCode;
    const detail = {
      modelCode: typeof model === "string" ? model : "",
      hasPvDiverter: (0, import_parse.hasPvDiverter)((_b = (0, import_parse.asObject)(body)) == null ? void 0 : _b.configuration),
      measurementUrl: linkOf(body, "latest_measurement"),
      controlUrl: linkOf(body, "control"),
      settingsUrl: linkOf(body, "settings"),
      scheduleUrl: linkOf(body, "schedule")
    };
    this.details.set(serial, detail);
    return detail;
  }
  /** @param serial - tank serial number */
  async getMeasurement(serial) {
    return this.request("GET", (await this.getDetail(serial)).measurementUrl);
  }
  /** @param serial - tank serial number */
  async getSettings(serial) {
    return this.request("GET", (await this.getDetail(serial)).settingsUrl);
  }
  /** @param serial - tank serial number */
  async getSchedule(serial) {
    return this.request("GET", (await this.getDetail(serial)).scheduleUrl);
  }
  /**
   * @param serial - tank serial number
   * @param charge - target charge, % (caller clamps)
   */
  async setTargetCharge(serial, charge) {
    await this.request("PUT", (await this.getDetail(serial)).controlUrl, { charge });
  }
  /**
   * @param serial - tank serial number
   * @param patch - settings fields to change (caller clamps)
   */
  async putSettings(serial, patch) {
    await this.request("PUT", (await this.getDetail(serial)).settingsUrl, patch);
  }
  /**
   * Read-modify-write of the whole schedule document. The API has no field-level update, so
   * writes are serialised to stop two near-simultaneous changes overwriting each other.
   *
   * @param serial - tank serial number
   * @param mutate - changes the fetched document in place
   */
  async mutateSchedule(serial, mutate) {
    await this.scheduleLock.run(async () => {
      const url = (await this.getDetail(serial)).scheduleUrl;
      const current = (0, import_parse.asObject)(await this.request("GET", url));
      if (!current) {
        throw new MixergyApiError("Schedule missing from API response");
      }
      const next = structuredClone(current);
      mutate(next);
      await this.request("PUT", url, next);
    });
  }
  /** Forgets every discovered link, so the next call walks the API again. */
  clearDiscovery() {
    this.loginUrl = null;
    this.tanks = null;
    this.details.clear();
  }
  async ensureToken() {
    return this.authLock.run(async () => {
      if (this.token && this.now() < this.tokenExpiry - TOKEN_REFRESH_BUFFER_MS) {
        return this.token;
      }
      this.token = null;
      if (!this.loginUrl) {
        const root = await this.request("GET", API_ROOT, void 0, false);
        const account = await this.request("GET", linkOf(root, "account"), void 0, false);
        this.loginUrl = linkOf(account, "login");
      }
      const body = (0, import_parse.asObject)(
        await this.request(
          "POST",
          this.loginUrl,
          { username: this.options.username, password: this.options.password },
          false
        )
      );
      const token = body == null ? void 0 : body.token;
      if (typeof token !== "string" || token === "") {
        throw new MixergyAuthError("Login response contained no token");
      }
      const ttl = typeof (body == null ? void 0 : body.ttl) === "number" && Number.isFinite(body.ttl) && body.ttl > 0 ? body.ttl : DEFAULT_TOKEN_TTL_S;
      this.token = token;
      this.tokenExpiry = this.now() + Math.max(ttl * 1e3, TOKEN_REFRESH_BUFFER_MS * 2);
      return token;
    });
  }
  async request(method, url, body, auth = true, retried = false) {
    const headers = { Accept: "application/json" };
    if (body !== void 0) {
      headers["Content-Type"] = "application/json";
    }
    if (auth) {
      headers.Authorization = `Bearer ${await this.ensureToken()}`;
    }
    let status;
    let text;
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: body === void 0 ? void 0 : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      throw new MixergyApiError(`${method} ${new URL(url).pathname} failed: ${err.message}`);
    }
    if (status === 401 || status === 403) {
      if (auth && status === 401 && !retried) {
        this.token = null;
        return this.request(method, url, body, auth, true);
      }
      this.token = null;
      throw new MixergyAuthError(`Mixergy rejected the credentials (HTTP ${status})`, status);
    }
    if (status === 404 || status === 410 || status >= 300 && status < 400) {
      this.clearDiscovery();
      throw new MixergyApiError(`${method} ${new URL(url).pathname} returned HTTP ${status}`, status);
    }
    if (status < 200 || status >= 300) {
      throw new MixergyApiError(`${method} ${new URL(url).pathname} returned HTTP ${status}`, status);
    }
    if (text.trim() === "") {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new MixergyApiError(`${method} ${new URL(url).pathname} returned invalid JSON`, status);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  API_ROOT,
  MixergyApiError,
  MixergyAuthError,
  MixergyCloud,
  requireSafeLink
});
//# sourceMappingURL=cloud.js.map
