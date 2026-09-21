'use strict';
const net = require('net');

const PLUGIN = '@orenasher/homebridge-denon-soundmode';
const PLATFORM = 'DenonSoundMode';
const AZS = 'ALL ZONE STEREO';

module.exports = (api) => {
  api.registerPlatform(PLUGIN, PLATFORM, DenonSoundMode);
};

class Denon {
  constructor(log, host, port, pollSec, onMode) {
    this.log = log; this.host = host; this.port = port;
    this.pollSec = pollSec; this.onMode = onMode;
    this.sock = null; this.buf = ''; this.current = '';
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
        if (p.startsWith('MS') && !p.startsWith('MSQUICK')) {
          this.current = p.slice(2).trim();
          this.onMode(this.current);
        }
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
  poll(delays) {
    for (const t of delays) setTimeout(() => this.send('MS?'), t);
  }
  setMode(cmd) {
    if (this.current === AZS) {
      this.send('MNZST OFF');
      setTimeout(() => this.send('MS' + cmd), 1000);
      this.poll([2500, 5000]);
    } else {
      this.send('MS' + cmd);
      this.poll([1500, 4000]);
    }
  }
  setAllZone(on) {
    this.send(on ? 'MNZST ON' : 'MNZST OFF');
    this.poll([1500, 4000]);
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
    const modes = cfg.modes || [];
    this.items = modes.map((m, i) => this.makeItem(m, i, 'mode'));
    if (cfg.allZoneStereo) {
      this.items.push(this.makeItem({ name: 'All Zone Stereo' }, modes.length, 'azs'));
    }
  }
  makeItem(m, i, kind) {
    const { Service, Characteristic } = this.platform.api.hap;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let match = null;
    try {
      if (kind === 'azs') match = new RegExp('^' + esc(AZS) + '$');
      else if (m.match) match = new RegExp(m.match);
      else if (m.command) match = new RegExp('^' + esc(m.command) + '$');
    } catch (e) {
      this.platform.log.warn('Bad status regex for "' + m.name + '": ' + e.message);
    }
    const item = { cfg: m, kind, command: m.command, stateless: !!m.stateless, match };
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
    return !item.stateless && !!item.match && item.match.test(this.platform.mode);
  }
  refresh() {
    for (const it of this.items) {
      it.sw.updateCharacteristic(this.Characteristic.On, this.isOn(it));
    }
  }
  set(item, v) {
    if (!v) {
      if (item.kind === 'azs' && this.platform.mode === AZS) {
        this.platform.log.info('Setting All Zone Stereo: OFF');
        this.platform.denon.setAllZone(false);
        return;
      }
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
    if (p.length !== 1) {
      this.platform.log.warn('Ignored group toggle (' + p.length + ' switches at once)');
      setTimeout(() => this.refresh(), 300);
      return;
    }
    const it = p[0];
    if (it.kind === 'azs') {
      this.platform.log.info('Setting All Zone Stereo: ON');
      this.platform.denon.setAllZone(true);
    } else if (it.command) {
      this.platform.log.info('Setting sound mode: ' + it.command);
      this.platform.denon.setMode(it.command);
    } else {
      this.platform.log.warn('"' + it.cfg.name + '" has no command (status only)');
      setTimeout(() => this.refresh(), 300);
      return;
    }
    setTimeout(() => this.refresh(), it.stateless ? 1000 : 5000);
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
