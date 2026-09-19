'use strict';
const net = require('net');

const PLUGIN = '@orenasher/homebridge-denon-soundmode';
const PLATFORM = 'DenonSoundMode';

module.exports = (api) => {
  api.registerPlatform(PLUGIN, PLATFORM, DenonSoundMode);
};

class Denon {
  constructor(log, host, port, pollSec, onMode) {
    this.log = log; this.host = host; this.port = port;
    this.pollSec = pollSec; this.onMode = onMode;
    this.sock = null; this.buf = '';
  }
  start() {
    this.connect();
    setInterval(() => this.send('MS?'), this.pollSec * 1000);
  }
  connect() {
    const s = net.connect(this.port, this.host);
    this.sock = s;
    this.buf = '';
    s.setKeepAlive(true, 10000);
    s.on('connect', () => {
      this.log.info('Connected to receiver');
      setTimeout(() => this.send('MS?'), 500);
    });
    s.on('data', (d) => {
      this.buf += d.toString('latin1');
      const parts = this.buf.split(/[\r\n]+/);
      this.buf = parts.pop();
      for (const p of parts) {
        if (p.startsWith('MS') && !p.startsWith('MSQUICK')) this.onMode(p.slice(2).trim());
      }
    });
    s.on('error', (e) => this.log.debug('Telnet error: ' + e.message));
    s.on('close', () => {
      if (this.sock === s) this.sock = null;
      setTimeout(() => this.connect(), 5000);
    });
  }
  send(cmd) {
    if (this.sock && this.sock.writable) this.sock.write(cmd + '\r');
  }
  setMode(cmd) {
    this.send('MS' + cmd);
    setTimeout(() => this.send('MS?'), 1500);
    setTimeout(() => this.send('MS?'), 4000);
  }
}

class ModeGroup {
  constructor(platform, cfg) {
    const { Service, Characteristic } = platform.api.hap;
    this.platform = platform;
    this.name = cfg.name;
    this.Characteristic = Characteristic;
    this.pending = [];
    this.timer = null;
    this.info = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Denon')
      .setCharacteristic(Characteristic.Model, 'Sound modes')
      .setCharacteristic(Characteristic.SerialNumber, 'denon-soundmode-' + cfg.name);
    this.items = (cfg.modes || []).map((m, i) => this.makeItem(m, i));
  }
  makeItem(m, i) {
    const { Service, Characteristic } = this.platform.api.hap;
    const esc = m.command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const item = {
      cfg: m,
      stateless: !!m.stateless,
      match: new RegExp(m.match || '^' + esc + '$'),
    };
    const sw = new Service.Switch(m.name, 'sw' + i);
    sw.addOptionalCharacteristic(Characteristic.ConfiguredName);
    sw.setCharacteristic(Characteristic.ConfiguredName, m.name);
    sw.getCharacteristic(Characteristic.On)
      .onGet(() => this.isOn(item))
      .onSet((v) => this.set(item, v));
    item.sw = sw;
    return item;
  }
  isOn(item) {
    return !item.stateless && item.match.test(this.platform.mode);
  }
  refresh() {
    for (const it of this.items) {
      it.sw.updateCharacteristic(this.Characteristic.On, this.isOn(it));
    }
  }
  set(item, v) {
    if (!v) {
      setTimeout(() => this.refresh(), 500);
      return;
    }
    this.pending.push(item);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }
  flush() {
    const p = this.pending;
    this.pending = [];
    this.timer = null;
    if (p.length === 1) {
      const it = p[0];
      this.platform.log.info('Setting sound mode: ' + it.cfg.command);
      this.platform.denon.setMode(it.cfg.command);
      setTimeout(() => this.refresh(), it.stateless ? 1000 : 5000);
    } else {
      this.platform.log.warn('Ignored group toggle (' + p.length + ' switches at once)');
      setTimeout(() => this.refresh(), 300);
    }
  }
  getServices() {
    return [this.info, ...this.items.map((i) => i.sw)];
  }
}

class DenonSoundMode {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.mode = '';
    this.groups = (config.groups || []).map((g) => new ModeGroup(this, g));
    this.denon = new Denon(log, config.host, config.port || 23, config.pollInterval || 5, (mode) => {
      if (mode !== this.mode) {
        this.mode = mode;
        this.log.info('Sound mode: ' + mode);
        this.groups.forEach((g) => g.refresh());
      }
    });
    this.log.info('Developed and tested only on Denon AVR-X2400H; other models are untested.');
    api.on('didFinishLaunching', () => this.denon.start());
  }
  accessories(callback) {
    callback(this.groups);
  }
}
