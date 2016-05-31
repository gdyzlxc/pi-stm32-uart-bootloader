var wpi = require('wiring-pi');
var serialPort = require("serialport");
var SerialPort = serialPort.SerialPort;
var async = require('async');
var BufferBuilder = require('buffer-builder');

const BOOT0_MAIN_FLASH = 0;
const BOOT0_SYSTEM_MEMORY = 1;

const CMD_GET = 0x00;
const CMD_ID  = 0x02;
const CMD_ERASE = 0x43;
const CMD_EXTENDED_ERASE = 0x44;

const ACK = 0x79;
const NACK = 0x1f;

class STM32USARTBootloader {
  constructor(options) {
    this.resetPin = options.resetPin;
    this.boot0Pin = options.boot0Pin;
    this.serialPortPath = options.serialPortPath;
    this.serialPortBaudRate = options.serialPortBaudRate || 9600;

    wpi.pinMode(this.boot0Pin, wpi.OUTPUT);

    async.series([
      this._setBoot0MainFlash.bind(this),
      this._deassertReset.bind(this)
    ], (err) => {
      if (err) {
        console.error('could not initialize', err);
      }
    });
  }

  _setBoot0MainFlash(callback) {
    wpi.digitalWrite(this.boot0Pin, BOOT0_MAIN_FLASH);
    callback();
  }

  _setBoot0SystemMemory(callback) {
    wpi.digitalWrite(this.boot0Pin, BOOT0_SYSTEM_MEMORY);
    callback();
  }

  _deassertReset(callback) {
    wpi.digitalWrite(this.resetPin, 1);
    wpi.pinMode(this.resetPin, wpi.OUTPUT);
    callback();
  }

  _assertReset(callback) {
    wpi.digitalWrite(this.resetPin, 0);
    wpi.pinMode(this.resetPin, wpi.INPUT);
    callback();
  }

  _openSerialPort(callback) {
    this.serialPort = new SerialPort(this.serialPortPath, {
      baudrate: this.serialPortBaudRate,
      dataBits: 8,
      parity: 'even',
      stopBits: 1,
      parser: serialPort.parsers.raw
    }, false);
    this.serialPort.open(callback);
  }

  _closeSerialPort(callback) {
    this.serialPort.removeAllListeners('data');
    this.serialPort.close((err) => {
      this.serialPort = null;
      callback(err);
    });
  }

  flash(fileName, callback) {
    this._runSystemMemoryFn((callback) => {
      // TODO
      console.log('flash');
      return callback();
    }, callback);
  }

  _withTimeoutAndData(begin, onData, timeoutMS, callback) {
    var callbackCalled = false;
    var done = (function _done(callback, err, arg) {
      clearTimeout(timeout);
      this.serialPort.removeAllListeners('data');
      if (!callbackCalled) {
        callbackCalled = true;
        return callback(err, arg);
      }
    }).bind(this, callback);

    var timeout = setTimeout(() => {
      this.serialPort.removeAllListeners('data');
      done(new Error('Timeout waiting for response'));
    }, timeoutMS);
       
    this.serialPort.on('data', (data) => {
      onData(data, done);
    });
    
    begin((err) => {
      if (err) {
        done(err);
      }
    });
  }

  _sleep(ms, callback) {
    setTimeout(callback, ms);
  }

  _enterBootloader(callback) {
    this._withTimeoutAndData(
      (callback) => {
        this.serialPort.write(new Buffer([0x7f]), callback);
      },
      (data, callback) => {
        if (data.length != 1) {
          return callback(new Error('Enter Bootloader: Expected length 1 found ' + data.length));
        }
        if (data[0] != 0x79) {
          return callback(new Error('Enter Bootloader: Expected 0x79 found 0x' + data[0].toString(16)));
        }
        return callback();
      },
      1000,
      callback
    );
  }
  
  _cmdIsAvailable(cmd) {
    return this.availableCommands.indexOf(cmd) >= 0;
  }

  _getIdCmd(callback) {
    if (!this._cmdIsAvailable(CMD_ID)) {
      return callback(new Error('ID command not available'));
    }
    this._cmdWithAckBeginAndEnd(CMD_ID, (err, buffer) => {
      if (err) {
        return callback(err);
      }
      this.pid = (buffer[2] << 8) | buffer[3];
      return callback(null, this.pid);
    });
  }
  
  _getCmd(callback) {
    this._cmdWithAckBeginAndEnd(CMD_GET, (err, buffer) => {
      if (err) {
        return callback(err);
      }
      this.bootloaderVersion = buffer[2];
      this.availableCommands = [];
      for (var i = 3; i < buffer.length - 1; i++) {
        this.availableCommands.push(buffer[i]);
      }
      return callback();
    });
  }

  _cmdWithAckBeginAndEnd(cmd, callback) {
    var buffer = new BufferBuilder();
    var len = -1;
    this._withTimeoutAndData(
      (callback) => {
        this.serialPort.write(new Buffer([cmd, ~cmd]), callback);
      },
      (data, callback) => {
        if (buffer.length == 0 && data[0] != ACK) {
          return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
        }
        buffer.appendBuffer(data);
        if (buffer.length > 2 && len < 0) {
          len = buffer.get()[1] + 4;
        }
        if (buffer.length == len) {
          buffer = buffer.get();
          if (buffer[buffer.length - 1] != ACK) {
            return callback(new Error('Expected end ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
          }
          return callback(null, buffer);
        }
      },
      1000,
      callback
    );
  }

  _cmdEraseAll(callback) {
    var len = 0;
    if (!this._cmdIsAvailable(CMD_ERASE)) {
      return callback(new Error('Erase command not available'));
    }
    this._withTimeoutAndData(
      (callback) => {
        this.serialPort.write(new Buffer([CMD_ERASE, ~CMD_ERASE]), callback);
      },
      (data, callback) => {
        if (data[0] != ACK) {
          return callback(new Error('Expected start ack (0x' + ACK.toString(16) + ') found 0x' + data[0].toString(16)));
        }
        len += data.length;
        if (len == 2) {
          return callback();
        }
        this.serialPort.write(new Buffer([0xff, 0x00]), (err) => {
          if (err) {
            return callback(err);
          }
        });
      },
      30 * 1000,
      callback
    );  
  }

  _runSystemMemoryFn(fn, callback) {
    async.series([
      this._openSerialPort.bind(this),
      this._assertReset.bind(this),
      this._setBoot0SystemMemory.bind(this),
      this._sleep.bind(this, 10),
      this._deassertReset.bind(this),
      this._sleep.bind(this, 500),
      this._enterBootloader.bind(this),
      this._getCmd.bind(this),
      this._getIdCmd.bind(this),
      this._cmdEraseAll.bind(this),
      fn
    ], (err) => {
      async.series([
        this._assertReset.bind(this),
        this._setBoot0MainFlash.bind(this),
        this._closeSerialPort.bind(this),
        this._deassertReset.bind(this)
      ], (innerErr) => {
        if (innerErr) {
          return callback(innerErr);
        }
        if (err) {
          return callback(err);
        }
        return callback();
     });
    });
  }
}

module.exports = STM32USARTBootloader;
