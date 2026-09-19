<p align="center"><img src="icon.svg" width="96" alt="Denon sound modes"></p>

# homebridge-denon-soundmode

Homebridge plugin that exposes the sound modes (surround modes) of a Denon AVR as HomeKit switches, with status feedback. Modes are grouped into one accessory (tile) per group.

## Tested hardware

**Developed and tested only on a Denon AVR-X2400H.** Other Denon or Marantz receivers may report different mode names or use different commands, and are untested. Reports for other models are welcome.

## How it works

The plugin keeps a single Telnet connection (port 23) to the receiver, polls the current mode with `MS?`, and sets a mode with `MS<command>`. It does not use the HTTP API, which returns 403 or empty answers on some models.

## Known limits

- The status name reported by the receiver can differ from the command name. Example on the X2400H: the command `DOLBY DIGITAL` is reported as `DOLBY SURROUND`, and `DTS SURROUND` with a PCM source is reported as `NEURAL:X`. Use the optional `match` regex for these cases.
- Confirmed on the X2400H: `STEREO`, `PURE DIRECT`, `DOLBY DIGITAL`, `DTS SURROUND`. Other mode names were observed in receiver status reports but their commands were not all verified.
- `AURO3D`, `AURO2DSURR` and `ALL ZONE STEREO` did not respond on the X2400H.
- Toggling a whole group tile in the Home app is ignored on purpose, so the receiver does not get all modes at once. Pick a single switch instead.
- Denon limits simultaneous Telnet connections. If another integration holds them, this plugin may not connect.

## Config

Use the settings screen in Homebridge UI, or edit config.json. Each mode has `name`, `command` (the text after `MS`), and optionally `match` (a regex for the reported status) and `stateless` (a button with no status).

## License

MIT
