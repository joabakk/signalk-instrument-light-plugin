const util = require('util')
const _ = require('lodash')
var SunCalc = require('suncalc')
const react = require('react/package.json') // react is a peer dependency.
const rjf = require('react-jsonschema-form')
const SerialPort = require ('serialport')

// Seatalk1:
const seaTalk = ["30,00,00", "30,00,04", "30,00,08", "30,00,0C"]
/*30  00  0X      Set Lamp Intensity: X=0 off, X=4: 1, X=8: 2, X=C: 3*/

const fdx = ["812A012B0000","812A012B0101","812A012B0202","812A012B0303"]

const pluginId = 'signalk-instrument-light-plugin';

var refresh
var altitude
var myTimer
var repeatTimer
var repeatInterval= 30000 //30 s repeats to ensure command is understood
var sPort

module.exports = function(app) {
  var unsubscribe = undefined
  var plugin = {}

  plugin.start = function(props) {
    app.debug("starting...")

    const port = props.FDX.serialPort === '[Enter Manually]' ? props.FDX.manualSerialPort : props.FDX.serialPort
    app.debug('Serial Port is %s', port)

    if (props.FDX.fdxout && port != ''){
      sPort = new SerialPort(port, {baudRate: props.FDX.fdxBaud,
        parity: 'none'}, false);
      }

      app.debug("started")
      isItTime(app, props)
    }

    plugin.stop = function() {
      clearInterval(myTimer)
      clearInterval(repeatTimer)
      if (unsubscribe) {
        unsubscribe()
      }
      app.debug("Stopped")
    }

    plugin.id = "signalk-instrument-light-plugin"
    plugin.name = "Instrument lights"
    plugin.description = "Plugin to control proprietary instrument lights"

    plugin.schema = function() {
      const schema = {
        title: "Plugin to control proprietary instrument lights",
        type: "object",
        properties: {
          position: {
            title: "Default position",
            type: "object",
            properties: {
              lat: {
                title: "Latitude",
                type: "number"
              },
              lon: {
                title: "Longitude",
                type: "number"
              }
            }
          },
          Seatalk1: {
            title: "Seatalk1 instruments",
            type: "object",
            properties: {
              seatalkBool: {
                title: "Seatalk 1",
                type: "boolean",
                default: false
              },
              seatalkOutput: {
                title: "Seatalk output name",
                type: "string",
                default: "seatalkOut"
              }
            }
          },
          FDX: {
            title: "Silva/Nexus/Garmin instruments (FDX)",
            type: "object",
            properties: {
              fdxout: {
                title: "Silva/Nexus/Garmin instruments (FDX)",
                type: "boolean",
                default: false
              },
              fdxBaud: {
                title: "Baud rate for FDX",
                type: "number",
                default: 19200
              },
              serialPort: {
                title: "Serial Port for FDX protocol (eg. GND10)",
                type: "string"
              },
              manualSerialPort: {
                title: "Manual Serial Port for FDX protocol (eg. GND10)",
                type: "string"
              }
            }
          },
          UpdateInterval: {
            title: "Interval to check for change in daylight (minutes)",
            type: "number",
            default: 30
          },
          Day: {
            title: "Display lights during day (from sunset till sunrise)",
            type: "number",
            default: 0,
            "enum": [0,1,2,3],
            "enumNames": ["off", "dim", "on", "bright"]
          },
          Civil: {
            title: "Display lights during civil twilight (0-6 deg below horizon)",
            type: "number",
            default: 0,
            "enum": [0,1,2,3],
            "enumNames": ["off", "dim", "on", "bright"]
          },
          Nautical: {
            title: "Display lights during nautical twilight (6-12 deg below horizon)",
            type: "number",
            default: 0,
            "enum": [0,1,2,3],
            "enumNames": ["off", "dim", "on", "bright"]
          },
          Astronomical: {
            title: "Display lights during astronomical twilight (12-18 deg below horizon)",
            type: "number",
            default: 0,
            "enum": [0,1,2,3],
            "enumNames": ["off", "dim", "on", "bright"]
          },
          Night: {
            title: "Display lights on during night (sun below 18 deg)",
            type: "number",
            default: 0,
            "enum": [0,1,2,3],
            "enumNames": ["off", "dim", "on", "bright"]
          },
        }
      }
      return new Promise((resolve, reject) => {
        app.getSerialPorts()
        .then(ports => {
          schema.properties.FDX.properties.serialPort.enum = [ '[Enter Manually]', ...ports.serialports.map(port=> port.path) ]
          schema.properties.FDX.properties.serialPort.enumNames = [ '[Enter Manually]', ...ports.serialports.map(port => `${port.path} ${port.manufacturer || ""}`)]
          resolve(schema)
        })
        .catch(err => {
          console.error(err)
          resolve(schema)
        })
      })
    }
    return plugin;
  }

  function isItTime (app, props){

    var minutes = props.UpdateInterval, the_interval = minutes * 60 * 1000
    myTimer = setInterval(function() {
      app.debug("I am doing my " + minutes + " minutes check")
      var now = new Date()
      var position = app.getSelfPath('navigation.position.value')
      if (position){
        lat = position.latitude
        lon = position.longitude
      }
      
      if (! position) {
        if (props.position.lat && props.position.lon){
          app.debug("using default position")
          var now = new Date()
          lat = props.position.lat
          lon = props.position.lon
        } else {
          app.debug("Position is unknown, aborting check")
          return
        }
      }

      var sunrisePos = SunCalc.getPosition(new Date(), lat, lon)
      var lightLevel

      altitude = sunrisePos.altitude * 180 / 3.14
      var mode

      app.debug("sun is " + altitude.toFixed(2) + " degrees above horizon")
      if (altitude > 0){
        app.debug("day, lights: " + props.Day)
        lightLevel = props.Day
        mode = "day"

      }
      else if (altitude < -6){
        if (altitude < -12){
          if (altitude < -18){
            app.debug("night, lights: " + props.Night)
            lightLevel = props.Night
            mode = "night"
          } else {
            app.debug("astronomical dawn/dusk, lights: " + props.Astronomical)
            lightLevel = props.Astronomical
            mode = "Astronomical twilight"
          }
        } else {
          app.debug("nautical dawn/dusk, lights: " + props.Nautical)
          lightLevel = props.Nautical
          mode = "Nautical twilight"
        }
      } else {
        app.debug("civil dawn/dusk, lights: " + props.Civil)
        lightLevel = props.Civil
        mode = "Civil twilight"
      }

      app.handleMessage(pluginId, {
        updates: [
          {
            values: [
              {
                path: 'environment.mode',
                value: mode
              }
            ]
          }
        ]
      })

      app.handleMessage(pluginId, {
        updates: [
          {
            values:
            [
              {
                path: 'navigation.sun.elevation',
                value: sunrisePos.altitude,
                meta:{
                  units:"rad",
                  description:"Sun elevation above horizon"
                }
              }
            ]
          }
        ]
      })

      repeat(app, props, lightLevel)

    }, the_interval)
  }

  function repeat(app, props, lightLevel){
    if (repeatTimer) {
      clearInterval(repeatTimer)
    }
    repeatTimer = setInterval(function() {
      app.debug(props.Seatalk1.seatalkBool)
      app.debug(props.FDX.fdxout)

      if (props.Seatalk1.seatalkBool){
        seatalkCommand = seaTalk[lightLevel]
        nmea0183out = toSentence([
          '$STALK',
          seatalkCommand
        ]);
        app.debug("nmea0183out: " + props.Seatalk1.seatalkOutput)
        app.emit('nmea0183out', props.Seatalk1.seatalkOutput)
      }

      if (props.FDX.fdxout) {
        app.debug(props.FDX.serialPort)
        app.debug(props.FDX.fdxBaud)

        const buffer = Buffer.from(fdx[lightLevel], "hex")
        app.debug("writing buffer " + buffer + " to FDX")
        sPort.write(buffer, function (err, result) {
          if (err) {
            app.debug('Error while sending message : ' + err);
          }
          if (result) {
            app.debug('Response received after sending message : ' + result);
          }
        });
      }
    }, repeatInterval)
  }

  function toSentence(parts) {
    var base = parts.join(',')
    return base + computeChecksum(base)
  }
  var m_hex = [
    '0',
    '1',
    '2',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
    'A',
    'B',
    'C',
    'D',
    'E',
    'F'
  ]

  function computeChecksum(sentence) {
    var c1
    var i

    // skip the $
    i = 1

    // init to first character    var count;

    c1 = sentence.charCodeAt(i)

    // process rest of characters, zero delimited
    for (i = 2; i < sentence.length; ++i) {
      c1 = c1 ^ sentence.charCodeAt(i)
    }

    return '*' + toHexString(c1)
  }

  function toHexString(v) {
    var lsn
    var msn

    msn = (v >> 4) & 0x0f
    lsn = (v >> 0) & 0x0f
    return m_hex[msn] + m_hex[lsn]
  }
