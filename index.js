const debug = require('debug')('instrumentlights')
const Bacon = require('baconjs');
const util = require('util')
const _ = require('lodash')
var SunCalc = require('suncalc')
const signalkSchema = require('signalk-schema')
const react = require('react/package.json') // react is a peer dependency.
const rjf = require('react-jsonschema-form')

// Seatalk1:
const seaTalk = ["80,00,00", "80,00,04", "80,00,08", "80,00,0C"]
/*80  00  0X      Set Lamp Intensity: X=0 off, X=4: 1, X=8: 2, X=C: 3*/

var refresh
var altitude

module.exports = function(app) {
  var unsubscribe = undefined
  var plugin = {}

  plugin.start = function(props) {
    debug("starting...")
    debug("started")
    isItTime(app, props)
  }

  plugin.stop = function() {
    debug("stopping")
    if (unsubscribe) {
      unsubscribe()
    }
    debug("stopped")
  }

  plugin.id = "instrumentlights"
  plugin.name = "Instrument lights"
  plugin.description = "Plugin to control proprietary instrument lights"

  plugin.schema = {
    title: "Plugin to control proprietary instrument lights",
    type: "object",
    properties: {
      Seatalk1: {
        title: "Seatalk1 instruments",
        type: "boolean",
        default: false
      },
      FDX: {
        title: "Silva/Nexus/Garmin instruments (FDX)",
        type: "boolean",
        default: false
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
  setInterval(function() {
    debug("I am doing my " + minutes + " minutes check")
    var now = new Date()
    position = _.get(app.signalk.self, 'navigation.position')
    lat = position.latitude
    lon = position.longitude
    var sunrisePos = SunCalc.getPosition(new Date(), lat, lon)
    var lightLevel

    altitude = sunrisePos.altitude * 180 / 3.14

    debug(altitude)
    if (altitude < 0){
      if (altitude < -6){
        if (altitude < -12){
          if (altitude < -18){
            debug("night, lights: " + props.Night)
            lightLevel = props.Night
          } else {
            debug("astronomical, lights: " + props.Astronomical)
            lightLevel = props.Astronomical
          }
        } else {
          debug("nautical, lights: " + props.Nautical)
          lightLevel = props.Nautical
        }
      } else {
        debug("civil, lights: " + props.Civil)
        lightLevel = props.Civil
      }
    } else {
      debug("day, lights: " + props.Day)
      lightLevel = props.Day
    }
    debug("Sending command " + lightLevel + " to instruments")
    if (props.Seatalk1){
      seatalkCommand = seaTalk[lightLevel]

      debug("seatalkCommand: " + seatalkCommand)
      nmea0183out = toSentence([
        '$STALK',
        seatalkCommand
      ]);

      debug("nmea0183out: " + nmea0183out)
      app.emit('nmea0183out', nmea0183out)
    }
  }, the_interval)
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
