const SunCalc = require('suncalc')
const { SerialPort } = require('serialport')

const PLUGIN_ID = 'signalk-instrument-light-plugin'

const LEVELS = ['off', 'dim', 'on', 'bright']

// Seatalk1 datagram 30 00 0X: Set Lamp Intensity, X=0 off, X=4: 1, X=8: 2, X=C: 3
const SEATALK = ['30,00,00', '30,00,04', '30,00,08', '30,00,0C']

// FDX (Silva/Nexus/Garmin GND10) backlight commands
const FDX = ['812A012B0000', '812A012B0101', '812A012B0202', '812A012B0303']

// Resend the current level regularly to make sure the instruments pick it up
const REPEAT_INTERVAL = 30 * 1000

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
      UpdateInterval: {
        title: 'Interval to check for change in daylight (minutes)',
        type: 'number',
        default: 30
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

function createPlugin (app, { SerialPort: Port = SerialPort } = {}) {
  const plugin = {}
  let props
  let checkTimer
  let repeatTimer
  let serialPort

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

  function check () {
    const position = currentPosition()
    if (!position) {
      app.debug('Position is unknown, aborting check')
      setStatus('Waiting for position')
      return
    }

    const elevation = SunCalc.getPosition(new Date(), position.lat, position.lon).altitude
    const degrees = elevation * 180 / Math.PI
    const phase = sunPhase(degrees)
    const level = props[phase.setting]
    app.debug('sun is %s degrees above horizon, %s, lights: %s', degrees.toFixed(2), phase.mode, level)

    app.handleMessage(PLUGIN_ID, {
      updates: [{ values: [{ path: 'environment.mode', value: phase.mode }] }]
    })
    app.handleMessage(PLUGIN_ID, {
      updates: [{
        values: [{
          path: 'navigation.sun.elevation',
          value: elevation,
          meta: { units: 'rad', description: 'Sun elevation above horizon' }
        }]
      }]
    })

    if (!(level in SEATALK)) {
      setError(`Invalid light level ${level} for ${phase.setting}`)
      return
    }
    setStatus(`${phase.mode}: lights ${LEVELS[level]}`)

    clearInterval(repeatTimer)
    send(level)
    repeatTimer = setInterval(() => send(level), REPEAT_INTERVAL)
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

    const minutes = props.UpdateInterval > 0 ? props.UpdateInterval : 30
    check()
    checkTimer = setInterval(check, minutes * 60 * 1000)
    app.debug('started')
  }

  plugin.stop = function () {
    clearInterval(checkTimer)
    clearInterval(repeatTimer)
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
module.exports.seatalkSentence = seatalkSentence
module.exports.fdxCommand = fdxCommand
module.exports.withDefaults = withDefaults
module.exports.baseSchema = baseSchema
