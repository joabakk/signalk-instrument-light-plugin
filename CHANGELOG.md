# Changelog

## 0.8.0

### Changed

- The position is read and the sun's phase changes for the next 24 hours are worked out once a day, instead of checking the sun every 30 minutes. The plugin stores the time of each change (astronomical, nautical and civil twilight, day and night) and switches the lights exactly when it happens, rather than up to 30 minutes late.
- The plugin status shows the next phase change and its time.
- The schedule is worked out again when the system clock changes, for example when a Raspberry Pi sets its time from GPS.

### Removed

- The *Interval to check for change in daylight* setting, which is no longer needed.

## 0.7.1

### Changed

- `serialport` is now an optional dependency, loaded only when FDX output is enabled. This passes the Signal K plugin CI App Store install check. Seatalk1-only setups no longer need serialport, and FDX keeps working because serialport ships prebuilt binaries.

## 0.7.0

### Fixed

- The plugin installs and loads on current Node.js and Signal K server versions. `serialport` is upgraded from 9 to 12, which ships prebuilt binaries instead of compiling a native addon at install time.
- Seatalk1 output now sends the `$STALK` lamp intensity sentence on the configured output event. Before, it emitted the event name and never sent the command.
- An FDX serial port that is missing or fails to open is reported as a plugin error instead of crashing the server.
- Stopping or restarting the plugin closes the FDX serial port, so it can be reopened.
- The plugin starts with an empty or partial configuration and fills in the defaults.
- Lights are set as soon as the plugin starts instead of after the first check interval (30 minutes by default).
- A default position at latitude or longitude 0 is accepted.

### Added

- The plugin status shows the current sun phase and light level, for example "Civil twilight: lights dim".
- A test suite that runs with `npm test` and no extra dependencies.
- Signal K plugin CI, a changelog, screenshots and an icon for the App Store.

### Removed

- Unused dependencies: `lodash`, `react`, `react-jsonschema-form` and `snyk`.
- Support for Node.js versions older than 20.

## 0.6.0

Tagged on GitHub but not published to npm. Its changes are included in 0.7.0.

## 0.5.2

- Fix position logic.
