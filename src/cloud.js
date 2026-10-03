'use strict';
// Philips Air+ (gaoda / air-matters) cloud client.
// Ported from Yooork/HA_Philips_Air_Plus (MIT): airmatters_auth.py, oneid_login.py,
// device_connection.py. The fan has no local API; it is controlled through an
// AWS IoT device shadow over MQTT-over-WSS.
//
//   userId + APP_ID + mSecret -> signed getToken -> 7-day JWT
//   JWT -> deviceList, mqttInfo (single-use, 1h presigned WSS URL)
//   WSS -> $aws/things/<deviceId>/shadow/{get,update}

const crypto = require('node:crypto');
const mqtt = require('mqtt');
const { EventEmitter } = require('node:events');

const APP_ID = '9fd505fa9c7111e9a1e3061302926720'; // identifier, sent in the clear
const HOST = 'https://www.api.air.philips.com/';
const UA = 'okhttp/4.9.3';
const GIGYA_URL = 'https://cdc.accounts.home.id';
const GIGYA_API_KEY = '4_JGZWlP8eQHpEqkvQElolbA'; // identifier, not a secret

const JWT_REFRESH_MARGIN = 24 * 3600;
const RECONNECT_MIN = 2;
const RECONNECT_MAX = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hmacHex = (data, key) => crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');

// Java URLEncoder.encode(s, "utf-8"): keep alnum and -._*, space -> +, rest %XX.
function javaUrlEncode(s) {
  let out = '';
  for (const ch of s) {
    if (/^[A-Za-z0-9\-._*]$/.test(ch)) out += ch;
    else if (ch === ' ') out += '+';
    else for (const b of Buffer.from(ch, 'utf8')) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function signature(timestamp, username, mSecret) {
  const bodyParams = `app_id=${APP_ID}&timestamp=${timestamp}&username=${javaUrlEncode(username)}`;
  return hmacHex(hmacHex(bodyParams, mSecret), username);
}

function jwtSecondsLeft(jwt) {
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  return payload.exp - Date.now() / 1000;
}

// The api.air.philips.com load balancer intermittently returns 503 / non-JSON; retry like the app does.
async function apiCall(path, { method = 'GET', body, headers = {} } = {}) {
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      const res = await fetch(HOST + path, {
        method,
        headers: { 'User-Agent': UA, ...(body && { 'Content-Type': 'application/json;charset:utf-8' }), ...headers },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(70_000),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { last = `${res.status} non-JSON`; await sleep(2000); continue; }
      const code = data?.meta?.code;
      if (code === 0) return data.data;
      // 16002 "Not binding to the device" is returned intermittently for bound devices; clears on retry.
      if (res.status === 503 || code === 16002) { last = `${res.status} ${text.slice(0, 200)}`; await sleep(2000); continue; }
      throw new Error(`${path} failed: ${res.status} ${text.slice(0, 200)}`);
    } catch (e) {
      if (e.message?.includes(' failed: ')) throw e;
      last = e.message;
      await sleep(2000);
    }
  }
  throw new Error(`${path} exhausted retries: ${last}`);
}

class PhilipsCloud {
  constructor({ userId, mSecret, log }) {
    this.username = `PHILIPS:${userId}`;
    this.mSecret = mSecret;
    this.log = log;
    this.jwt = null;
  }

  async getJwt() {
    if (this.jwt && jwtSecondsLeft(this.jwt) > JWT_REFRESH_MARGIN) return this.jwt;
    this.log?.debug('Refreshing Philips Air+ JWT');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const data = await apiCall('enduser/v2/getToken/', {
      method: 'POST',
      body: { timestamp, username: this.username, app_id: APP_ID },
      headers: { Signature: signature(timestamp, this.username, this.mSecret) },
    });
    this.jwt = data.token;
    return this.jwt;
  }

  async getDevices() {
    const jwt = await this.getJwt();
    return (await apiCall('enduser/deviceList/', { headers: { Authorization: `jwt ${jwt}` } })) || [];
  }

  async getMqttInfo(deviceId) {
    const jwt = await this.getJwt();
    const data = await apiCall('enduser/v2/mqttInfo/', {
      method: 'POST',
      body: { device_id: [deviceId] },
      headers: { Authorization: `jwt ${jwt}` },
    });
    const info = data.mqttinfos.find((m) => m.device_id === deviceId);
    if (!info) throw new Error(`mqttInfo returned no entry for ${deviceId}`);
    return info;
  }
}

// One persistent shadow connection per fan. Emits 'reported' (full reported state) and 'connected'/'disconnected'.
class DeviceConnection extends EventEmitter {
  constructor(cloud, deviceId, log, refreshSeconds = 30) {
    super();
    this.cloud = cloud;
    this.deviceId = deviceId;
    this.log = log;
    this.refreshSeconds = refreshSeconds;
    this.client = null;
    this.connected = false;
    this.stopping = false;
    this.delay = RECONNECT_MIN;
    this.reconnectTimer = null;
    this.refreshTimer = null;
    this.confirmTimers = [];
    const base = `$aws/things/${deviceId}/shadow`;
    this.topics = {
      get: `${base}/get`,
      update: `${base}/update`,
      subscribe: [`${base}/get/accepted`, `${base}/get/rejected`, `${base}/update/rejected`, `${base}/update/documents`],
    };
  }

  async connect() {
    if (this.stopping) return;
    this.teardown();
    let info;
    try {
      info = await this.cloud.getMqttInfo(this.deviceId);
    } catch (e) {
      this.log.warn(`[${this.deviceId}] mqttInfo failed: ${e.message}`);
      return this.scheduleReconnect();
    }
    const host = (info.endpoint || info.host).replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
    // The presigned URL is single-use, so mqtt.js auto-reconnect is disabled and we fetch a new one each time.
    const client = mqtt.connect(`wss://${host}${info.path}`, {
      clientId: info.client_id,
      protocolVersion: 4,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 0,
      connectTimeout: 30_000,
    });
    this.client = client;

    client.on('connect', () => {
      this.connected = true;
      this.delay = RECONNECT_MIN;
      this.log.debug(`[${this.deviceId}] connected`);
      client.subscribe(this.topics.subscribe, { qos: 1 }, () => this.requestState());
      // The device doesn't reliably push changes made with its physical buttons, so poll.
      this.refreshTimer = setInterval(() => this.requestState(), this.refreshSeconds * 1000);
      this.emit('connected');
    });
    client.on('message', (topic, payload) => this.onMessage(topic, payload));
    client.on('error', (e) => this.log.debug(`[${this.deviceId}] mqtt error: ${e.message}`));
    client.on('close', () => {
      const was = this.connected;
      this.connected = false;
      clearInterval(this.refreshTimer);
      if (client !== this.client) return;
      if (was) {
        this.log.info(`[${this.deviceId}] disconnected (the Philips phone app being open can cause this)`);
        this.emit('disconnected');
      }
      this.scheduleReconnect();
    });
  }

  onMessage(topic, payload) {
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
    if (topic.endsWith('/get/accepted')) return this.emitReported(msg?.state?.reported);
    if (topic.endsWith('/update/documents')) return this.emitReported(msg?.current?.state?.reported);
    if (topic.endsWith('/rejected')) this.log.warn(`[${this.deviceId}] shadow request rejected: ${JSON.stringify(msg)}`);
  }

  emitReported(reported) {
    if (reported && typeof reported === 'object') this.emit('reported', reported);
  }

  requestState() {
    if (this.connected) this.client.publish(this.topics.get, '{}', { qos: 1 });
  }

  async setDesired(desired) {
    if (!this.connected) {
      await this.connect();
      for (let i = 0; i < 50 && !this.connected; i++) await sleep(200);
      if (!this.connected) throw new Error('fan not connected to Philips cloud');
    }
    this.log.debug(`[${this.deviceId}] desired ${JSON.stringify(desired)}`);
    this.client.publish(this.topics.update, JSON.stringify({ state: { desired } }), { qos: 1 });
    // Re-read soon after a command so the confirmed state lands without waiting for the next poll.
    this.confirmTimers.forEach(clearTimeout);
    this.confirmTimers = [1500, 4000].map((ms) => setTimeout(() => this.requestState(), ms));
  }

  scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const delay = this.delay;
    this.delay = Math.min(this.delay * 2, RECONNECT_MAX);
    this.log.debug(`[${this.deviceId}] reconnecting in ${delay}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay * 1000);
  }

  teardown() {
    clearInterval(this.refreshTimer);
    this.confirmTimers.forEach(clearTimeout);
    if (this.client) {
      const c = this.client;
      this.client = null;
      c.end(true);
    }
    this.connected = false;
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.teardown();
  }
}

// Email + OTP login against Philips' Gigya backend. The returned UID is the gaoda user id.
async function gigya(path, params) {
  const res = await fetch(`${GIGYA_URL}/${path}`, {
    method: 'POST',
    body: new URLSearchParams({ ...params, apiKey: GIGYA_API_KEY, format: 'json' }),
  });
  return res.json();
}

async function requestOtp(email) {
  const data = await gigya('accounts.auth.otp.email.sendCode', { email });
  if (data.errorCode !== 0 || !data.vToken) throw new Error(data.errorMessage || JSON.stringify(data));
  return data.vToken;
}

async function verifyOtp(email, code, vToken) {
  const data = await gigya('accounts.auth.otp.email.login', { email, code, vToken });
  if (data.errorCode === 206001) throw new Error('Account pending registration: sign in once in the Philips Air+ app first.');
  if (data.errorCode !== 0 || !data.UID) throw new Error(data.errorMessage || JSON.stringify(data));
  return data.UID;
}

module.exports = { PhilipsCloud, DeviceConnection, requestOtp, verifyOtp, signature, javaUrlEncode };
