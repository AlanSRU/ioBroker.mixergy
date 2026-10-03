/**
 * Pure parsers for Mixergy cloud and local payloads. No adapter or network dependencies.
 *
 * Every converter returns `null` for missing or malformed input rather than manufacturing
 * a zero, so "not reported" never becomes a plausible-looking reading.
 */

type Json = Record<string, unknown>;

/** Readings above this are rejected as implausible for a domestic immersion element. */
const MAX_IMMERSION_POWER_W = 10_000;

/**
 * Strict number conversion: finite numbers and numeric strings only.
 *
 * @param value - raw payload value
 */
export function toNumber(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/**
 * Strict number conversion clamped to a range.
 *
 * @param value - raw value
 * @param min - lower bound
 * @param max - upper bound
 */
export function toClampedNumber(value: unknown, min: number, max: number): number | null {
    const n = toNumber(value);
    return n === null ? null : Math.min(max, Math.max(min, n));
}

/**
 * Strict boolean conversion: real booleans and the strings "true"/"false" only.
 *
 * @param value - raw payload value
 */
export function toBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
        return value;
    }
    if (value === 'true') {
        return true;
    }
    if (value === 'false') {
        return false;
    }
    return null;
}

/**
 * Returns the value as a plain object, or null.
 *
 * @param value - raw payload value
 */
export function asObject(value: unknown): Json | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

/**
 * Lower-cases a text value so cloud ("indirect") and local ("Indirect") agree.
 * The API spells heat pump "heatpump"; "heat_pump" is accepted and folded onto it.
 *
 * @param value - raw payload value
 */
export function normaliseText(value: unknown): string | null {
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    const lower = value.trim().toLowerCase();
    return lower === 'heat_pump' ? 'heatpump' : lower;
}

/**
 * Parses a field that may be a JSON object or a JSON-encoded string of one.
 * The cloud returns `state` and `configuration` as strings on some firmware, objects on others.
 *
 * @param value - raw payload value
 */
export function parseNested(value: unknown): Json | null {
    if (typeof value === 'string') {
        try {
            return asObject(JSON.parse(value));
        } catch {
            return null;
        }
    }
    return asObject(value);
}

/**
 * Converts epoch milliseconds to a timestamp, rejecting non-positive values.
 *
 * @param value - raw payload value
 */
function toEpochMs(value: unknown): number | null {
    const n = toNumber(value);
    return n !== null && n > 0 ? n : null;
}

/** Normalised cloud `latest_measurement`. */
export interface CloudMeasurement {
    /** State of charge, %. */
    charge: number | null;
    /** Top temperature, °C. */
    topTemperature: number | null;
    /** Bottom temperature, °C. */
    bottomTemperature: number | null;
    /** Target charge, %. */
    targetCharge: number | null;
    /** Active heat source, lower case. */
    heatSource: string | null;
    /** Whether the tank is heating. */
    heating: boolean | null;
    /** Heating with the electric immersion. */
    electricHeat: boolean | null;
    /** Heating indirectly. */
    indirectHeat: boolean | null;
    /** Heating with the heat pump. */
    heatPumpHeat: boolean | null;
    /** Holiday (vacation) mode active. */
    holidayMode: boolean | null;
    /** Immersion element power, W. */
    power: number | null;
    /** PV diverter power, W. */
    pvPower: number | null;
    /** CT clamp power, W. */
    clampPower: number | null;
    /** When the tank recorded it, epoch ms. */
    recordedTime: number | null;
    /** When the cloud received it, epoch ms. */
    receivedTime: number | null;
}

/**
 * Parses the cloud `latest_measurement` payload.
 *
 * Power and PV figures follow the community integrations' joules-per-minute reading of
 * `energy` and `pvEnergy` (W = J / 60). Unverified against a real tank (SCOPE.md §2).
 *
 * @param raw - decoded response body
 */
export function parseCloudMeasurement(raw: unknown): CloudMeasurement {
    const data = asObject(raw) ?? {};
    const current = asObject(parseNested(data.state)?.current);

    const heatSource = current ? normaliseText(current.heat_source) : null;
    const immersion = current ? normaliseText(current.immersion) : null;
    const heating = immersion === null ? null : immersion === 'on';
    const flag = (source: string): boolean | null => (heating === null ? null : heating && heatSource === source);
    const electricHeat = flag('electric');

    const clampPower = 'clampPower' in data ? toNumber(data.clampPower) : null;

    let power: number | null;
    if ('energy' in data) {
        const joules = toNumber(data.energy);
        power = joules !== null && joules >= 0 && joules / 60 <= MAX_IMMERSION_POWER_W ? joules / 60 : null;
    } else if (electricHeat) {
        power = clampPower;
    } else {
        // The cloud omits `energy` while the element is off
        power = heating === null ? null : 0;
    }

    const pvEnergy = 'pvEnergy' in data ? toNumber(data.pvEnergy) : null;

    return {
        charge: toNumber(data.charge),
        topTemperature: toNumber(data.topTemperature),
        bottomTemperature: toNumber(data.bottomTemperature),
        targetCharge: current ? toNumber(current.target) : null,
        heatSource,
        heating,
        electricHeat,
        indirectHeat: flag('indirect'),
        heatPumpHeat: flag('heatpump'),
        // `source` only appears when it is "Vacation"
        holidayMode: current ? normaliseText(current.source) === 'vacation' : null,
        power,
        pvPower: pvEnergy === null ? null : pvEnergy / 60,
        clampPower,
        recordedTime: toEpochMs(data.recordedTime),
        receivedTime: toEpochMs(data.receivedTime),
    };
}

/** Normalised cloud `schedule`. */
export interface CloudSchedule {
    /** Default heat source, lower case. */
    defaultHeatSource: string | null;
    /** ISO 8601, or '' when no holiday is set. */
    holidayStart: string;
    /** ISO 8601, or '' when no holiday is set. */
    holidayEnd: string;
}

/**
 * Parses the cloud `schedule` payload.
 *
 * @param raw - decoded response body
 */
export function parseSchedule(raw: unknown): CloudSchedule {
    const data = asObject(raw) ?? {};
    const holiday = asObject(data.holiday);
    const iso = (value: unknown): string => {
        const ms = toEpochMs(value);
        return ms === null ? '' : new Date(ms).toISOString();
    };
    return {
        defaultHeatSource: normaliseText(data.defaultHeatSource),
        holidayStart: holiday ? iso(holiday.departDate) : '',
        holidayEnd: holiday ? iso(holiday.returnDate) : '',
    };
}

/**
 * Reads PV diverter presence from the tank detail's `configuration`.
 * Tanks without a `mixergyPvType` have no inverter.
 *
 * @param configuration - the tank detail's `configuration` field
 */
export function hasPvDiverter(configuration: unknown): boolean {
    const type = parseNested(configuration)?.mixergyPvType;
    return typeof type === 'string' && type !== 'NO_INVERTER';
}

/** One message from the local `/measurements` stream. */
export type LocalMessage =
    | { kind: 'fast'; cp: number | null; dp: number | null; e: number | null; f: number | null }
    | {
          kind: 'slow';
          soc: number | null;
          tt: number | null;
          ft: number | null;
          bt: number | null;
          op: boolean | null;
          v: number | null;
          i: number | null;
          ats: number | null;
      }
    | { kind: 'relay'; dro: boolean | null; iro: boolean | null; po: boolean | null };

/**
 * Parses one NDJSON line from the local stream. The three message classes are told apart
 * by which keys are present (SCOPE.md §3.1). Returns null for blank, malformed or unknown lines.
 *
 * @param line - one line, without the trailing newline
 */
export function parseLocalLine(line: string): LocalMessage | null {
    if (line.trim() === '') {
        return null;
    }
    let data: Json | null;
    try {
        data = asObject(JSON.parse(line));
    } catch {
        return null;
    }
    if (!data) {
        return null;
    }
    if ('cp' in data) {
        return { kind: 'fast', cp: toNumber(data.cp), dp: toNumber(data.dp), e: toNumber(data.e), f: toNumber(data.f) };
    }
    if ('soc' in data) {
        return {
            kind: 'slow',
            soc: toNumber(data.soc),
            tt: toNumber(data.tt),
            ft: toNumber(data.ft),
            bt: toNumber(data.bt),
            op: toBoolean(data.op),
            v: toNumber(data.v),
            i: toNumber(data.i),
            ats: toNumber(data.ats),
        };
    }
    if ('dro' in data) {
        return { kind: 'relay', dro: toBoolean(data.dro), iro: toBoolean(data.iro), po: toBoolean(data.po) };
    }
    return null;
}

/** Splits a chunked text stream into complete lines, buffering across chunk boundaries. */
export class LineSplitter {
    private buffer = '';

    /**
     * @param maxBuffer - discard a partial line longer than this, so a stream without
     *                    newlines cannot grow memory without bound
     */
    public constructor(private readonly maxBuffer = 65_536) {}

    /**
     * Adds a chunk and returns every line it completed.
     *
     * @param chunk - decoded text chunk
     */
    public push(chunk: string): string[] {
        const parts = (this.buffer + chunk).split('\n');
        this.buffer = parts.pop() ?? '';
        if (this.buffer.length > this.maxBuffer) {
            this.buffer = '';
        }
        return parts.map(line => line.replace(/\r$/, ''));
    }
}

/** Normalised local `/status`. */
export interface LocalStatus {
    /** Effective heat source. */
    heatSource: string | null;
    /** Commanded heat source. */
    heatSourceCommanded: string | null;
    /** Heat source relay position. */
    heatSourceActual: string | null;
    /** Immersion commanded on. */
    immersionCommanded: boolean | null;
    /** Immersion relay on. */
    immersionActual: boolean | null;
    /** System on. */
    systemOn: boolean | null;
}

/**
 * Parses the local `/status` payload. Values arrive capitalised ("Indirect", "Off") and are
 * normalised to the cloud's lower case.
 *
 * @param raw - decoded response body
 */
export function parseLocalStatus(raw: unknown): LocalStatus {
    const state = asObject(asObject(raw)?.state);
    const current = asObject(state?.current);
    const relay = asObject(state?.relay);
    const onOff = (value: unknown): boolean | null => {
        const text = normaliseText(value);
        return text === 'on' ? true : text === 'off' ? false : null;
    };
    return {
        heatSource: normaliseText(state?.heat_source),
        heatSourceCommanded: normaliseText(current?.heat_source),
        heatSourceActual: normaliseText(relay?.heat_source),
        immersionCommanded: onOff(current?.immersion),
        immersionActual: onOff(relay?.immersion),
        systemOn: onOff(state?.system),
    };
}
