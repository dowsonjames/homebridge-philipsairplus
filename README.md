# homebridge-philips-air-fan

Control Philips Air+ cloud-connected fans from HomeKit, for example the **CX3550/01** Series 3000 pedestal fan.

These fans have no local API. The Philips Air+ app controls them only through the Philips cloud, so this plugin does the same.

This plugin is unofficial and isn't affiliated with Philips or Versuni. It's based on [Yooork/HA_Philips_Air_Plus](https://github.com/Yooork/HA_Philips_Air_Plus) (MIT).

## What you get in HomeKit

Each fan shows up as:

- a **fan** with on/off, speed (1–3) and oscillation
- a **Sleep Mode** switch
- a **Natural Breeze** switch

Changes made in the Home app are confirmed within a few seconds. Changes made with the fan's own buttons show up at the next state refresh, which is every 10 seconds by default.

## Setup

1. Install **Philips Air+ Fan** from the Plugins tab in the Homebridge UI.
2. Open the plugin's **Settings**. Sign-in takes three steps:
   1. **Choose the Philips Air+ app file.** The cloud only accepts requests signed with a value built into the Android app (`com.philips.ph.homecare`), so you need a copy of the APK, either from your own device or from a mirror. The settings screen reads the value in your browser and doesn't upload the file.
   2. **Enter your Philips account email.**
   3. **Enter the 6-digit code** Philips emails you.
3. Your fans are listed. Turn off any you don't want in HomeKit, save, and restart the plugin.

The fan must already be set up in the Philips Air+ app.

### Without the Homebridge UI

Run `npx philips-air-fan-setup /path/to/philips-air.apk` and follow the prompts. Then add the printed block to `platforms` in your `config.json`:

```json
{
  "platform": "PhilipsAirFan",
  "name": "Philips Air+",
  "userId": "…",
  "mSecret": "a_…"
}
```

## Options

| Option | Default | Description |
|---|---|---|
| `refreshSeconds` | `10` | How often to re-read the fan's state, from 5 to 300 seconds. |
| `ignore` | `[]` | Device IDs to hide from HomeKit. The settings screen manages this for you. |

## Known limitations

- **Close the Philips Air+ phone app while Homebridge is running.** The cloud allows one live connection per account, so the app and Homebridge disconnect each other. The plugin reconnects on its own when the app closes.
- Only fans are supported. Philips Air+ purifiers and humidifiers use different properties.

## Licence

MIT
