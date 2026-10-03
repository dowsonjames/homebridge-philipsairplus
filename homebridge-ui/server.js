// Backend for the custom settings screen. It runs on the Homebridge host and makes the
// Philips login/API calls for the browser, because those endpoints don't allow CORS.
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import cloud from '../src/cloud.js';

const { PhilipsCloud, requestOtp, verifyOtp } = cloud;

const MSECRET = /^a_[0-9a-f]{32}$/;

async function listDevices(userId, mSecret) {
  const devices = await new PhilipsCloud({ userId, mSecret }).getDevices();
  return devices.map((d) => ({
    id: d.device_id,
    name: d.device_info?.name || d.device_info?.device_alias || d.device_id,
    model: d.device_info?.modelid || 'unknown model',
    online: !!d.device_info?.is_online,
  }));
}

// Surface the underlying message in the UI rather than a generic failure.
const handle = (fn) => async (body) => {
  try {
    return await fn(body || {});
  } catch (e) {
    throw new RequestError(e.message, { message: e.message });
  }
};

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.onRequest('/otp/send', handle(async ({ email }) => {
      if (!email) throw new Error('Enter your Philips account email.');
      return { vToken: await requestOtp(email.trim()) };
    }));

    this.onRequest('/otp/verify', handle(async ({ email, code, vToken, mSecret }) => {
      if (!MSECRET.test(mSecret || '')) throw new Error('Missing signing value. Go back and choose the APK again.');
      const userId = await verifyOtp(email.trim(), String(code).trim(), vToken);
      return { userId, devices: await listDevices(userId, mSecret) };
    }));

    this.onRequest('/devices', handle(async ({ userId, mSecret }) => {
      if (!userId || !MSECRET.test(mSecret || '')) throw new Error('Not signed in.');
      return { devices: await listDevices(userId, mSecret) };
    }));

    this.ready();
  }
}

(() => new UiServer())();
