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
    if (props.FDX.fdxout){
      sPort = new SerialPort(props.FDX.fdxSerial, {baudRate: props.FDX.fdxBaud,
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
      sPort.close(function (err) {
        console.log('port closed', err);
      });
      app.debug("Stopped")
    }

    plugin.id = "signalk-instrument-light-plugin"
    plugin.name = "Instrument lights"
    plugin.description = "Plugin to control proprietary instrument lights"

    plugin.schema = {
      title: "Plugin to control proprietary instrument lights",
      type: "object",
      properties: {
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
            fdxSerial: {
              title: "Serial port for FDX protocol (eg. GND10)",
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
    return plugin;
  }

  function isItTime (app, props){

    var minutes = props.UpdateInterval, the_interval = minutes * 60 * 1000
    myTimer = setInterval(function() {
      app.debug("I am doing my " + minutes + " minutes check")
      var now = new Date()
      var position = app.getSelfPath('navigation.position.value')

      if (! position) {
        app.debug("Position is unknown, aborting check")
        return
      }
      lat = position.latitude
      lon = position.longitude
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
            mode = "restricted visibility"
          }
        } else {
          app.debug("nautical dawn/dusk, lights: " + props.Nautical)
          lightLevel = props.Nautical
          mode = "restricted visibility"
        }
      } else {
        app.debug("civil dawn/dusk, lights: " + props.Civil)
        lightLevel = props.Civil
        mode = "restricted visibility"
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
        app.debug(props.FDX.fdxSerial)
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
