const SerialPort = require ('serialport')

var buffer = [0x81,0x2A,0x01,0x2B,0x00,0x00]

var com = new SerialPort("/dev/tty.usbmodem0000c729f34e1", {
    baudRate: 19200,
    databits: 8,
    parity: 'none'
}, false);

com.open(function (error) {
    if (error) {
        console.log('Error while opening the port ' + error);
    } else {
        console.log('CST port open');
        com.write(buffer, function (err, result) {
            if (err) {
                console.log('Error while sending message : ' + err);
            }
            if (result) {
                console.log('Response received after sending message : ' + result);
            }
        });
    }
});
