'use strict';
const net = require('net');

const PLUGIN = '@orenasher/homebridge-denon-soundmode';
const PLATFORM = 'DenonSoundMode';
const AZS = 'ALL ZONE STEREO';

module.exports = (api) => {
  api.registerPlatform(PLUGIN, PLATFORM, DenonSoundMode);
};

class Denon {
  // Denon sends volume as 2 digits for whole numbers (MV48 = 48.0)
  // or 3 digits when at a half step (MV485 = 48.5).
  static parseVol(digits) {
    if (digits.length === 3) {
      const whole = parseInt(digits.slice(0, 2), 10);
      const frac = digits.slice(2) === '5' ? 0.5 : 0;
      return whole + frac;
    }
    return parseInt(digits, 10);
  }

  constructor(log, host, port, pollSec, callbacks) {
    this.log = log; this.host = host; this.port = port;
    this.pollSec = pollSec;
    this.onMode = callbacks.onMode;
    this.onPower = callbacks.onPower;
    this.onVolume = callbacks.onVolume;
    this.onMute = callbacks.onMute;
    this.sock = null; this.buf = '';
    this.current = ''; this.power = null; this.volume = null; this.maxVolume = 98; this.muted = null;
  }
  start() {
    this.connect();
    setInterval(() => {
      this.send('MS?');
      setTimeout(() => this.send('PW?'), 300);
      setTimeout(() => this.send('MV?'), 600);
      setTimeout(() => this.send('MU?'), 900);
    }, this.pollSec * 1000);
  }
  connect() {
    const s = net.connect(this.port, this.host);
    this.sock = s;
    this.buf = '';
    s.setKeepAlive(true, 10000);
    s.on('connect', () => {
      this.log.info('Connected to receiver');
      setTimeout(() => { this.send('MS?'); this.send('PW?'); this.send('MV?'); this.send('MU?'); }, 500);
    });
    s.on('data', (d) => {
      this.buf += d.toString('latin1');
      const parts = this.buf.split(/[\r\n]+/);
      this.buf = parts.pop();
      for (const p of parts) this.handleLine(p);
    });
    s.on('error', (e) => this.log.debug('Telnet error: ' + e.message));
    s.on('close', () => {
      if (this.sock === s) this.sock = null;
      setTimeout(() => this.connect(), 5000);
    });
  }
  handleLine(p) {
    if (p.startsWith('MS') && !p.startsWith('MSQUICK')) {
      this.current = p.slice(2).trim();
      this.onMode(this.current);
    } else if (p.startsWith('PWON') || p.startsWith('PWSTANDBY')) {
      const power = p.startsWith('PWON');
      if (power !== this.power) { this.power = power; this.onPower(power); }
    } else if (p.startsWith('MVMAX')) {
      const m = p.match(/^MVMAX\s*(\d{2,3})/);
      if (m) this.maxVolume = Denon.parseVol(m[1]);
    } else if (p.startsWith('MV')) {
      const m = p.match(/^MV(\d{2,3})$/);
      if (m) {
        const v = Denon.parseVol(m[1]);
        if (v !== this.volume) { this.volume = v; this.onVolume(v, this.maxVolume); }
      }
    } else if (p.startsWith('MUON') || p.startsWith('MUOFF')) {
      const muted = p.startsWith('MUON');
      if (muted !== this.muted) { this.muted = muted; this.onMute(muted); }
    }
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
  setPower(on) {
    this.send(on ? 'PWON' : 'PWSTANDBY');
    setTimeout(() => this.send('PW?'), 1500);
  }
  setVolume(raw) {
    const clamped = Math.max(0, Math.min(Math.round(raw), this.maxVolume));
    this.send('MV' + String(clamped).padStart(2, '0'));
    setTimeout(() => this.send('MV?'), 1000);
  }
  setMute(on) {
    this.send(on ? 'MUON' : 'MUOFF');
    setTimeout(() => this.send('MU?'), 1000);
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
    if (this.platform.power === false) return false;
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

class VolumeAccessory {
  constructor(platform, cfg) {
    const { Service, Characteristic } = platform.api.hap;
    this.platform = platform;
    this.Characteristic = Characteristic;
    this.name = (cfg && cfg.name) || 'Denon Volume';
    this.limit = (cfg && cfg.limit) || null;
    this.info = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Denon')
      .setCharacteristic(Characteristic.Model, 'Volume')
      .setCharacteristic(Characteristic.SerialNumber, 'denon-volume');
    this.bulb = new Service.Lightbulb(this.name);
    this.bulb.getCharacteristic(Characteristic.On)
      .onGet(() => this.isOn())
      .onSet((v) => {
        this.platform.log.info('Setting mute: ' + (v ? 'OFF (unmuted)' : 'ON (muted)'));
        this.platform.denon.setMute(!v);
      });
    this.bulb.getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.percent())
      .onSet((v) => {
        const max = this.effectiveMax();
        const raw = Math.min(Math.round(v), max);
        this.platform.log.info('Setting volume: ' + raw + ' (limit ' + max + ')');
        this.platform.denon.setVolume(raw);
      });
  }
  effectiveMax() {
    const real = this.platform.volumeMax || 98;
    return this.limit ? Math.min(this.limit, real) : real;
  }
  percent() {
    const v = this.platform.volume;
    if (v == null) return 0;
    return Math.max(0, Math.min(100, Math.round(v)));
  }
  isOn() {
    if (this.platform.power === false) return false;
    return !this.platform.muted;
  }
  refresh() {
    this.bulb.updateCharacteristic(this.Characteristic.On, this.isOn());
    this.bulb.updateCharacteristic(this.Characteristic.Brightness, this.percent());
  }
  getServices() {
    return [this.info, this.bulb];
  }
}

class PowerAccessory {
  constructor(platform, cfg) {
    const { Service, Characteristic } = platform.api.hap;
    this.platform = platform;
    this.Characteristic = Characteristic;
    this.name = (cfg && cfg.powerName) || 'Denon Power';
    this.info = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Denon')
      .setCharacteristic(Characteristic.Model, 'Power')
      .setCharacteristic(Characteristic.SerialNumber, 'denon-power');
    this.sw = new Service.Switch(this.name);
    this.sw.getCharacteristic(Characteristic.On)
      .onGet(() => !!this.platform.power)
      .onSet((v) => {
        this.platform.log.info('Setting power: ' + (v ? 'ON' : 'STANDBY'));
        this.platform.denon.setPower(v);
      });
  }
  refresh() {
    this.sw.updateCharacteristic(this.Characteristic.On, !!this.platform.power);
  }
  getServices() {
    return [this.info, this.sw];
  }
}

class DenonSoundMode {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.mode = '';
    this.power = null;
    this.volume = null;
    this.volumeMax = 98;
    this.muted = null;
    this.groups = (config.groups || []).map((g) => new ModeGroup(this, g));
    this.volumeAccessory = (config.volume && config.volume.enabled) ? new VolumeAccessory(this, config.volume) : null;
    this.powerAccessory = (config.volume && config.volume.enabled) ? new PowerAccessory(this, config.volume) : null;
    this.denon = new Denon(log, config.host, config.port || 23, config.pollInterval || 5, {
      onMode: (mode) => {
        if (mode !== this.mode) {
          this.mode = mode;
          this.log.info('Sound mode: ' + mode);
          this.groups.forEach((g) => g.refresh());
        }
      },
      onPower: (power) => {
        this.power = power;
        this.log.info('Power: ' + (power ? 'ON' : 'STANDBY'));
        this.groups.forEach((g) => g.refresh());
        if (this.volumeAccessory) this.volumeAccessory.refresh();
        if (this.powerAccessory) this.powerAccessory.refresh();
      },
      onVolume: (v, max) => {
        this.volume = v;
        this.volumeMax = max;
        if (this.volumeAccessory) this.volumeAccessory.refresh();
      },
      onMute: (muted) => {
        this.muted = muted;
        this.log.info('Mute: ' + (muted ? 'ON' : 'OFF'));
        if (this.volumeAccessory) this.volumeAccessory.refresh();
      },
    });
    this.log.info('Developed and tested only on Denon AVR-X2400H; other models are untested.');
    api.on('didFinishLaunching', () => this.denon.start());
  }
  accessories(callback) {
    const list = [...this.groups];
    if (this.volumeAccessory) list.push(this.volumeAccessory);
    if (this.powerAccessory) list.push(this.powerAccessory);
    callback(list);
  }
}
