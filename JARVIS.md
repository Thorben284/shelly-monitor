# Jarvis – Einrichtung auf dem Raspberry Pi

Jarvis ist ein Teil der Energie-Zentrale: `http://<pi>:3000/jarvis`

- **Sprechen**: Mikrofon antippen, Frage stellen („Wie viel liefert die PV?“, „Schalte den Heizstab aus“). Die Antwort wird vorgelesen.
- **Briefing**: wird täglich zur `BRIEFING_TIME` erstellt (Wetter, PV-Aussicht, Termine, Batterie).
- **Schalter**: Shelly-Geräte, die in `.env` freigegeben sind.
- **Dashboard**: das bestehende Energie-Dashboard unter `/`.

## 1. Hardware

- Raspberry Pi 4 oder 5 (2 GB reichen), Raspberry Pi OS Lite 64-bit, LAN oder WLAN.
- Kein Mikrofon am Pi nötig: Gesprochen wird über Handy oder Tablet im Browser.

## 2. Installation

```bash
sudo apt-get update && sudo apt-get install -y git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo timedatectl set-timezone Europe/Berlin
git clone https://github.com/thorben284/shelly-monitor.git
cd shelly-monitor
bash pi/install.sh
nano .env            # ausfüllen, siehe unten
sudo systemctl restart jarvis
```

## 3. `.env` – wichtigste Werte

| Variable | Wozu |
|---|---|
| `ANTHROPIC_API_KEY` | Claude-API-Schlüssel (platform.claude.com). Kostet nach Verbrauch, getrennt vom Claude-Abo. |
| `JARVIS_TOKEN` | Zugangscode. Ohne ihn ist das Schalten gesperrt. |
| `JARVIS_LAT`, `JARVIS_LON` | Standort für das Wetter |
| `CALENDAR_ICS_URL` | Geheime iCal-Adresse des Kalenders |
| `SWITCH1_NAME`, `SWITCH1_ID`, `SWITCH1_CHANNEL` | Geräte, die Jarvis schalten darf (2, 3, … entsprechend) |

Die Shelly- und Victron-Werte bleiben wie bisher.

## 4. Vom Handy aus nutzen (auch unterwegs)

Ein Mikrofon im Browser gibt es nur über **HTTPS**. Mit `http://192.168…` geht nur die Texteingabe.
Empfohlen ist **Tailscale** (kostenlos für den privaten Gebrauch):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 3000
```

Danach die Tailscale-App auf dem Handy installieren und mit demselben Konto anmelden. Die Adresse lautet `https://<pi-name>.<tailnet>.ts.net/jarvis`.
Im Browser „Zum Startbildschirm hinzufügen“ antippen, dann verhält sich Jarvis wie eine App.
Hinweis: Den Befehl `tailscale serve` habe ich nicht auf einem Pi getestet. Prüfe ihn bei Bedarf in der Tailscale-Doku.

**Keine Portfreigabe im Router.** Die Seite kann schalten.

## 5. Bekannte Grenzen

- Spracheingabe nutzt die Spracherkennung des Browsers (Chrome/Android, Safari/iOS). Ein Weckwort „Jarvis“ gibt es nicht, du tippst auf das Mikrofon.
- Serientermine im Kalender werden nicht ausgewertet.
- Der Energieverlauf reicht etwa 2 Stunden zurück und wird nur im Arbeitsspeicher gehalten.
- Die Shelly Cloud erlaubt ca. 1 Anfrage pro Sekunde. Bei vielen Geräten `POLL_INTERVAL` nicht zu klein wählen.

## Befehle

```bash
journalctl -u jarvis -f          # Log
sudo systemctl restart jarvis    # nach .env-Änderung
git pull && npm ci --omit=dev && sudo systemctl restart jarvis   # Update
```
