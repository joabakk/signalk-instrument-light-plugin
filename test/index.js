const { describe, it, beforeEach, afterEach, mock } = require('node:test')
const assert = require('node:assert/strict')
const { SerialPortMock } = require('serialport')

const createPluginForApp = require('..')
const { createPlugin, sunPhase, seatalkSentence, fdxCommand, withDefaults, baseSchema } = createPluginForApp

// Equinox at 0°N 0°E: the sun is almost overhead at noon and far below
// the horizon at midnight
const NOON = Date.UTC(2024, 2, 20, 12, 0)
const MIDNIGHT = Date.UTC(2024, 2, 20, 0, 0)
const EQUATOR = { latitude: 0, longitude: 0 }

function fakeApp ({ position, serialports } = {}) {
  const app = {
    deltas: [],
    emitted: [],
    status: undefined,
    error: undefined,
    debug: () => {},
    getSelfPath: path => (path === 'navigation.position.value' ? position : undefined),
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
    assert.equal(props.UpdateInterval, 30)
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
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOON })
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
    assert.equal(app.status, 'day: lights dim')
  })

  it('sends the Seatalk1 level for the current phase and repeats it', () => {
    const app = fakeApp({ position: EQUATOR })
    plugin = createPlugin(app)
    plugin.start({ ...levels, Seatalk1: { seatalkBool: true, seatalkOutput: 'st1' } })
    assert.deepEqual(app.emitted, [{ event: 'st1', value: '$STALK,30,00,04*6A' }])

    mock.timers.tick(30 * 1000)
    assert.equal(app.emitted.length, 2)

    plugin.stop()
    mock.timers.tick(60 * 1000)
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
    mock.timers.tick(12 * 60 * 60 * 1000)
    assert.equal(deltaValue(app, 'environment.mode'), 'day')
    assert.deepEqual(app.emitted.at(-1), { event: 'seatalkOut', value: '$STALK,30,00,00*6E' })
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
    mock.timers.tick(30 * 1000)
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
    mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOON })
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
