/*
 * Created with @iobroker/create-adapter v3.1.5
 */

import * as utils from '@iobroker/adapter-core';
import { MixergyAuthError, MixergyCloud, type CloudTank } from './lib/cloud';
import { fetchLocalStatus, LocalStream, parseLocalHost } from './lib/local';
import { CHANNELS, COMMAND_STATES, LOCAL_CHANNEL, LOCAL_STATES, READ_STATES, SETTINGS, tankId } from './lib/objects';
import {
    normaliseText,
    parseCloudMeasurement,
    parseSchedule,
    asObject,
    toBoolean,
    toClampedNumber,
    toNumber,
    type LocalMessage,
} from './lib/parse';

const POLL_MIN_S = 30;
const POLL_MAX_S = 300;
const POLL_DEFAULT_S = 60;
/** After a rejected login, wait this long before trying again so the account isn't locked. */
const AUTH_RETRY_MS = 30 * 60_000;
/** Delay before re-polling after a write, so the cloud has applied it. */
const REPOLL_AFTER_WRITE_MS = 2_000;
const STALE_MIN_MS = 5 * 60_000;

const LOCAL_STATUS_INTERVAL_MS = 10_000;
const LOCAL_RETRY_MIN_MS = 5_000;
const LOCAL_RETRY_MAX_MS = 60_000;
/** A stream that stayed up this long resets the reconnect backoff. */
const LOCAL_STABLE_MS = 60_000;
/** The stream pushes every 100 ms; numbers are written at most this often per state. */
const LOCAL_NUMBER_THROTTLE_MS = 1_000;

const HEAT_SOURCES = ['electric', 'indirect', 'heatpump'];

interface Tank {
    serial: string;
    id: string;
    /** Running kWh total, seeded from the state on start. */
    energy: number;
    lastPower: number | null;
    lastSampleAt: number | null;
}

class Mixergy extends utils.Adapter {
    private cloud: MixergyCloud | null = null;
    private readonly tanks = new Map<string, Tank>();
    private pollIntervalMs = POLL_DEFAULT_S * 1000;
    private pollTimer: ioBroker.Timeout | undefined;
    private polling = false;
    private pollAgain = false;
    private cloudFailures = 0;
    /** Keys of problems already logged, so a repeating failure warns once. */
    private readonly warned = new Set<string>();
    /** Set first thing in onUnload, so in-flight work stops before writing or opening resources. */
    private unloaded = false;
    /** After a rejected login, no login is tried before this time, so the account isn't locked. */
    private authBlockedUntil = 0;
    /** Holiday date states written by the user and waiting for the other date. */
    private readonly holidayPending = new Set<string>();

    private localHost: string | null = null;
    private localTankId: string | null = null;
    private localStream: LocalStream | null = null;
    private localUp = false;
    private localOpenedAt = 0;
    private localRetryMs = LOCAL_RETRY_MIN_MS;
    private localRetryTimer: ioBroker.Timeout | undefined;
    private localStatusTimer: ioBroker.Timeout | undefined;
    private readonly localCache = new Map<string, { val: ioBroker.StateValue; ts: number }>();

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'mixergy',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        await this.setState('info.connection', false, true);
        // Nothing is connected yet: clear any `true` left over from before a restart
        const localConnected = await this.getStatesAsync('*.local.connected');
        for (const [id, state] of Object.entries(localConnected ?? {})) {
            if (state?.val) {
                await this.setState(id, false, true);
            }
        }

        this.pollIntervalMs =
            (toClampedNumber(this.config.pollInterval, POLL_MIN_S, POLL_MAX_S) ?? POLL_DEFAULT_S) * 1000;

        const username = this.config.username.trim();
        if (username && this.config.password) {
            this.cloud = new MixergyCloud({ username, password: this.config.password });
        }

        const localSerial = this.config.localSerial.trim().toUpperCase();
        if (this.config.enableLocal) {
            this.localHost = parseLocalHost(this.config.localHost);
            if (!this.localHost) {
                this.log.error(
                    `Local controller address "${this.config.localHost}" is not a valid IP address or hostname.`,
                );
            }
        }

        if (!this.cloud) {
            if (this.localHost && localSerial) {
                this.log.info('No Mixergy account entered: reading the local controller only, changes are disabled.');
            } else if (this.localHost) {
                this.log.error('Without a Mixergy account, enter the tank serial number for the local controller.');
            } else {
                this.log.error('Enter your Mixergy account email and password in the instance settings.');
            }
        }

        this.subscribeStates('*.control.*');
        this.subscribeStates('*.settings.*');
        this.subscribeStates('*.schedule.*');

        if (this.localHost && localSerial) {
            await this.startLocal(localSerial);
        }
        if (this.cloud && !this.unloaded) {
            await this.pollCycle();
        }
    }

    // --- object tree -------------------------------------------------------------------------

    private async ensureTank(serial: string): Promise<Tank> {
        const id = tankId(serial);
        const known = this.tanks.get(id);
        if (known) {
            return known;
        }
        // setObjectNotExists keeps a device name the user may have changed
        await this.setObjectNotExistsAsync(id, {
            type: 'device',
            common: { name: `Mixergy tank ${serial}` },
            native: {},
        });
        for (const [channel, name] of Object.entries(CHANNELS)) {
            await this.extendObject(`${id}.${channel}`, { type: 'channel', common: { name }, native: {} });
        }
        const states = { ...READ_STATES, ...COMMAND_STATES };
        for (const [key, def] of Object.entries(SETTINGS)) {
            states[key] = def.common;
        }
        for (const [key, common] of Object.entries(states)) {
            await this.extendObject(`${id}.${key}`, { type: 'state', common, native: {} });
        }
        const energy = await this.getStateAsync(`${id}.measurement.energy`);
        const tank: Tank = { serial, id, energy: toNumber(energy?.val) ?? 0, lastPower: null, lastSampleAt: null };
        this.tanks.set(id, tank);
        await this.write(`${id}.info.serialNumber`, serial);
        return tank;
    }

    // --- cloud polling -----------------------------------------------------------------------

    private async pollCycle(): Promise<void> {
        if (!this.cloud || this.unloaded) {
            return;
        }
        this.polling = true;
        this.pollAgain = false;
        let delay = this.pollIntervalMs;
        try {
            const tanks = await this.cloud.listTanks();
            if (tanks.length === 0) {
                this.warnOnce('no-tanks', 'No tanks found on this Mixergy account.');
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
            if (err instanceof MixergyAuthError) {
                delay = Math.max(delay, AUTH_RETRY_MS);
                this.authBlockedUntil = Date.now() + AUTH_RETRY_MS;
            }
            await this.cloudFailed(err as Error);
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
    private requestPoll(): void {
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

    private async pollTank(entry: CloudTank): Promise<void> {
        const cloud = this.cloud!;
        const detail = await cloud.getDetail(entry.serial);
        const tank = await this.ensureTank(entry.serial);
        const id = tank.id;
        await this.write(`${id}.info.firmwareVersion`, entry.firmwareVersion);
        await this.write(`${id}.info.modelCode`, detail.modelCode);
        await this.write(`${id}.info.hasPvDiverter`, detail.hasPvDiverter);

        // The measurement is mandatory: if it fails, the whole poll fails
        const m = parseCloudMeasurement(await cloud.getMeasurement(entry.serial));
        const reported = m.receivedTime ?? m.recordedTime;
        const stale = reported !== null && Date.now() - reported > Math.max(STALE_MIN_MS, 3 * this.pollIntervalMs);
        await this.write(`${id}.info.recordedTime`, m.recordedTime);
        await this.write(`${id}.info.stale`, stale);
        await this.write(`${id}.measurement.charge`, m.charge);
        await this.write(`${id}.measurement.topTemperature`, m.topTemperature);
        await this.write(`${id}.measurement.bottomTemperature`, m.bottomTemperature);
        await this.write(`${id}.measurement.heatSource`, m.heatSource ?? '');
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

        // Settings and schedule change rarely: on failure the states keep their last good value
        try {
            const settings = asObject(await cloud.getSettings(entry.serial));
            if (!settings) {
                throw new Error('empty response');
            }
            for (const [key, def] of Object.entries(SETTINGS)) {
                const raw = settings[def.key];
                const val = def.common.type === 'boolean' ? toBoolean(raw) : toNumber(raw);
                // PV fields are absent on tanks without a diverter
                if (val !== null) {
                    await this.write(`${id}.${key}`, val);
                }
            }
            this.clearWarning(`settings-${id}`);
        } catch (err) {
            this.warnOnce(
                `settings-${id}`,
                `Reading settings of tank ${entry.serial} failed: ${(err as Error).message}`,
            );
        }

        try {
            const schedule = parseSchedule(await cloud.getSchedule(entry.serial));
            if (schedule.defaultHeatSource !== null) {
                await this.write(`${id}.schedule.defaultHeatSource`, schedule.defaultHeatSource);
            }
            await this.writeUnlessPending(`${id}.schedule.holidayStart`, schedule.holidayStart);
            await this.writeUnlessPending(`${id}.schedule.holidayEnd`, schedule.holidayEnd);
            this.clearWarning(`schedule-${id}`);
        } catch (err) {
            this.warnOnce(
                `schedule-${id}`,
                `Reading schedule of tank ${entry.serial} failed: ${(err as Error).message}`,
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
    private accumulateEnergy(tank: Tank, power: number | null): void {
        const now = Date.now();
        if (tank.lastSampleAt !== null && tank.lastPower !== null && tank.lastPower > 0) {
            const elapsedMs = Math.min(Math.max(0, now - tank.lastSampleAt), 2 * this.pollIntervalMs);
            // W x ms -> kWh
            tank.energy = Math.round((tank.energy + (tank.lastPower * elapsedMs) / 3.6e9) * 10_000) / 10_000;
        }
        tank.lastPower = power;
        tank.lastSampleAt = now;
    }

    private async cloudSucceeded(): Promise<void> {
        this.cloudFailures = 0;
        this.authBlockedUntil = 0;
        this.clearWarning('auth-write');
        if (this.clearWarning('cloud')) {
            this.log.info('Mixergy cloud reachable again.');
        }
        await this.write('info.connection', true);
        await this.write('info.lastUpdate', Date.now());
    }

    private async cloudFailed(err: Error): Promise<void> {
        this.cloudFailures++;
        for (const tank of this.tanks.values()) {
            tank.lastPower = null;
        }
        if (err instanceof MixergyAuthError) {
            if (!this.warned.has('cloud')) {
                this.warned.add('cloud');
                this.log.error(`${err.message}. Check the account email and password in the instance settings.`);
            }
            await this.write('info.connection', false);
            return;
        }
        this.warnOnce('cloud', `Mixergy cloud request failed: ${err.message}`);
        // One blip or timeout shouldn't flag the connection as lost
        if (this.cloudFailures >= 2) {
            await this.write('info.connection', false);
        }
    }

    // --- writes ------------------------------------------------------------------------------

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
        if (!state || state.ack || this.unloaded) {
            return;
        }
        const rel = id.slice(this.namespace.length + 1);
        const dot = rel.indexOf('.');
        const tank = this.tanks.get(rel.slice(0, dot));
        const key = rel.slice(dot + 1);
        if (!tank) {
            return;
        }
        if (!this.cloud) {
            this.log.warn(`Cannot change ${key}: changes need a Mixergy account in the instance settings.`);
            return;
        }
        if (Date.now() < this.authBlockedUntil) {
            this.warnOnce(
                'auth-write',
                `Cannot change ${key}: Mixergy rejected the account email or password. Check them in the instance settings.`,
            );
            return;
        }
        let wrote: boolean;
        try {
            wrote = await this.handleWrite(tank, key, state.val);
        } catch (err) {
            if (err instanceof MixergyAuthError) {
                // Don't let writes retry the login faster than polling does
                this.authBlockedUntil = Date.now() + AUTH_RETRY_MS;
                this.log.error(`${err.message}. Check the account email and password in the instance settings.`);
                return;
            }
            this.log.warn(`Changing ${key} on tank ${tank.serial} failed: ${(err as Error).message}`);
            wrote = true; // re-poll to restore the real value
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
    private async handleWrite(tank: Tank, key: string, val: ioBroker.StateValue): Promise<boolean> {
        const cloud = this.cloud!;
        const setting = SETTINGS[key];
        if (setting) {
            const value =
                setting.common.type === 'boolean'
                    ? toBoolean(val)
                    : toClampedNumber(val, setting.min ?? -Infinity, setting.max ?? Infinity);
            if (value === null) {
                throw new Error(`invalid value ${JSON.stringify(val)}`);
            }
            await cloud.putSettings(tank.serial, { [setting.key]: value });
            await this.write(`${tank.id}.${key}`, value);
            return true;
        }

        switch (key) {
            case 'control.targetCharge': {
                const charge = toClampedNumber(val, 0, 100);
                if (charge === null) {
                    throw new Error(`invalid value ${JSON.stringify(val)}`);
                }
                await cloud.setTargetCharge(tank.serial, charge);
                await this.write(`${tank.id}.${key}`, charge);
                return true;
            }
            case 'control.boost':
                if (!val) {
                    return false;
                }
                await cloud.setTargetCharge(tank.serial, 100);
                return true;
            case 'schedule.defaultHeatSource': {
                const source = normaliseText(val);
                if (source === null || !HEAT_SOURCES.includes(source)) {
                    throw new Error(`heat source must be one of ${HEAT_SOURCES.join(', ')}`);
                }
                await cloud.mutateSchedule(tank.serial, schedule => {
                    schedule.defaultHeatSource = source;
                });
                await this.write(`${tank.id}.${key}`, source);
                return true;
            }
            case 'schedule.holidayStart':
            case 'schedule.holidayEnd':
                return this.writeHoliday(tank, key, val);
            case 'schedule.holidayClear':
                if (!val) {
                    return false;
                }
                await cloud.mutateSchedule(tank.serial, schedule => {
                    delete schedule.holiday;
                });
                return true;
            default:
                return false;
        }
    }

    /**
     * The API takes start and end together, so a holiday is sent once both states form a valid
     * range. A date that doesn't pair with the cloud's current other date waits, unacknowledged
     * and left alone by polling, until the user writes the other date.
     *
     * @param tank - the tank
     * @param key - schedule.holidayStart or schedule.holidayEnd
     * @param val - the requested value
     */
    private async writeHoliday(tank: Tank, key: string, val: ioBroker.StateValue): Promise<boolean> {
        const isStart = key === 'schedule.holidayStart';
        const ownId = `${tank.id}.${key}`;
        const otherId = `${tank.id}.schedule.${isStart ? 'holidayEnd' : 'holidayStart'}`;
        const other = await this.getStateAsync(otherId);
        const own = Date.parse(String(val ?? ''));
        const otherDate = Date.parse(String(other?.val ?? ''));
        const otherPending = this.holidayPending.has(otherId);
        if (Number.isNaN(own)) {
            this.holidayPending.delete(ownId);
            throw new Error(`${JSON.stringify(val)} is not a valid date`);
        }
        const [start, end] = isStart ? [own, otherDate] : [otherDate, own];
        if (Number.isNaN(otherDate) || (end <= start && !otherPending)) {
            this.holidayPending.add(ownId);
            this.log.info(`Holiday for tank ${tank.serial} is sent once start and end form a valid range.`);
            return false;
        }
        this.holidayPending.delete(ownId);
        this.holidayPending.delete(otherId);
        if (end <= start) {
            throw new Error('holiday end must be after its start');
        }
        await this.cloud!.mutateSchedule(tank.serial, schedule => {
            schedule.holiday = { departDate: start, returnDate: end };
        });
        await this.write(`${tank.id}.schedule.holidayStart`, new Date(start).toISOString());
        await this.write(`${tank.id}.schedule.holidayEnd`, new Date(end).toISOString());
        return true;
    }

    // --- local controller --------------------------------------------------------------------

    private async startLocalFromAccount(tanks: CloudTank[]): Promise<void> {
        if (!this.localHost || this.localTankId) {
            return;
        }
        if (tanks.length === 1) {
            await this.startLocal(tanks[0].serial);
        } else if (tanks.length > 1) {
            this.warnOnce(
                'local-serial',
                'Several tanks are on this Mixergy account: enter the serial number of the tank the local controller belongs to.',
            );
        }
    }

    private async startLocal(serial: string): Promise<void> {
        if (!this.localHost || this.localTankId || this.unloaded) {
            return;
        }
        const tank = await this.ensureTank(serial);
        await this.extendObject(`${tank.id}.${LOCAL_CHANNEL.id}`, {
            type: 'channel',
            common: { name: LOCAL_CHANNEL.name },
            native: {},
        });
        for (const [key, common] of Object.entries(LOCAL_STATES)) {
            await this.extendObject(`${tank.id}.${LOCAL_CHANNEL.id}.${key}`, { type: 'state', common, native: {} });
        }
        if (this.unloaded) {
            return;
        }
        this.localTankId = tank.id;
        // Clear a `true` left over from before a restart
        this.writeLocal('connected', false);
        this.log.info(`Reading tank ${serial} from the local controller at ${this.localHost}.`);
        this.connectLocal();
        void this.pollLocalStatus();
    }

    private connectLocal(): void {
        if (this.unloaded || !this.localHost) {
            return;
        }
        this.localOpenedAt = Date.now();
        this.localStream = new LocalStream(this.localHost, {
            onMessage: message => this.onLocalMessage(message),
            onClose: reason => this.onLocalClose(reason),
        });
        this.localStream.start();
    }

    private onLocalMessage(m: LocalMessage): void {
        if (!this.localUp) {
            this.setLocalUp(true);
            if (this.clearWarning('local')) {
                this.log.info('Local controller reachable again.');
            }
        }
        switch (m.kind) {
            case 'fast':
                this.writeLocal('frequency', m.f);
                this.writeLocal('cpRaw', m.cp);
                this.writeLocal('dpRaw', m.dp);
                this.writeLocal('eRaw', m.e);
                break;
            case 'slow':
                this.writeLocal('charge', m.soc);
                this.writeLocal('topTemperature', m.tt);
                this.writeLocal('flowTemperature', m.ft);
                this.writeLocal('bottomTemperature', m.bt);
                this.writeLocal('ambientTemperature', m.ats);
                this.writeLocal('voltage', m.v);
                this.writeLocal('current', m.i);
                this.writeLocal('heating', m.op);
                break;
            case 'relay':
                this.writeLocal('immersionRelay', m.dro);
                this.writeLocal('indirectRelay', m.iro);
                this.writeLocal('pumpRelay', m.po);
                break;
        }
    }

    private onLocalClose(reason: string): void {
        this.localStream = null;
        if (this.unloaded) {
            return;
        }
        if (this.localUp) {
            this.setLocalUp(false);
        }
        if (Date.now() - this.localOpenedAt >= LOCAL_STABLE_MS) {
            this.localRetryMs = LOCAL_RETRY_MIN_MS;
        }
        this.warnOnce('local', `Local controller at ${this.localHost} unavailable (${reason}), retrying.`);
        this.localRetryTimer = this.setTimeout(() => this.connectLocal(), this.localRetryMs);
        this.localRetryMs = Math.min(this.localRetryMs * 2, LOCAL_RETRY_MAX_MS);
    }

    private setLocalUp(up: boolean): void {
        this.localUp = up;
        this.writeLocal('connected', up);
        // Without an account the local controller is the only connection
        if (!this.cloud) {
            this.write('info.connection', up).catch(err => this.log.debug(`Writing info.connection failed: ${err}`));
        }
    }

    private async pollLocalStatus(): Promise<void> {
        if (this.unloaded || !this.localHost) {
            return;
        }
        try {
            const s = await fetchLocalStatus(this.localHost);
            this.writeLocal('heatSource', s.heatSource);
            this.writeLocal('heatSourceCommanded', s.heatSourceCommanded);
            this.writeLocal('heatSourceActual', s.heatSourceActual);
            this.writeLocal('immersionCommanded', s.immersionCommanded);
            this.writeLocal('immersionActual', s.immersionActual);
            this.writeLocal('systemOn', s.systemOn);
        } catch (err) {
            // Reachability is reported by the stream; this only adds detail
            this.log.debug(`Local controller status request failed: ${(err as Error).message}`);
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
    private writeLocal(key: string, val: ioBroker.StateValue): void {
        if (val === null || this.unloaded || !this.localTankId) {
            return;
        }
        const id = `${this.localTankId}.${LOCAL_CHANNEL.id}.${key}`;
        const now = Date.now();
        const last = this.localCache.get(id);
        if (last && (last.val === val || (typeof val === 'number' && now - last.ts < LOCAL_NUMBER_THROTTLE_MS))) {
            return;
        }
        this.localCache.set(id, { val, ts: now });
        this.setState(id, val, true).catch(err => this.log.debug(`Writing ${id} failed: ${(err as Error).message}`));
    }

    // --- helpers -----------------------------------------------------------------------------

    private async write(id: string, val: ioBroker.StateValue): Promise<void> {
        if (!this.unloaded) {
            await this.setStateChangedAsync(id, val, true);
        }
    }

    /**
     * Writes unless the user has half of a holiday waiting for the other date.
     *
     * @param id - state id
     * @param val - the value
     */
    private async writeUnlessPending(id: string, val: ioBroker.StateValue): Promise<void> {
        if (!this.holidayPending.has(id)) {
            await this.write(id, val);
        }
    }

    private warnOnce(key: string, message: string): void {
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
    private clearWarning(key: string): boolean {
        return this.warned.delete(key);
    }

    private onUnload(callback: () => void): void {
        this.unloaded = true;
        try {
            this.localStream?.stop();
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
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Mixergy(options);
} else {
    // otherwise start the instance directly
    (() => new Mixergy())();
}
