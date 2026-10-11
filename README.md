# Instrument Lights for Signal K

[![SignalK Plugin CI](https://github.com/joabakk/signalk-instrument-light-plugin/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/joabakk/signalk-instrument-light-plugin/actions/workflows/signalk-ci.yml)
[![npm](https://img.shields.io/npm/v/signalk-instrument-light-plugin)](https://www.npmjs.com/package/signalk-instrument-light-plugin)

A [Signal K](https://signalk.org) server plugin that dims and brightens your instrument backlights automatically, following the sun.

Once a day the plugin reads the boat's position and works out when the sun will move from one phase of the day to the next over the coming 24 hours. It stores those times and switches your instruments to the light level you chose for each phase exactly when it begins:

| Phase | Sun elevation |
|---|---|
| Day | above the horizon |
| Civil twilight | 0–6° below the horizon |
| Nautical twilight | 6–12° below the horizon |
| Astronomical twilight | 12–18° below the horizon |
| Night | more than 18° below the horizon |

Each phase can be set to **off**, **dim**, **on** or **bright**. The level is resent every 30 seconds so instruments that were switched on later pick it up too.

The plugin status shows the current phase and the next change, for example *Civil twilight: lights dim, next: Day at 07:12*. Near the poles, where the sun may not cross a boundary for days, the lights stay in the current phase until it does. If the server's clock changes, for example when a Raspberry Pi sets its time from GPS after starting, the times are worked out again.

![Plugin configuration](./docs/screenshot-config.png)

## Supported instruments

- **Raymarine Seatalk1** – sends the lamp intensity datagram (`30 00 0X`) as a `$STALK` sentence, for a Seatalk1 gateway that understands them, such as a Shipmodul MiniPlex.
- **Silva, Nexus and Garmin (FDX)** – writes the FDX backlight command to a serial port, for example a Garmin GND10 or a Nexus server connected over USB.

## Setup

1. Install **Instrument Lights** from the App Store in the Signal K admin UI.
2. Open *Server → Plugin Config → Instrument lights* and enable it.
3. Set a light level for each phase of the day.
4. Turn on the outputs you need:
   - **Seatalk1:** enter the output event name, and set the same name as an output event (`toStdout`) on the serial data connection to your Seatalk1 gateway.
   - **FDX:** pick the serial port of your FDX interface, or choose *[Enter Manually]* and type its path.
5. Optionally enter a default position. It is used when the server has no `navigation.position`, for example at the dock without GPS.

![Light levels](./docs/screenshot-light-levels.png)

The plugin's status line in the admin UI shows the current phase and light level, for example *Civil twilight: lights dim*.

## Signal K data

The plugin publishes:

| Path | Value |
|---|---|
| `environment.mode` | `day`, `Civil twilight`, `Nautical twilight`, `Astronomical twilight` or `night` |
| `navigation.sun.elevation` | Sun elevation above the horizon (rad) |

## Development

```bash
npm install
npm test
```

The tests use Node's built-in test runner and need Node.js 20 or newer. See the [changelog](./CHANGELOG.md) for release notes.

## License

Apache-2.0
