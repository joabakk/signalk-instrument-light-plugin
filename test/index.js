const { describe, it, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert/strict')
const { SerialPortMock } = require('serialport')
const SunCalc = require('suncalc')

const createPluginForApp = require('..')
const { createPlugin, sunPhase, sunSchedule, seatalkSentence, fdxCommand, withDefaults, baseSchema } = createPluginForApp

// Equinox at 0°N 0°E: the sun is almost overhead at noon and far below
// the horizon at midnight
const NOON = Date.UTC(2024, 2, 20, 12, 0)
const MIDNIGHT = Date.UTC(2024, 2, 20, 0, 0)
const EQUATOR = { latitude: 0, longitude: 0 }
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function fakeApp ({ position, serialports } = {}) {
  const app = {
    position,
    positionReads: 0,
    deltas: [],
    emitted: [],
    status: undefined,
    error: undefined,
    debug: () => {},
    getSelfPath: path => {
      if (path !== 'navigation.position.value') return undefined
      app.positionReads++
      return app.position
    },
    handleMessage: (id, delta) => app.deltas.push(delta),
    emit: (event, value) => app.emitted.push({ event, value }),
    setPluginStatus: msg => { app.status = msg },
    setPluginError: msg => { app.error = msg },
    getSerialPorts: () => serialports instanceof Error
      ? Promise.reject(serialports)
      : Promise.resolve({ serialports: serialports || [] })
  }
  return app
}

function deltaValue (app, path) {
  const values = app.deltas.flatMap(delta => delta.updates.flatMap(update => update.values))
  const found = values.filter(value => value.path === path)
  return found.length ? found[found.length - 1].value : undefined
}

const levels = { Day: 1, Civil: 2, Nautical: 3, Astronomical: 3, Night: 3 }

// Advance the mocked clock like a real one. A single mock.timers.tick runs
// every due callback with Date already at the end of the tick, which the
// plugin would take for a jump of the system clock.
function advance (ms) {
  while (ms > 0) {
    const step = Math.min(ms, 30 * 1000)
    mock.timers.tick(step)
    ms -= step
  }
}

describe('sunPhase', () => {
  it('maps sun elevation to the configured phase', () => {
    assert.equal(sunPhase(45).setting, 'Day')
    assert.equal(sunPhase(0.1).setting, 'Day')
    assert.equal(sunPhase(0).setting, 'Civil')
    assert.equal(sunPhase(-5.9).setting, 'Civil')
    assert.equal(sunPhase(-6).setting, 'Nautical')
    assert.equal(sunPhase(-11).setting, 'Nautical')
    assert.equal(sunPhase(-12).setting, 'Astronomical')
    assert.equal(sunPhase(-17).setting, 'Astronomical')
    assert.equal(sunPhase(-18).setting, 'Night')
    assert.equal(sunPhase(-90).setting, 'Night')
  })
})

function elevationDegrees (time, lat, lon) {
  return SunCalc.getPosition(time, lat, lon).altitude * 180 / Math.PI
}

describe('sunSchedule', () => {
  it('lists every phase change of the next 24 hours in order', () => {
    const from = new Date(MIDNIGHT)
    const changes = sunSchedule(from, new Date(MIDNIGHT + DAY), 0, 0)
    assert.deepEqual(changes.map(change => change.phase.setting),
      ['Astronomical', 'Nautical', 'Civil', 'Day', 'Civil', 'Nautical', 'Astronomical', 'Night'])
    for (const change of changes) {
      assert.ok(change.time > from && change.time <= new Date(MIDNIGHT + DAY))
    }
  })

  it('covers windows longer than a day', () => {
    const changes = sunSchedule(new Date(NOON - DAY), new Date(NOON + DAY), 0, 0)
    assert.equal(changes.length, 16)
    assert.ok(changes.at(-1).time > new Date(NOON + 6 * HOUR))
  })

  it('places each change where the sun crosses the phase boundary', () => {
    // Oslo, where the sun goes through every phase in March
    const [lat, lon] = [59.91, 10.75]
    const rising = { Astronomical: -18, Nautical: -12, Civil: -6, Day: 0 }
    const setting = { Civil: 0, Nautical: -6, Astronomical: -12, Night: -18 }
    const changes = sunSchedule(new Date(NOON), new Date(NOON + DAY), lat, lon)
    assert.equal(changes.length, 8)
    for (const change of changes) {
      const minuteLater = new Date(change.time.getTime() + 60 * 1000)
      const isRising = elevationDegrees(minuteLater, lat, lon) > elevationDegrees(change.time, lat, lon)
      const boundary = (isRising ? rising : setting)[change.phase.setting]
      // SunCalc's event times and sun positions agree to about a minute
      assert.ok(Math.abs(elevationDegrees(change.time, lat, lon) - boundary) < 0.3,
        `${change.phase.setting} at ${change.time.toISOString()}`)
      // a minute later the sun is in the new phase
      assert.equal(sunPhase(elevationDegrees(minuteLater, lat, lon)), change.phase)
    }
  })

  it('leaves out boundaries the sun never crosses near the poles', () => {
    const midsummer = Date.UTC(2024, 5, 21)
    assert.deepEqual(sunSchedule(new Date(midsummer), new Date(midsummer + DAY), 78, 15), [])

    const midwinter = Date.UTC(2024, 11, 21)
    const settings = sunSchedule(new Date(midwinter), new Date(midwinter + DAY), 78, 15)
      .map(change => change.phase.setting)
    assert.ok(settings.length > 0)
    assert.ok(settings.every(s => ['Night', 'Astronomical', 'Nautical'].includes(s)), settings.join())
  })
})

describe('commands', () => {
  it('builds Seatalk1 lamp intensity sentences with checksum', () => {
    assert.equal(seatalkSentence(0), '$STALK,30,00,00*6E')
    assert.equal(seatalkSentence(1), '$STALK,30,00,04*6A')
    assert.equal(seatalkSentence(2), '$STALK,30,00,08*66')
    assert.equal(seatalkSentence(3), '$STALK,30,00,0C*1D')
  })

  it('builds FDX backlight commands', () => {
    assert.deepEqual([...fdxCommand(0)], [0x81, 0x2a, 0x01, 0x2b, 0x00, 0x00])
    assert.deepEqual([...fdxCommand(3)], [0x81, 0x2a, 0x01, 0x2b, 0x03, 0x03])
  })
})

describe('withDefaults', () => {
  it('fills an empty configuration from the schema', () => {
    const props = withDefaults(baseSchema(), {})
    assert.equal(props.Day, 0)
    assert.equal(props.Night, 0)
    assert.deepEqual(props.Seatalk1, { seatalkBool: false, seatalkOutput: 'seatalkOut' })
    assert.deepEqual(props.FDX, { fdxout: false, fdxBaud: 19200 })
    assert.deepEqual(props.position, {})
  })

  it('keeps configured values, including nested ones', () => {
    const props = withDefaults(baseSchema(), { Night: 3, FDX: { fdxout: true, serialPort: '/dev/ttyUSB0' } })
    assert.equal(props.Night, 3)
    assert.equal(props.Day, 0)
    assert.deepEqual(props.FDX, { fdxout: true, fdxBaud: 19200, serialPort: '/dev/ttyUSB0' })
  })
})

describe('schema', () => {
  it('lists the available serial ports', async () => {
    const app = fakeApp({ serialports: [{ path: '/dev/ttyUSB0', manufacturer: 'Garmin' }, { path: '/dev/ttyS0' }] })
    const schema = await createPlugin(app).schema()
    const serialPort = schema.properties.FDX.properties.serialPort
    assert.deepEqual(serialPort.enum, ['[Enter Manually]', '/dev/ttyUSB0', '/dev/ttyS0'])
    assert.deepEqual(serialPort.enumNames, ['[Enter Manually]', '/dev/ttyUSB0 Garmin', '/dev/ttyS0 '])
  })

  it('still resolves when serial ports cannot be listed', async () => {
    const schema = await createPlugin(fakeApp({ serialports: new Error('no access') })).schema()
    assert.equal(schema.type, 'object')
    assert.equal(schema.properties.Night.default, 0)
  })

  it('still resolves when the server cannot list serial ports', async () => {
    const app = fakeApp()
    delete app.getSerialPorts
    const schema = await createPlugin(app).schema()
    assert.equal(schema.type, 'object')
  })
})

describe('plugin', () => {
  let plugin

  beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: NOON })
  })

  afterEach(() => {
    if (plugin) {
      plugin.stop()
      plugin = undefined
    }
    mock.timers.reset()
  })

  it('starts and stops without any configuration', () => {
    const app = fakeApp()
    plugin = createPlugin(app)
    plugin.start({})
    assert.equal(app.status, 'Waiting for position')
    assert.equal(app.error, undefined)
    assert.deepEqual(app.deltas, [])
  })

  it('publishes the sun phase and elevation', () => {
    const app = fakeApp({ position: EQUATOR })
    plugin = createPlugin(app)
    plugin.start({ ...levels })
    assert.equal(deltaValue(app, 'environment.mode'), 'day')
    assert.ok(deltaValue(app, 'navigation.sun.elevation') > 1.5)
    assert.match(app.status, /^day: lights dim, next: Civil twilight at \d\d:\d\d$/)
  })

  it('sends the Seatalk1 level for the current phase and repeats it', () => {
    const app = fakeApp({ position: EQUATOR })
    plugin = createPlugin(app)
    plugin.start({ ...levels, Seatalk1: { seatalkBool: true, seatalkOutput: 'st1' } })
    assert.deepEqual(app.emitted, [{ event: 'st1', value: '$STALK,30,00,04*6A' }])

    advance(30 * 1000)
    assert.equal(app.emitted.length, 2)

    plugin.stop()
    advance(60 * 1000)
    assert.equal(app.emitted.length, 2)
  })

  it('changes level when the phase changes', () => {
    mock.timers.setTime(MIDNIGHT)
    const app = fakeApp({ position: EQUATOR })
    plugin = createPlugin(app)
    plugin.start({ ...levels, Day: 0, Seatalk1: { seatalkBool: true } })
    assert.equal(deltaValue(app, 'environment.mode'), 'night')
    assert.deepEqual(app.emitted.at(-1), { event: 'seatalkOut', value: '$STALK,30,00,0C*1D' })

    // twelve hours later, at the next check
    advance(12 * 60 * 60 * 1000)
    assert.equal(deltaValue(app, 'environment.mode'), 'day')
    assert.deepEqual(app.emitted.at(-1), { event: 'seatalkOut', value: '$STALK,30,00,00*6E' })
  })

  it('switches at each stored phase change', () => {
    mock.timers.setTime(MIDNIGHT)
    const app = fakeApp({ position: EQUATOR })
    plugin = createPlugin(app)
    plugin.start({ ...levels })
    assert.equal(deltaValue(app, 'environment.mode'), 'night')

    for (const change of sunSchedule(new Date(MIDNIGHT), new Date(MIDNIGHT + DAY), 0, 0)) {
      advance(change.time - Date.now() - 1000)
      assert.notEqual(deltaValue(app, 'environment.mode'), change.phase.mode)
      advance(1000)
      assert.equal(deltaValue(app, 'environment.mode'), change.phase.mode)
    }
  })

  it('shows the next phase change in the status', () => {
    mock.timers.setTime(MIDNIGHT)
    const app = fakeApp({ position: EQUATOR })
    plugin = createPlugin(app)
    plugin.start({ ...levels })
    assert.match(app.status, /^night: lights bright, next: Astronomical twilight at \d\d:\d\d$/)
  })

  it('reads the position once a day', () => {
    const app = fakeApp({ position: EQUATOR })
    plugin = createPlugin(app)
    plugin.start({ ...levels })
    assert.equal(app.positionReads, 1)
    advance(DAY - 1000)
    assert.equal(app.positionReads, 1)
    advance(1000)
    assert.equal(app.positionReads, 2)
  })

  it('retries every minute until there is a position', () => {
    const app = fakeApp()
    plugin = createPlugin(app)
    plugin.start({ ...levels })
    assert.equal(app.status, 'Waiting for position')
    advance(60 * 1000)
    assert.equal(app.positionReads, 2)

    app.position = EQUATOR
    advance(60 * 1000)
    assert.equal(deltaValue(app, 'environment.mode'), 'day')
    advance(HOUR)
    assert.equal(app.positionReads, 3)
  })

  it('recomputes the schedule when the system clock jumps', () => {
    const app = fakeApp({ position: EQUATOR })
    plugin = createPlugin(app)
    plugin.start({ ...levels })
    assert.equal(deltaValue(app, 'environment.mode'), 'day')

    // e.g. a Raspberry Pi setting its clock from GPS twelve hours later
    mock.timers.setTime(NOON + 12 * HOUR)
    mock.timers.tick(30 * 1000)
    assert.equal(deltaValue(app, 'environment.mode'), 'night')
    assert.equal(app.positionReads, 2)
  })

  it('starts in the phase of the last change, even right at a boundary', () => {
    // SunCalc's event times and sun positions differ by up to a minute; start
    // just after astronomical dawn in Oslo, when the sun's computed elevation
    // is still below -18°
    const oslo = { latitude: 59.91, longitude: 10.75 }
    const [dawn] = sunSchedule(new Date(Date.UTC(2024, 2, 21)), new Date(Date.UTC(2024, 2, 21, 12)), 59.91, 10.75)
    assert.equal(dawn.phase.setting, 'Astronomical')
    mock.timers.setTime(dawn.time.getTime() + 5 * 1000)
    assert.ok(elevationDegrees(new Date(), 59.91, 10.75) < -18)

    const app = fakeApp({ position: oslo })
    plugin = createPlugin(app)
    plugin.start({ ...levels })
    assert.equal(deltaValue(app, 'environment.mode'), 'Astronomical twilight')
  })

  it('uses the default position when the boat has none', () => {
    mock.timers.setTime(MIDNIGHT)
    const app = fakeApp()
    plugin = createPlugin(app)
    plugin.start({ ...levels, position: { lat: 0, lon: 0 } })
    assert.equal(deltaValue(app, 'environment.mode'), 'night')
  })

  it('reports an invalid light level instead of crashing', () => {
    const app = fakeApp({ position: EQUATOR })
    plugin = createPlugin(app)
    plugin.start({ Day: 7, Seatalk1: { seatalkBool: true } })
    assert.match(app.error, /Invalid light level 7 for Day/)
    assert.deepEqual(app.emitted, [])
  })

  it('reports FDX output without a serial port instead of crashing', () => {
    const app = fakeApp({ position: EQUATOR })
    plugin = createPlugin(app)
    plugin.start({ FDX: { fdxout: true } })
    assert.match(app.error, /no serial port is configured/)
    advance(30 * 1000)
  })
})

describe('FDX serial output', () => {
  const path = '/dev/ttyFDX'
  let ports

  class TestPort extends SerialPortMock {
    constructor (options) {
      super(options)
      ports.push(this)
    }
  }

  beforeEach(() => {
    ports = []
    SerialPortMock.binding.createPort(path, { record: true })
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: NOON })
  })

  afterEach(() => {
    mock.timers.reset()
    SerialPortMock.binding.reset()
  })

  function written (port) {
    return new Promise((resolve, reject) => port.drain(err => err ? reject(err) : resolve([...port.port.recording])))
  }

  it('writes the FDX level for the current phase to the serial port', async () => {
    const app = fakeApp({ position: EQUATOR })
    const plugin = createPlugin(app, { SerialPort: TestPort })
    plugin.start({ ...levels, FDX: { fdxout: true, serialPort: path, fdxBaud: 4800 } })

    assert.equal(ports.length, 1)
    assert.equal(ports[0].baudRate, 4800)
    assert.deepEqual(await written(ports[0]), [...fdxCommand(1)])

    plugin.stop()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(ports[0].isOpen, false)
  })

  it('uses the manually entered serial port', async () => {
    const app = fakeApp({ position: EQUATOR })
    const plugin = createPlugin(app, { SerialPort: TestPort })
    plugin.start({ ...levels, FDX: { fdxout: true, serialPort: '[Enter Manually]', manualSerialPort: path } })
    assert.equal(ports[0].path, path)
    assert.deepEqual(await written(ports[0]), [...fdxCommand(1)])
    plugin.stop()
  })

  it('loads serialport on demand and reports a missing device', async () => {
    const app = fakeApp({ position: EQUATOR })
    const plugin = createPlugin(app)
    plugin.start({ FDX: { fdxout: true, serialPort: '/dev/does-not-exist' } })
    await new Promise(resolve => {
      const poll = () => app.error ? resolve() : setImmediate(poll)
      poll()
    })
    assert.match(app.error, /FDX serial port \/dev\/does-not-exist/)
    plugin.stop()
  })

  it('reports a serial port that cannot be opened', async () => {
    const app = fakeApp({ position: EQUATOR })
    const plugin = createPlugin(app, { SerialPort: TestPort })
    plugin.start({ FDX: { fdxout: true, serialPort: '/dev/missing' } })
    await new Promise(resolve => ports[0].once('error', resolve))
    assert.match(app.error, /FDX serial port \/dev\/missing/)
    plugin.stop()
  })
})
