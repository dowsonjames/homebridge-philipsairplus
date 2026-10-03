'use strict';
// Runs the plugin against a mocked Homebridge API and a fake Philips cloud. `npm test`
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const hap = require('hap-nodejs');
const cloud = require('../src/cloud');

const { Characteristic: C } = hap;
const POWER = 'D03102', LEVEL = 'D0310D', MODE = 'D0310C';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeConn extends EventEmitter {
  constructor(_cloud, deviceId) { super(); this.deviceId = deviceId; this.sent = []; }
  connect() {}
  stop() {}
  async setDesired(d) { this.sent.push(d); }
}
cloud.PhilipsCloud = class {
  async getDevices() { return [{ device_id: 'dev1', device_info: { name: 'Bedroom', modelid: 'CX3550/01', is_online: true } }]; }
};
cloud.DeviceConnection = FakeConn;

async function startPlugin() {
  let Platform;
  const handlers = {};
  const registered = [];
  const api = {
    hap,
    registerPlatform: (_plugin, _platform, P) => { Platform = P; },
    platformAccessory: class extends hap.Accessory { constructor(name, uuid) { super(name, uuid); this.context = {}; } },
    registerPlatformAccessories: (_p, _n, a) => registered.push(...a),
    unregisterPlatformAccessories() {},
    on: (e, f) => { handlers[e] = f; },
  };
  delete require.cache[require.resolve('../src/index')];
  require('../src/index')(api);
  const noop = () => {};
  const log = Object.assign(noop, { info: noop, warn: noop, error: noop, debug: noop });
  const platform = new Platform(log, { userId: 'u', mSecret: `a_${'0'.repeat(32)}` }, api);
  handlers.didFinishLaunching();
  await sleep(10);
  const fan = platform.fans[0];
  return { fan, accessory: registered[0], active: fan.fan.getCharacteristic(C.Active), speed: fan.fan.getCharacteristic(C.RotationSpeed) };
}

let p;
beforeEach(async () => { p = await startPlugin(); });

test('exposes a fan plus two preset switches', () => {
  const names = p.accessory.services.map((s) => s.displayName).filter(Boolean);
  assert.deepEqual(names, ['Bedroom', 'Bedroom Sleep Mode', 'Bedroom Natural Breeze']);
});

test('speed slider snaps to three positions', () => {
  assert.deepEqual([p.speed.props.minValue, p.speed.props.maxValue, p.speed.props.minStep], [0, 99, 33]);
  p.fan.update({ [POWER]: 1, [LEVEL]: 2, [MODE]: 2 });
  assert.equal(p.speed.value, 66);
});

test('dragging the slider sends only the final speed', async () => {
  p.fan.update({ [POWER]: 1, [LEVEL]: 1, [MODE]: 1 });
  for (const v of [33, 66, 99]) await p.speed.handleSetRequest(v);
  p.fan.update({ [POWER]: 1, [LEVEL]: 1, [MODE]: 1 }); // a poll landing mid-drag
  assert.equal(p.speed.value, 99, 'slider is not yanked back while the write is pending');
  assert.equal(p.fan.conn.sent.length, 0);
  await sleep(500);
  assert.deepEqual(p.fan.conn.sent, [{ [POWER]: 1, [LEVEL]: 3, [MODE]: 3 }]);
});

test('slider to zero turns the fan off', async () => {
  p.fan.update({ [POWER]: 1, [LEVEL]: 2, [MODE]: 2 });
  await p.speed.handleSetRequest(0);
  await sleep(500);
  assert.deepEqual(p.fan.conn.sent, [{ [POWER]: 0 }]);
});

test('a stale echo after turning off does not flip HomeKit back on', async () => {
  p.fan.update({ [POWER]: 1, [LEVEL]: 2, [MODE]: 2 });
  await p.active.handleSetRequest(0);
  p.fan.update({ [POWER]: 1 });
  assert.equal(p.active.value, 0);
  p.fan.update({ [POWER]: 0 });
  p.fan.update({ [POWER]: 1 }); // later turned on with the fan's own button
  assert.equal(p.active.value, 1);
});
