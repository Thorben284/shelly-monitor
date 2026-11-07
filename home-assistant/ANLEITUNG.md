# Jarvis – Installation auf dem Raspberry Pi

Aufbau: **Home Assistant (HA)** steuert alle Geräte. Das bestehende Energie-Dashboard
holt sich Gerätestatus und Schaltbefehle über die HA-API.

```
Dashboard (Port 3000)  ──REST──▶  Home Assistant (Port 8123)
                                   ├─ Shelly        (integriert, lokal)
                                   ├─ Roborock      (integriert)
                                   ├─ eufy HomeBase 3 ◀─ eufy-security-ws (Port 3001)
                                   └─ Waschmaschine (Marke offen)
```

## 0. Voraussetzungen prüfen (auf dem Pi)

```bash
cat /proc/device-tree/model; free -h; df -h /
docker --version || curl -fsSL https://get.docker.com | sh
```

- Pi 4 mit mind. 4 GB oder Pi 5 empfohlen. Kamera-Livestreams belasten den Pi.
- Möglichst SSD statt SD-Karte (HA schreibt viel in die Datenbank).
- Vorher Backup der SD-Karte bzw. des Dashboard-Ordners inkl. `.env`.

## 1. Home Assistant + eufy-Brücke starten

```bash
cd ~/shelly-monitor && git pull
cd home-assistant
cp eufy.env.example eufy.env && nano eufy.env      # eufy-Zugang eintragen
docker compose up -d
```

Dann im Browser `http://<pi-ip>:8123` öffnen und Benutzerkonto anlegen.

## 2. Geräte einbinden (HA → Einstellungen → Geräte & Dienste)

| Gerät | Integration | Hinweis |
|---|---|---|
| Shelly | **Shelly** (fester Bestandteil von HA) | wird meist automatisch gefunden, lokal ohne Cloud |
| Roborock | **Roborock** (fester Bestandteil von HA) | Login mit Roborock-App-Konto |
| eufy | **Eufy Security** (Community, fuatakgun) | siehe Schritt 3 |
| Waschmaschine | abhängig von Marke | Marke/Modell nachreichen |

## 3. eufy-Integration (Community-Erweiterung)

Geprüfter Stand: `fuatakgun/eufy_security` Version 8.2.5 und `bropat/eufy-security-ws` 3.1.0
(Quellcode-Sichtung, siehe unten). Installation **ohne HACS**, nur diese Version:

```bash
cd ~/shelly-monitor/home-assistant
git clone --depth 1 --branch v8.2.5 https://github.com/fuatakgun/eufy_security.git /tmp/eufy
mkdir -p ha-config/custom_components
cp -r /tmp/eufy/custom_components/eufy_security ha-config/custom_components/
docker restart homeassistant
```

> Falls der Tag `v8.2.5` nicht existiert: `git -C /tmp/eufy tag` anzeigen lassen und melden.

In HA: Integration „Eufy Security“ hinzufügen → Host `127.0.0.1`, Port `3001`.

## 4. Dashboard mit HA verbinden

1. In HA: Profil (unten links) → Sicherheit → **Langlebiges Zugriffstoken** erstellen.
2. In `~/shelly-monitor/.env` ergänzen:
   ```
   HA_URL=http://127.0.0.1:8123
   HA_TOKEN=<token>
   ```
3. Dashboard neu starten. Test: `http://<pi-ip>:3000/api/ha/states`

## Sicherheit

- Ports 3000, 3001, 8123 **nicht** im Router freigeben. Fernzugriff später per VPN (z. B. Tailscale).
- Das Dashboard hat keine Anmeldung – wer im WLAN ist, kann schalten. Gäste-WLAN trennen.

## Prüfprotokoll Community-Code (07.11.2026)

Gesichtet: Quellcode beider Projekte nach `eval`, `child_process`, verschleiertem Code
(Base64/atob) und fremden Server-Adressen. **Ergebnis: nichts Auffälliges**; die einzigen
fest eingetragenen Adressen sind Dokumentations-Links (github.com, bropat.github.io).

Nicht geprüft (Grenzen):
- die Bibliothek `eufy-security-client` 4.1.0, die die eigentliche eufy-Kommunikation macht,
- das fertige Docker-Image `bropat/eufy-security-ws` (ob es exakt dem Quellcode entspricht).
