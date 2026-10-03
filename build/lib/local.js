"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var local_exports = {};
__export(local_exports, {
  LocalStream: () => LocalStream,
  fetchLocalStatus: () => fetchLocalStatus,
  parseLocalHost: () => parseLocalHost
});
module.exports = __toCommonJS(local_exports);
var http = __toESM(require("node:http"));
var import_parse = require("./parse");
const STATUS_TIMEOUT_MS = 5e3;
const HOST_PATTERN = /^[a-zA-Z0-9.-]+(?::\d{1,5})?$/;
function parseLocalHost(value) {
  const host = value.trim();
  return HOST_PATTERN.test(host) ? host : null;
}
async function fetchLocalStatus(host) {
  const res = await fetch(`http://${host}/status`, {
    redirect: "error",
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return (0, import_parse.parseLocalStatus)(await res.json());
}
class LocalStream {
  /**
   * @param host - validated host[:port]
   * @param handlers - event callbacks
   * @param stallMs - idle time before the connection is dropped
   */
  constructor(host, handlers, stallMs = 5e3) {
    this.host = host;
    this.handlers = handlers;
    this.stallMs = stallMs;
  }
  request = null;
  finished = false;
  /** Opens the connection. */
  start() {
    const [hostname, port] = this.host.split(":");
    const splitter = new import_parse.LineSplitter();
    const req = http.get({ hostname, port: port ? Number(port) : 80, path: "/measurements" }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        req.destroy(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        for (const line of splitter.push(chunk)) {
          const message = (0, import_parse.parseLocalLine)(line);
          if (message) {
            this.handlers.onMessage(message);
          }
        }
      });
      res.on("end", () => this.finish("stream ended"));
      res.on("error", (err) => this.finish(err.message));
    });
    req.setTimeout(this.stallMs, () => req.destroy(new Error(`no data for ${this.stallMs / 1e3} s`)));
    req.on("error", (err) => this.finish(err.message));
    req.on("close", () => this.finish("connection closed"));
    this.request = req;
  }
  /** Closes the connection without reporting it to `onClose`. */
  stop() {
    var _a;
    this.finished = true;
    (_a = this.request) == null ? void 0 : _a.destroy();
    this.request = null;
  }
  finish(reason) {
    var _a;
    if (this.finished) {
      return;
    }
    this.finished = true;
    (_a = this.request) == null ? void 0 : _a.destroy();
    this.request = null;
    this.handlers.onClose(reason);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LocalStream,
  fetchLocalStatus,
  parseLocalHost
});
//# sourceMappingURL=local.js.map
