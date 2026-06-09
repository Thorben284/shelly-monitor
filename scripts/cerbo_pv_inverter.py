#!/usr/bin/env python3
"""
Shelly PV → Victron Cerbo GX Integration
=========================================
Erstellt einen virtuellen PV-Wechselrichter im Venus OS dbus und speist
die PV-Summe der Shelly PM Minis vom shelly-monitor-Server ein.

Voraussetzungen (Cerbo GX mit Venus OS):
  - Python 3 (vorinstalliert)
  - GLib (vorinstalliert)
  - velib_python (wird automatisch im System gesucht)

Konfiguration über Umgebungsvariablen (oder /data/shelly-pv-inverter/.env):
  SHELLY_MONITOR_URL      URL des shelly-monitor, z.B. http://192.168.1.100:3000/api/data
  POLL_INTERVAL           Abfrageintervall in Sekunden (Standard: 10)
  PV_INVERTER_INSTANCE    dbus-Instanz, z.B. 30 (Standard: 30)
  PV_INVERTER_NAME        Anzeigename im Cerbo GX (Standard: Shelly PV Messung)
  PV_INVERTER_POSITION    0=AC-Eingang 1, 1=AC-Ausgang, 2=AC-Eingang 2 (Standard: 1)
"""

import sys
import os
import time
import json
import logging
from urllib.request import urlopen, Request
from urllib.error import URLError

# ── velib_python suchen ───────────────────────────────────────────────────────
# Venus OS legt velib_python je nach Firmware-Version an verschiedenen Orten ab.
_VELIB_SEARCH = [
    '/opt/victronenergy/dbus-digital-inputs',
    '/opt/victronenergy/dbus-modem',
    '/opt/victronenergy/dbus-mutlti',
    os.path.join(os.path.dirname(__file__), 'ext', 'velib_python'),
    os.path.join(os.path.dirname(__file__), 'velib_python'),
]

def _find_velib():
    for p in _VELIB_SEARCH:
        if os.path.isfile(os.path.join(p, 'vedbus.py')):
            return p
    return None

_velib_path = _find_velib()
if _velib_path:
    sys.path.insert(0, _velib_path)
else:
    print(
        'FEHLER: velib_python nicht gefunden.\n'
        'Bitte setup.sh ausführen oder velib_python nach\n'
        f'  {os.path.join(os.path.dirname(__file__), "velib_python")}/\n'
        'kopieren.',
        file=sys.stderr,
    )
    sys.exit(1)

from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib
from vedbus import VeDbusService

# ── Konfiguration ─────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s  %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger(__name__)

SHELLY_URL  = os.environ.get('SHELLY_MONITOR_URL', 'http://localhost:3000/api/data')
POLL_S      = int(os.environ.get('POLL_INTERVAL',          '10'))
INSTANCE    = int(os.environ.get('PV_INVERTER_INSTANCE',   '30'))
DEV_NAME    = os.environ.get('PV_INVERTER_NAME',           'Shelly PV Messung')
POSITION    = int(os.environ.get('PV_INVERTER_POSITION',   '1'))
# Position-Bedeutung im Venus OS:
#   0 = AC-Eingang 1 (z.B. Netz vor dem MultiPlus)
#   1 = AC-Ausgang (Wechselrichterseite / Hausbus)
#   2 = AC-Eingang 2


class ShellyPvInverterService:
    """Registriert sich als com.victronenergy.pvinverter.* im dbus."""

    SERVICE = f'com.victronenergy.pvinverter.shelly_{INSTANCE:02d}'

    def __init__(self):
        self._svc        = VeDbusService(self.SERVICE)
        self._energy_kwh = 0.0
        self._prev_t     = time.monotonic()

        s = self._svc

        # Pflicht-Verwaltungspfade
        s.add_path('/Mgmt/ProcessName',    __file__)
        s.add_path('/Mgmt/ProcessVersion', '1.0.0')
        s.add_path('/Mgmt/Connection',     f'HTTP {SHELLY_URL}')

        # Gerätekennzeichnung
        s.add_path('/DeviceInstance', INSTANCE)
        s.add_path('/ProductId',      0xB012)   # Venus OS: Generic PV Inverter
        s.add_path('/ProductName',    'Shelly PM PV')
        s.add_path('/CustomName',     DEV_NAME)
        s.add_path('/FirmwareVersion','1.0.0')
        s.add_path('/Serial',         f'SHELLYPM{INSTANCE:02d}')
        s.add_path('/Connected',      1)
        s.add_path('/StatusCode',     7)          # 7 = Running / Normal
        s.add_path('/ErrorCode',      0)

        # Position im AC-Netz (für korrekte Darstellung im System-Bild)
        s.add_path('/Position', POSITION)

        # AC-Messwerte (einphasig; Shelly PM Minis messen einphasig)
        s.add_path('/Ac/Power',          None)
        s.add_path('/Ac/L1/Power',       None)
        s.add_path('/Ac/L1/Voltage',     None)
        s.add_path('/Ac/L1/Current',     None)
        s.add_path('/Ac/L1/Frequency',   None)
        # Ertragszähler (kWh) – wird im laufenden Betrieb akkumuliert,
        # nicht über Neustarts hinweg persistiert.
        s.add_path('/Ac/Energy/Forward', None)

        log.info('dbus-Dienst registriert: %s', self.SERVICE)
        log.info('Lese PV-Daten von:        %s', SHELLY_URL)
        log.info('Position im AC-Netz:      %d', POSITION)

        self._update()
        GLib.timeout_add(POLL_S * 1000, self._update)

    # ── Datenabruf ───────────────────────────────────────────────────────────

    def _fetch_pv_watt(self):
        req = Request(SHELLY_URL, headers={'Accept': 'application/json'})
        with urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read())
        return float(data['current']['pv'] or 0)

    # ── Periodisches Update ───────────────────────────────────────────────────

    def _update(self):
        try:
            pv_w = self._fetch_pv_watt()
            now  = time.monotonic()
            dt_s = now - self._prev_t
            self._prev_t = now

            # Energie akkumulieren: W × s → Wh → kWh
            self._energy_kwh += pv_w * dt_s / 3_600_000.0

            s = self._svc
            s['/Ac/Power']          = round(pv_w, 1)
            s['/Ac/L1/Power']       = round(pv_w, 1)
            s['/Ac/L1/Voltage']     = 230.0
            s['/Ac/L1/Current']     = round(pv_w / 230.0, 2)
            s['/Ac/L1/Frequency']   = 50.0
            s['/Ac/Energy/Forward'] = round(self._energy_kwh, 4)
            s['/Connected']         = 1
            s['/StatusCode']        = 7
            s['/ErrorCode']         = 0

            log.info('PV: %6.0f W  |  Ertrag: %.3f kWh', pv_w, self._energy_kwh)

        except (URLError, KeyError, ValueError, TypeError) as exc:
            log.warning('Datenabruf fehlgeschlagen: %s', exc)
            self._svc['/Connected']  = 0
            self._svc['/StatusCode'] = 10   # Venus OS: Error

        return True   # GLib-Timer weiterlaufen lassen


def main():
    DBusGMainLoop(set_as_default=True)
    ShellyPvInverterService()
    GLib.MainLoop().run()


if __name__ == '__main__':
    main()
