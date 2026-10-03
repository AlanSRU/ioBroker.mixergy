/**
 * Object definitions for one tank device. Ids are relative to the tank device (`<SERIAL>`).
 *
 * The writable definitions here are the single source for both object creation and the
 * `onStateChange` dispatch, so a writable state can't exist without a handler.
 */

type Common = ioBroker.StateCommon;

/**
 * Object id segment for a tank serial number.
 *
 * @param serial - tank serial number
 */
export function tankId(serial: string): string {
    return serial.replace(/[^A-Za-z0-9_-]/g, '_');
}

export const CHANNELS: Record<string, string> = {
    info: 'Tank information',
    measurement: 'Measurements',
    control: 'Control',
    settings: 'Settings',
    schedule: 'Schedule and holiday',
};

export const LOCAL_CHANNEL = { id: 'local', name: 'Local controller (LAN)' };

function ro(name: string, type: Common['type'], role: string, extra: Partial<Common> = {}): Common {
    const def = type === 'string' ? '' : type === 'boolean' ? false : undefined;
    return { name, type, role, read: true, write: false, ...(def === undefined ? {} : { def }), ...extra };
}

/** Read-only states under `<SERIAL>`. */
export const READ_STATES: Record<string, Common> = {
    'info.serialNumber': ro('Serial number', 'string', 'info.serial'),
    'info.modelCode': ro('Model code', 'string', 'info.model'),
    'info.firmwareVersion': ro('Firmware version', 'string', 'info.firmware'),
    'info.hasPvDiverter': ro('PV diverter fitted', 'boolean', 'indicator'),
    'info.recordedTime': ro('Time the tank recorded the latest measurement', 'number', 'date'),
    'info.stale': ro('Latest measurement is out of date', 'boolean', 'indicator'),

    'measurement.charge': ro('State of charge', 'number', 'value.fill', { unit: '%', min: 0, max: 100 }),
    'measurement.topTemperature': ro('Top (hot water) temperature', 'number', 'value.temperature', { unit: '°C' }),
    'measurement.bottomTemperature': ro('Bottom (coldest water) temperature', 'number', 'value.temperature', {
        unit: '°C',
    }),
    'measurement.heatSource': ro('Active heat source', 'string', 'text', {
        states: { electric: 'Electric', indirect: 'Indirect', heatpump: 'Heat pump' },
    }),
    'measurement.heating': ro('Heating', 'boolean', 'indicator.working'),
    'measurement.electricHeat': ro('Heating with the electric immersion', 'boolean', 'indicator'),
    'measurement.indirectHeat': ro('Heating indirectly (boiler)', 'boolean', 'indicator'),
    'measurement.heatPumpHeat': ro('Heating with the heat pump', 'boolean', 'indicator'),
    'measurement.power': ro('Immersion power', 'number', 'value.power', { unit: 'W' }),
    'measurement.energy': ro('Immersion energy (counted by the adapter)', 'number', 'value.energy.consumed', {
        unit: 'kWh',
        def: 0,
    }),
    'measurement.pvPower': ro('PV diverter power', 'number', 'value.power', { unit: 'W' }),
    'measurement.clampPower': ro('CT clamp power', 'number', 'value.power', { unit: 'W' }),

    'schedule.holidayMode': ro('Holiday mode active', 'boolean', 'indicator'),
};

/** A writable value that maps onto one cloud settings field. */
export interface SettingDef {
    /** Field name in the settings document. */
    key: string;
    /** Lower clamp for numbers. */
    min?: number;
    /** Upper clamp for numbers. */
    max?: number;
    /** The state's common. */
    common: Common;
}

function setting(key: string, common: Omit<Common, 'read' | 'write'>): SettingDef {
    return { key, min: common.min, max: common.max, common: { ...common, read: true, write: true } };
}

/** Writable states backed by `PUT settings`, keyed by id under `<SERIAL>`. */
export const SETTINGS: Record<string, SettingDef> = {
    'control.targetTemperature': setting('max_temp', {
        name: 'Target temperature',
        type: 'number',
        role: 'level.temperature',
        unit: '°C',
        min: 45,
        max: 70,
    }),
    'settings.cleansingTemperature': setting('cleansing_temperature', {
        name: 'Cleansing (anti-legionella) temperature',
        type: 'number',
        role: 'level.setting.temperature',
        unit: '°C',
        min: 51,
        max: 55,
    }),
    'settings.dsrEnabled': setting('dsr_enabled', {
        name: 'Grid assistance (DSR)',
        type: 'boolean',
        role: 'switch.enable',
        def: false,
    }),
    'settings.frostProtection': setting('frost_protection_enabled', {
        name: 'Frost protection',
        type: 'boolean',
        role: 'switch.enable',
        def: false,
    }),
    'settings.distributedComputing': setting('distributed_computing_enabled', {
        name: 'Distributed computing',
        type: 'boolean',
        role: 'switch.enable',
        def: false,
    }),
    'settings.divertExported': setting('divert_exported_enabled', {
        name: 'Divert exported PV power',
        type: 'boolean',
        role: 'switch.enable',
        def: false,
    }),
    'settings.pvCutInThreshold': setting('pv_cut_in_threshold', {
        name: 'PV cut-in threshold',
        type: 'number',
        role: 'level.setting',
        unit: 'W',
        min: 0,
        max: 500,
    }),
    'settings.pvChargeLimit': setting('pv_charge_limit', {
        name: 'PV charge limit',
        type: 'number',
        role: 'level.setting',
        unit: '%',
        min: 0,
        max: 100,
    }),
    'settings.pvTargetCurrent': setting('pv_target_current', {
        name: 'PV target current',
        type: 'number',
        role: 'level.setting',
        min: -1,
        max: 0,
        step: 0.1,
    }),
    'settings.pvOverTemperature': setting('pv_over_temperature', {
        name: 'PV over-temperature limit',
        type: 'number',
        role: 'level.setting.temperature',
        unit: '°C',
        min: 45,
        max: 60,
    }),
};

/** Other writable states under `<SERIAL>`, each handled explicitly in `onStateChange`. */
export const COMMAND_STATES: Record<string, Common> = {
    'control.targetCharge': {
        name: 'Target charge',
        type: 'number',
        role: 'level',
        unit: '%',
        min: 0,
        max: 100,
        read: true,
        write: true,
    },
    'control.boost': {
        name: 'Boost (charge to 100 %)',
        type: 'boolean',
        role: 'button',
        read: false,
        write: true,
    },
    'schedule.defaultHeatSource': {
        name: 'Default heat source',
        type: 'string',
        role: 'text',
        states: { electric: 'Electric', indirect: 'Indirect', heatpump: 'Heat pump' },
        read: true,
        write: true,
        def: '',
    },
    'schedule.holidayStart': {
        name: 'Holiday start (ISO 8601)',
        type: 'string',
        role: 'date.start',
        read: true,
        write: true,
        def: '',
    },
    'schedule.holidayEnd': {
        name: 'Holiday end (ISO 8601)',
        type: 'string',
        role: 'date.end',
        read: true,
        write: true,
        def: '',
    },
    'schedule.holidayClear': {
        name: 'Cancel holiday',
        type: 'boolean',
        role: 'button',
        read: false,
        write: true,
    },
};

/** States under `<SERIAL>.local`. `cp`, `dp` and `e` are exposed raw: their units are unresolved. */
export const LOCAL_STATES: Record<string, Common> = {
    connected: ro('Local controller reachable', 'boolean', 'indicator.reachable'),
    charge: ro('State of charge', 'number', 'value.fill', { unit: '%', min: 0, max: 100 }),
    topTemperature: ro('Top temperature', 'number', 'value.temperature', { unit: '°C' }),
    flowTemperature: ro('Flow temperature', 'number', 'value.temperature', { unit: '°C' }),
    bottomTemperature: ro('Bottom temperature', 'number', 'value.temperature', { unit: '°C' }),
    ambientTemperature: ro('Ambient temperature', 'number', 'value.temperature', { unit: '°C' }),
    voltage: ro('Mains voltage', 'number', 'value.voltage', { unit: 'V' }),
    current: ro('Tank current', 'number', 'value.current', { unit: 'A' }),
    frequency: ro('Grid frequency', 'number', 'value.frequency', { unit: 'Hz' }),
    heating: ro('Heating', 'boolean', 'indicator.working'),
    immersionRelay: ro('Direct (immersion) relay', 'boolean', 'indicator'),
    indirectRelay: ro('Indirect relay', 'boolean', 'indicator'),
    pumpRelay: ro('Pump output', 'boolean', 'indicator'),
    cpRaw: ro('Raw "cp" reading (units unknown)', 'number', 'value'),
    dpRaw: ro('Raw "dp" reading (units unknown)', 'number', 'value'),
    eRaw: ro('Raw "e" reading (meaning unknown)', 'number', 'value'),
    heatSource: ro('Effective heat source', 'string', 'text'),
    heatSourceCommanded: ro('Commanded heat source', 'string', 'text'),
    heatSourceActual: ro('Heat source relay position', 'string', 'text'),
    immersionCommanded: ro('Immersion commanded on', 'boolean', 'indicator'),
    immersionActual: ro('Immersion relay on', 'boolean', 'indicator'),
    systemOn: ro('System on', 'boolean', 'indicator'),
};
