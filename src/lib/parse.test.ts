import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    hasPvDiverter,
    LineSplitter,
    parseCloudMeasurement,
    parseLocalLine,
    parseLocalStatus,
    parseSchedule,
    toBoolean,
    toClampedNumber,
    toNumber,
} from './parse';

const captures = join(__dirname, '..', '..', 'docs', 'captures');
const capture = (name: string): string => readFileSync(join(captures, name), 'utf8');

describe('toNumber / toBoolean', () => {
    it('never turns "not reported" into zero or true', () => {
        for (const missing of [null, undefined, '', ' ', [], {}, NaN, Infinity, 'abc']) {
            expect(toNumber(missing)).to.equal(null);
        }
        for (const missing of [null, undefined, '', '0', 0, 1, 'yes']) {
            expect(toBoolean(missing)).to.equal(null);
        }
    });

    it('keeps genuine zeros and falses', () => {
        expect(toNumber(0)).to.equal(0);
        expect(toNumber('0')).to.equal(0);
        expect(toNumber('-0.5')).to.equal(-0.5);
        expect(toBoolean(false)).to.equal(false);
        expect(toBoolean('false')).to.equal(false);
    });

    it('clamps', () => {
        expect(toClampedNumber(120, 0, 100)).to.equal(100);
        expect(toClampedNumber('-3', 0, 100)).to.equal(0);
        expect(toClampedNumber('x', 0, 100)).to.equal(null);
    });
});

describe('local /measurements stream (captured 2026-08-20)', () => {
    for (const file of ['measurements.raw', 'measurements-2.raw']) {
        it(`parses every line of ${file} into a known message class`, () => {
            const lines = capture(file)
                .split('\n')
                .filter(l => l.trim() !== '');
            const parsed = lines.map(parseLocalLine);
            expect(parsed).to.not.include(null);
            const kinds = new Set(parsed.map(m => m!.kind));
            expect([...kinds].sort()).to.deep.equal(['fast', 'relay', 'slow']);
        });
    }

    it('maps the slow message fields', () => {
        const m = parseLocalLine(
            '{"soc":41.7,"tt":56.5,"ft":55.7,"bt":21.2,"op":false,"v":240.16,"i":0.0,"ts":26,"time":1787215475078,"ats":27.1}',
        );
        expect(m).to.deep.equal({
            kind: 'slow',
            soc: 41.7,
            tt: 56.5,
            ft: 55.7,
            bt: 21.2,
            op: false,
            v: 240.16,
            i: 0,
            ats: 27.1,
        });
    });

    it('rejects blank, malformed and unknown lines', () => {
        expect(parseLocalLine('')).to.equal(null);
        expect(parseLocalLine('{"soc":4')).to.equal(null);
        expect(parseLocalLine('{"ts":1}')).to.equal(null);
        expect(parseLocalLine('[1,2]')).to.equal(null);
    });

    it('reassembles lines split across chunk boundaries', () => {
        const raw = capture('measurements.raw');
        const splitter = new LineSplitter();
        const lines: string[] = [];
        for (let i = 0; i < raw.length; i += 7) {
            lines.push(...splitter.push(raw.slice(i, i + 7)));
        }
        expect(lines).to.deep.equal(raw.split(/\r?\n/).slice(0, -1));
    });

    it('drops an unterminated line that outgrows the buffer', () => {
        const splitter = new LineSplitter(10);
        expect(splitter.push('x'.repeat(20))).to.deep.equal([]);
        expect(splitter.push('{"a":1}\n')).to.deep.equal(['{"a":1}']);
    });
});

describe('local /status (captured 2026-08-20)', () => {
    it('normalises capitalised values and splits commanded from actual', () => {
        expect(parseLocalStatus(JSON.parse(capture('status.json')))).to.deep.equal({
            heatSource: 'indirect',
            heatSourceCommanded: 'indirect',
            heatSourceActual: 'indirect',
            immersionCommanded: false,
            immersionActual: false,
            systemOn: true,
        });
    });

    it('returns nulls for an empty payload', () => {
        const s = parseLocalStatus({});
        expect(Object.values(s).every(v => v === null)).to.equal(true);
    });
});

// The cloud payloads below are modelled on the community integrations (SCOPE.md §2), not captured.
describe('cloud latest_measurement', () => {
    const base = {
        charge: 41.6,
        topTemperature: 56.5,
        bottomTemperature: 21.2,
        recordedTime: 1787215475078,
        receivedTime: 1787215476000,
    };

    it('parses `state` given as a JSON string', () => {
        const m = parseCloudMeasurement({
            ...base,
            state: '{"current":{"target":80,"heat_source":"Electric","immersion":"On"}}',
            energy: 180000,
        });
        expect(m.charge).to.equal(41.6);
        expect(m.targetCharge).to.equal(80);
        expect(m.heatSource).to.equal('electric');
        expect(m.heating).to.equal(true);
        expect(m.electricHeat).to.equal(true);
        expect(m.indirectHeat).to.equal(false);
        expect(m.power).to.equal(3000);
        expect(m.holidayMode).to.equal(false);
    });

    it('parses `state` given as an object, and detects holiday', () => {
        const m = parseCloudMeasurement({
            ...base,
            state: { current: { heat_source: 'heatpump', immersion: 'off', source: 'Vacation' } },
        });
        expect(m.heatSource).to.equal('heatpump');
        expect(m.heating).to.equal(false);
        expect(m.heatPumpHeat).to.equal(false);
        expect(m.holidayMode).to.equal(true);
        expect(m.power).to.equal(0);
    });

    it('falls back to clampPower only while heating electrically without `energy`', () => {
        const state = '{"current":{"heat_source":"electric","immersion":"on"}}';
        expect(parseCloudMeasurement({ ...base, state, clampPower: 2900 }).power).to.equal(2900);
        expect(parseCloudMeasurement({ ...base, state }).power).to.equal(null);
    });

    it('rejects implausible immersion energy', () => {
        const state = '{"current":{"heat_source":"electric","immersion":"on"}}';
        expect(parseCloudMeasurement({ ...base, state, energy: 60 * 20_000 }).power).to.equal(null);
    });

    it('converts pvEnergy (J/min) to W', () => {
        expect(parseCloudMeasurement({ ...base, pvEnergy: 60000 }).pvPower).to.equal(1000);
    });

    it('leaves everything unknown when `state` is missing or broken', () => {
        for (const state of [undefined, 'not json', 42]) {
            const m = parseCloudMeasurement({ ...base, state });
            expect(m.heating).to.equal(null);
            expect(m.power).to.equal(null);
            expect(m.targetCharge).to.equal(null);
            expect(m.holidayMode).to.equal(null);
        }
    });

    it('never manufactures readings from an empty body', () => {
        const m = parseCloudMeasurement(null);
        expect(m.charge).to.equal(null);
        expect(m.topTemperature).to.equal(null);
        expect(m.recordedTime).to.equal(null);
    });
});

describe('cloud schedule and configuration', () => {
    it('converts holiday epoch ms to ISO and folds heat_pump onto heatpump', () => {
        expect(
            parseSchedule({
                defaultHeatSource: 'heat_pump',
                holiday: { departDate: Date.UTC(2026, 11, 20), returnDate: Date.UTC(2027, 0, 3) },
            }),
        ).to.deep.equal({
            defaultHeatSource: 'heatpump',
            holidayStart: '2026-12-20T00:00:00.000Z',
            holidayEnd: '2027-01-03T00:00:00.000Z',
        });
    });

    it('reports no holiday as empty strings', () => {
        expect(parseSchedule({ defaultHeatSource: 'electric' })).to.deep.equal({
            defaultHeatSource: 'electric',
            holidayStart: '',
            holidayEnd: '',
        });
    });

    it('detects a PV diverter from string or object configuration', () => {
        expect(hasPvDiverter('{"mixergyPvType":"SOLAR_IBOOST"}')).to.equal(true);
        expect(hasPvDiverter({ mixergyPvType: 'NO_INVERTER' })).to.equal(false);
        expect(hasPvDiverter('{}')).to.equal(false);
        expect(hasPvDiverter('garbage')).to.equal(false);
    });
});
