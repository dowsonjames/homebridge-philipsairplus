'use strict';
const { PhilipsCloud, DeviceConnection } = require('./cloud');

const PLUGIN_NAME = 'homebridge-philips-air-fan';
const PLATFORM_NAME = 'PhilipsAirFan';

// Shadow property codes, verified against a physical CX3550/01 by the HA integration authors.
const D = {
  POWER: 'D03102', // 0 off / 1 on
  LEVEL: 'D0310D', // fan level 0-3
  MODE: 'D0310C', // 1/2/3 manual speed, 17 sleep, 130 natural (may echo as signed byte -126)
  OSCILLATE: 'D0320F', // reports 23040 when swinging; write 90 to turn on, 0 off
  NAME: 'D01S03',
  MODEL: 'D01S05',
  SWVERSION: 'D01S12',
};
const MODE_SLEEP = 17;
const MODE_NATURAL = 130;
const OSC_ON_WRITE = 90;
// The Home app always draws RotationSpeed as a percentage, so map the three speeds onto
// steps of 33 (33/66/99%) and the slider snaps to exactly three positions.
const SPEED_STEP = 33;
// Dragging the slider fires a set per step; only send the speed where it lands.
const SPEED_DEBOUNCE_MS = 400;
// How long a value we just wrote wins over a contradicting reported value, while the fan catches up.
const PENDING_MS = 10_000;

module.exports = (api) => api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, PhilipsAirPlusPlatform);

class PhilipsAirPlusPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map();
    this.fans = [];

    if (!this.config.userId || !this.config.mSecret) {
      log.error('Missing userId / mSecret. Open the plugin settings in the Homebridge UI to sign in.');
      return;
    }
    this.cloud = new PhilipsCloud({ userId: this.config.userId, mSecret: this.config.mSecret, log });
    api.on('didFinishLaunching', () => this.discover().catch((e) => log.error(`Discovery failed: ${e.message}`)));
    api.on('shutdown', () => this.fans.forEach((f) => f.conn.stop()));
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  async discover() {
    // Keep cached accessories if the cloud is unreachable at startup, rather than removing them from HomeKit.
    let devices;
    for (let attempt = 1; ; attempt++) {
      try {
        devices = await this.cloud.getDevices();
        break;
      } catch (e) {
        const wait = Math.min(attempt * 30, 600);
        this.log.warn(`Could not reach Philips cloud (${e.message}); retrying in ${wait}s`);
        await new Promise((r) => setTimeout(r, wait * 1000));
      }
    }
    const ignore = new Set(this.config.ignore || []);
    const seen = new Set();

    for (const dev of devices) {
      const id = dev.device_id;
      const info = dev.device_info || {};
      if (ignore.has(id)) continue;
      const uuid = this.api.hap.uuid.generate(`philips-airplus-${id}`);
      seen.add(uuid);
      let accessory = this.cached.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(info.name || info.device_alias || 'Philips Fan', uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      accessory.context.deviceId = id;
      this.log.info(`Found ${info.name || id} (${info.modelid || 'unknown model'}, ${info.is_online ? 'online' : 'offline'})`);
      const conn = new DeviceConnection(this.cloud, id, this.log, this.config.refreshSeconds || 10);
      this.fans.push(new FanAccessory(this, accessory, conn, info));
      conn.connect();
    }

    const stale = [...this.cached.values()].filter((a) => !seen.has(a.UUID));
    if (stale.length) this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
  }
}

class FanAccessory {
  constructor(platform, accessory, conn, info) {
    const { Service, Characteristic } = platform.api.hap;
    this.C = Characteristic;
    this.hap = platform.api.hap;
    this.log = platform.log;
    this.conn = conn;
    this.state = {};
    this.pending = {};
    this.lastLevel = 1;

    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Philips')
      .setCharacteristic(Characteristic.Model, info.modelid || 'CX3550/01')
      .setCharacteristic(Characteristic.SerialNumber, info.mac || conn.deviceId)
      .setCharacteristic(Characteristic.FirmwareRevision, info.swversion || '1.0');

    const fan = accessory.getService(Service.Fanv2) || accessory.addService(Service.Fanv2, accessory.displayName);
    this.fan = fan;
    fan.getCharacteristic(Characteristic.Active)
      .onGet(() => this.isOn() ? 1 : 0)
      .onSet((v) => this.send(v ? { [D.POWER]: 1 } : { [D.POWER]: 0 }));
    fan.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 3 * SPEED_STEP, minStep: SPEED_STEP })
      .onGet(() => this.isOn() ? this.level() * SPEED_STEP : 0)
      .onSet((v) => {
        const level = Math.max(0, Math.min(3, Math.round(v / SPEED_STEP)));
        clearTimeout(this.speedTimer);
        this.speedTimer = setTimeout(() => {
          this.speedTimer = null;
          // send() logs failures itself; there's no HomeKit request left to fail by now.
          this.send(level > 0 ? { [D.POWER]: 1, [D.LEVEL]: level, [D.MODE]: level } : { [D.POWER]: 0 }).catch(() => {});
        }, SPEED_DEBOUNCE_MS);
      });
    fan.getCharacteristic(Characteristic.SwingMode)
      .onGet(() => this.oscillating() ? 1 : 0)
      .onSet((v) => this.send({ [D.OSCILLATE]: v ? OSC_ON_WRITE : 0 }));

    this.presets = [
      { key: 'sleep', name: 'Sleep Mode', mode: MODE_SLEEP },
      { key: 'natural', name: 'Natural Breeze', mode: MODE_NATURAL },
    ].map((p) => {
      const svc = accessory.getServiceById(Service.Switch, p.key) || accessory.addService(Service.Switch, `${accessory.displayName} ${p.name}`, p.key);
      if (!svc.testCharacteristic(Characteristic.ConfiguredName)) svc.addOptionalCharacteristic(Characteristic.ConfiguredName);
      svc.setCharacteristic(Characteristic.ConfiguredName, `${accessory.displayName} ${p.name}`);
      svc.getCharacteristic(Characteristic.On)
        .onGet(() => this.isOn() && this.mode() === p.mode)
        // Turning a preset off drops back to manual mode at the last manual speed.
        .onSet((v) => this.send(v ? { [D.POWER]: 1, [D.MODE]: p.mode } : { [D.MODE]: this.lastLevel, [D.LEVEL]: this.lastLevel }));
      return { ...p, svc };
    });

    conn.on('reported', (r) => this.update(r));
  }

  isOn() { return Number(this.state[D.POWER]) === 1; }
  level() { return Math.max(0, Math.min(3, Number(this.state[D.LEVEL]) || 0)); }
  mode() { return Number(this.state[D.MODE]) & 0xff; }
  oscillating() { return Number(this.state[D.OSCILLATE]) !== 0 && this.state[D.OSCILLATE] !== undefined; }

  async send(desired) {
    try {
      await this.conn.setDesired(desired);
      Object.assign(this.state, desired); // optimistic; the device echoes its reported state shortly after
      const until = Date.now() + PENDING_MS;
      for (const [k, v] of Object.entries(desired)) this.pending[k] = { v, until };
    } catch (e) {
      this.log.error(`${this.conn.deviceId}: ${e.message}`);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  update(reported) {
    // The shadow echoes the old reported state right after a write; don't let that flip HomeKit back.
    const now = Date.now();
    reported = { ...reported };
    for (const [k, p] of Object.entries(this.pending)) {
      if (!(k in reported)) continue;
      if (Number(reported[k]) === Number(p.v) || now > p.until) delete this.pending[k];
      else delete reported[k];
    }
    Object.assign(this.state, reported);
    const m = this.mode();
    if (m >= 1 && m <= 3) this.lastLevel = m;
    const C = this.C;
    this.fan.updateCharacteristic(C.Active, this.isOn() ? 1 : 0);
    // Don't yank the slider back while a speed change is waiting to be sent.
    if (!this.speedTimer) this.fan.updateCharacteristic(C.RotationSpeed, this.isOn() ? this.level() * SPEED_STEP : 0);
    this.fan.updateCharacteristic(C.SwingMode, this.oscillating() ? 1 : 0);
    for (const p of this.presets) p.svc.updateCharacteristic(C.On, this.isOn() && m === p.mode);
  }
}
