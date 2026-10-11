const SunCalc = require('suncalc')

const PLUGIN_ID = 'signalk-instrument-light-plugin'

const LEVELS = ['off', 'dim', 'on', 'bright']

// Seatalk1 datagram 30 00 0X: Set Lamp Intensity, X=0 off, X=4: 1, X=8: 2, X=C: 3
const SEATALK = ['30,00,00', '30,00,04', '30,00,08', '30,00,0C']

// FDX (Silva/Nexus/Garmin GND10) backlight commands
const FDX = ['812A012B0000', '812A012B0101', '812A012B0202', '812A012B0303']

// Resend the current level regularly to make sure the instruments pick it up
const REPEAT_INTERVAL = 30 * 1000

// Position is read and the sun schedule computed once a day, or every
// minute while there is no position yet
const DAY = 24 * 60 * 60 * 1000
const POSITION_RETRY = 60 * 1000

// A resend arriving this far off its expected time means the system clock
// was set (e.g. from GPS on a Raspberry Pi), so the schedule is recomputed
const CLOCK_JUMP = 60 * 1000

// Sun phases from highest to lowest: the lower bound of the sun's elevation
// in degrees, the config key holding the light level and the value
// published to environment.mode
const PHASES = [
  { above: 0, setting: 'Day', mode: 'day' },
  { above: -6, setting: 'Civil', mode: 'Civil twilight' },
  { above: -12, setting: 'Nautical', mode: 'Nautical twilight' },
  { above: -18, setting: 'Astronomical', mode: 'Astronomical twilight' },
  { above: -Infinity, setting: 'Night', mode: 'night' }
]

function sunPhase (elevationDegrees) {
  return PHASES.find(phase => elevationDegrees > phase.above)
}

function phaseAt (time, lat, lon) {
  const elevation = SunCalc.getPosition(time, lat, lon).altitude
  return sunPhase(elevation * 180 / Math.PI)
}

// SunCalc's sunrise and sunset are for the sun's upper edge (-0.833°);
// add the sun's centre crossing 0°, which is where the Day phase starts
if (!SunCalc.times.some(([, rise]) => rise === 'centreRise')) {
  SunCalc.addTime(0, 'centreRise', 'centreSet')
}

// SunCalc times at which the sun crosses a phase boundary, and the phase
// that starts there
const SUN_EVENTS = [
  { time: 'nightEnd', setting: 'Astronomical' },
  { time: 'nauticalDawn', setting: 'Nautical' },
  { time: 'dawn', setting: 'Civil' },
  { time: 'centreRise', setting: 'Day' },
  { time: 'centreSet', setting: 'Civil' },
  { time: 'dusk', setting: 'Nautical' },
  { time: 'nauticalDusk', setting: 'Astronomical' },
  { time: 'night', setting: 'Night' }
]

// The phase changes after `from` up to and including `until`, sorted by
// time. Near the poles some boundaries are never crossed and are left out.
function sunSchedule (from, until, lat, lon) {
  const changes = []
  // SunCalc gives the times for the solar day around a date; ask for every
  // day the window touches, with a day of margin on each side
  for (let day = from.getTime() - DAY; day <= until.getTime() + DAY; day += DAY) {
    const times = SunCalc.getTimes(new Date(day), lat, lon)
    for (const event of SUN_EVENTS) {
      const time = times[event.time]
      if (!isNaN(time) && time > from && time <= until) {
        changes.push({ time, phase: PHASES.find(phase => phase.setting === event.setting) })
      }
    }
  }
  changes.sort((a, b) => a.time - b.time)
  // neighbouring days can report the same crossing
  return changes.filter((change, i) =>
    i === 0 || change.phase !== changes[i - 1].phase || change.time - changes[i - 1].time > 60 * 1000)
}

function formatTime (time) {
  return time.toTimeString().slice(0, 5)
}

function levelSetting (title) {
  return {
    title,
    type: 'number',
    default: 0,
    enum: [0, 1, 2, 3],
    enumNames: LEVELS
  }
}

function baseSchema () {
  return {
    title: 'Plugin to control proprietary instrument lights',
    type: 'object',
    properties: {
      position: {
        title: 'Default position (used when navigation.position is unavailable)',
        type: 'object',
        properties: {
          lat: { title: 'Latitude', type: 'number' },
          lon: { title: 'Longitude', type: 'number' }
        }
      },
      Seatalk1: {
        title: 'Seatalk1 instruments',
        type: 'object',
        properties: {
          seatalkBool: { title: 'Seatalk 1', type: 'boolean', default: false },
          seatalkOutput: {
            title: 'Seatalk output event name (the "toStdout" event of the Seatalk connection)',
            type: 'string',
            default: 'seatalkOut'
          }
        }
      },
      FDX: {
        title: 'Silva/Nexus/Garmin instruments (FDX)',
        type: 'object',
        properties: {
          fdxout: { title: 'Silva/Nexus/Garmin instruments (FDX)', type: 'boolean', default: false },
          fdxBaud: { title: 'Baud rate for FDX', type: 'number', default: 19200 },
          serialPort: { title: 'Serial Port for FDX protocol (eg. GND10)', type: 'string' },
          manualSerialPort: { title: 'Manual Serial Port for FDX protocol (eg. GND10)', type: 'string' }
        }
      },
      Day: levelSetting('Display lights during day (sun above horizon)'),
      Civil: levelSetting('Display lights during civil twilight (0-6 deg below horizon)'),
      Nautical: levelSetting('Display lights during nautical twilight (6-12 deg below horizon)'),
      Astronomical: levelSetting('Display lights during astronomical twilight (12-18 deg below horizon)'),
      Night: levelSetting('Display lights on during night (sun below 18 deg)')
    }
  }
}

// Fill in schema defaults for anything missing from the saved configuration
function withDefaults (schema, config) {
  const result = { ...config }
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.type === 'object' && prop.properties) {
      result[key] = withDefaults(prop, config && typeof config[key] === 'object' ? config[key] : {})
    } else if (result[key] === undefined && 'default' in prop) {
      result[key] = prop.default
    }
  }
  return result
}

function computeChecksum (sentence) {
  let checksum = 0
  // skip the $
  for (let i = 1; i < sentence.length; i++) {
    checksum ^= sentence.charCodeAt(i)
  }
  return '*' + checksum.toString(16).toUpperCase().padStart(2, '0')
}

function seatalkSentence (level) {
  const base = '$STALK,' + SEATALK[level]
  return base + computeChecksum(base)
}

function fdxCommand (level) {
  return Buffer.from(FDX[level], 'hex')
}

// serialport is an optional dependency, only needed for FDX output
function loadSerialPort () {
  return require('serialport').SerialPort
}

function createPlugin (app, { SerialPort: Port } = {}) {
  const plugin = {}
  let props
  let serialPort
  let position
  // phase changes for the next 24 hours, as { time, phase }
  let schedule = []
  let timers = []
  let repeatTimer
  let lastSend

  function setError (msg) {
    if (app.setPluginError) {
      app.setPluginError(msg)
    } else {
      app.error(msg)
    }
  }

  function setStatus (msg) {
    if (app.setPluginStatus) {
      app.setPluginStatus(msg)
    }
  }

  function currentPosition () {
    const position = app.getSelfPath('navigation.position.value')
    if (position && typeof position.latitude === 'number' && typeof position.longitude === 'number') {
      return { lat: position.latitude, lon: position.longitude }
    }
    if (typeof props.position.lat === 'number' && typeof props.position.lon === 'number') {
      app.debug('using default position')
      return props.position
    }
    return undefined
  }

  function openSerialPort () {
    const path = props.FDX.serialPort === '[Enter Manually]' ? props.FDX.manualSerialPort : props.FDX.serialPort
    if (!path) {
      setError('FDX output is enabled but no serial port is configured')
      return
    }
    app.debug('Serial Port is %s', path)
    if (!Port) {
      try {
        Port = loadSerialPort()
      } catch (err) {
        setError(`FDX output needs the serialport package, which could not be loaded: ${err.message}`)
        return
      }
    }
    serialPort = new Port({ path, baudRate: props.FDX.fdxBaud, parity: 'none' })
    serialPort.on('error', err => setError(`FDX serial port ${path}: ${err.message}`))
  }

  function send (level) {
    if (props.Seatalk1.seatalkBool) {
      const sentence = seatalkSentence(level)
      app.debug('%s: %s', props.Seatalk1.seatalkOutput, sentence)
      app.emit(props.Seatalk1.seatalkOutput, sentence)
    }
    if (serialPort) {
      const buffer = fdxCommand(level)
      app.debug('writing %s to FDX', buffer.toString('hex'))
      serialPort.write(buffer, err => {
        if (err) {
          app.debug('Error while sending message: ' + err)
        }
      })
    }
  }

  function publishElevation () {
    const elevation = SunCalc.getPosition(new Date(), position.lat, position.lon).altitude
    app.handleMessage(PLUGIN_ID, {
      updates: [{
        values: [{
          path: 'navigation.sun.elevation',
          value: elevation,
          meta: { units: 'rad', description: 'Sun elevation above horizon' }
        }]
      }]
    })
  }

  // Resend the level, and recompute the schedule if the clock has jumped
  function repeat (level) {
    const now = Date.now()
    const jump = Math.abs(now - lastSend - REPEAT_INTERVAL)
    if (jump > CLOCK_JUMP) {
      app.debug('clock changed by %s s, recomputing the sun schedule', Math.round(jump / 1000))
      plan()
      return
    }
    lastSend = now
    publishElevation()
    send(level)
  }

  function enter (phase) {
    const level = props[phase.setting]
    app.debug('%s, lights: %s', phase.mode, level)
    app.handleMessage(PLUGIN_ID, {
      updates: [{ values: [{ path: 'environment.mode', value: phase.mode }] }]
    })
    publishElevation()

    clearInterval(repeatTimer)
    if (!(level in SEATALK)) {
      setError(`Invalid light level ${level} for ${phase.setting}`)
      return
    }
    const next = schedule.find(change => change.time > new Date())
    setStatus(`${phase.mode}: lights ${LEVELS[level]}` +
      (next ? `, next: ${next.phase.mode} at ${formatTime(next.time)}` : ''))

    lastSend = Date.now()
    send(level)
    repeatTimer = setInterval(() => repeat(level), REPEAT_INTERVAL)
  }

  function clearTimers () {
    timers.forEach(clearTimeout)
    timers = []
    clearInterval(repeatTimer)
  }

  // Read the position, store the phase changes for the next 24 hours and
  // set a timer for each of them
  function plan () {
    clearTimers()
    position = currentPosition()
    if (!position) {
      app.debug('Position is unknown, retrying in a minute')
      setStatus('Waiting for position')
      timers.push(setTimeout(plan, POSITION_RETRY))
      return
    }

    const now = new Date()
    const changes = sunSchedule(new Date(now.getTime() - DAY), new Date(now.getTime() + DAY), position.lat, position.lon)
    schedule = changes.filter(change => change.time > now)
    app.debug('sun schedule: %s', schedule.map(change => `${change.time.toISOString()} ${change.phase.mode}`).join(', '))

    // Take the current phase from the last change, so it always agrees with
    // the schedule. Near the poles the sun may not have crossed a boundary
    // in the past day; then use its elevation.
    const past = changes.filter(change => change.time <= now)
    enter(past.length ? past[past.length - 1].phase : phaseAt(now, position.lat, position.lon))
    for (const change of schedule) {
      timers.push(setTimeout(() => enter(change.phase), change.time - now))
    }
    timers.push(setTimeout(plan, DAY))
  }

  plugin.id = PLUGIN_ID
  plugin.name = 'Instrument lights'
  plugin.description = 'Plugin to control proprietary instrument lights'

  plugin.start = function (config) {
    app.debug('starting...')
    props = withDefaults(baseSchema(), config || {})

    if (props.FDX.fdxout) {
      openSerialPort()
    }

    plan()
    app.debug('started')
  }

  plugin.stop = function () {
    clearTimers()
    schedule = []
    if (serialPort && serialPort.isOpen) {
      serialPort.close()
    }
    serialPort = undefined
    app.debug('Stopped')
  }

  plugin.schema = function () {
    const schema = baseSchema()
    return Promise.resolve()
      .then(() => app.getSerialPorts())
      .then(ports => {
        const serialports = (ports && ports.serialports) || []
        const fdxPort = schema.properties.FDX.properties.serialPort
        fdxPort.enum = ['[Enter Manually]', ...serialports.map(port => port.path)]
        fdxPort.enumNames = ['[Enter Manually]', ...serialports.map(port => `${port.path} ${port.manufacturer || ''}`)]
        return schema
      })
      .catch(err => {
        app.debug('Could not list serial ports: ' + err)
        return schema
      })
  }

  return plugin
}

module.exports = app => createPlugin(app)
module.exports.createPlugin = createPlugin
module.exports.sunPhase = sunPhase
module.exports.sunSchedule = sunSchedule
module.exports.seatalkSentence = seatalkSentence
module.exports.fdxCommand = fdxCommand
module.exports.withDefaults = withDefaults
module.exports.baseSchema = baseSchema
