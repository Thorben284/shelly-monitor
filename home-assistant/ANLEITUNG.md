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
| Roborock (mit Absaug-/Waschstation) | **Roborock** (fester Bestandteil von HA) | Anmeldung mit dem Konto der Roborock-App; das Modell erkennt HA selbst |
| eufy | **Eufy Security** (Community, fuatakgun) | siehe Schritt 3 |
| Waschmaschine Bosch WGB2560X0 | **Home Connect** (fester Bestandteil von HA) | siehe Abschnitt 5 |

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

## 4. Jarvis mit HA verbinden

1. In HA: Profil (unten links) → Sicherheit → **Langlebiges Zugriffstoken** erstellen.
2. Dashboard aktualisieren und Abhängigkeiten installieren:
   ```bash
   cd ~/shelly-monitor && git pull && npm install
   ```
3. In `~/shelly-monitor/.env` ergänzen (Vorlage: `.env.example`):
   ```
   HA_URL=http://127.0.0.1:8123
   HA_TOKEN=<token>
   JARVIS_PIN=<4–8 Ziffern>
   ```
4. Dashboard neu starten. Startseite ist jetzt **Zuhause**.

## 5. Waschmaschine (Bosch WGB2560X0, Home Connect)

Voraussetzung: Die Maschine ist in der **Home-Connect-App** eingerichtet und im WLAN.

1. Auf **developer.home-connect.com** mit derselben E-Mail wie in der Home-Connect-App ein
   Entwicklerkonto anlegen.
2. Dort unter „Applications“ → „Register Application“:
   - OAuth Flow: **Authorization Code Grant Flow**
   - Redirect URI: `https://my.home-assistant.io/redirect/oauth`
   - Client ID und Client Secret notieren.
3. In HA: Einstellungen → Geräte & Dienste → Integration hinzufügen → **Home Connect**,
   Client ID/Secret eingeben und mit dem Home-Connect-Konto anmelden.
4. In HA beim Gerät „Waschmaschine“ die Sensoren **Betriebszustand** (Operation state) und
   **Endzeit** (Finish time) suchen, Entitäts-IDs kopieren und in die `.env` eintragen:
   ```
   WASCHMASCHINE_STATUS_ENTITY=sensor.<name>_betriebszustand
   WASCHMASCHINE_ENDE_ENTITY=sensor.<name>_endzeit
   ```
   (Die genauen IDs vergibt HA selbst – bitte aus HA kopieren.)

Jarvis zeigt dann „läuft, fertig um 14:35 Uhr“ und meldet **fertig**, **braucht dich**
(z. B. Tür/Waschmittel) und **Fehler**. Die Daten laufen über die Bosch-Cloud (Home Connect).

Alternative ohne Cloud: messender Zwischenstecker (z. B. Shelly Plug S) und
`WASCHMASCHINE_POWER_ENTITY=sensor.<name>_leistung` – erkennt „läuft“ ab 8 W und „fertig“
nach 3 Minuten unter 4 W.

## 6. KI-Fragen (optional)

Ohne KI versteht Jarvis feste Befehle („Heizstab aus“, „Sauger starten“, „Status“, „Wie viel PV?“ …).
Für freie Fragen einen Schlüssel unter console.anthropic.com anlegen und eintragen:
```
ANTHROPIC_API_KEY=<schlüssel>
JARVIS_MODEL=claude-haiku-5-5   # optional: deutlich günstiger
```
Die KI sieht dabei den aktuellen Gerätezustand (Namen und Werte, keine Kamerabilder) und darf nur
dieselben freigegebenen Befehle auslösen wie das Dashboard. Kosten fallen je Frage an.

## 6b. Neue Geräte und Kamerabilder

- **Geräteprüfung alle 60 Minuten** (`JARVIS_PRUEFUNG_MIN`): Jarvis vergleicht die Geräte in
  Home Assistant mit dem gespeicherten Stand (`data/bekannte-geraete.json`) und meldet neue und
  entfernte Geräte unter „Hinweise“. Neue Geräte erscheinen sofort in der Oberfläche und sind 24 Stunden
  mit „neu“ markiert. Prüfung von Hand: „Jetzt prüfen“ unter „Hinweise“.
- Automatisch eingebunden werden: Schalter, Lichter, Lüfter, Saugroboter, Kameras, Bewegungsmelder,
  Alarmanlage, Rollläden (hoch/stopp/runter), Thermostate, Schlösser und Mediengeräte (nur Anzeige).
  Ganz neue Gerätearten zeigt Jarvis erst nach einer Programmerweiterung.
- Ein neues Gerät muss zuerst in **Home Assistant** eingebunden sein (meist automatisch erkannt,
  sonst unter Einstellungen → Geräte & Dienste).
- **Letzte Bewegung je Kamera** = Beginn der letzten Bewegung an den Meldern, die in HA zum selben
  Gerät gehören wie die Kamera. Dafür muss der Zugriffsschlüssel von einem **Administrator-Konto**
  stammen. Sonst ordnet Jarvis die Melder über den Namen zu (Kamera „Einfahrt“ ↔ Melder „Einfahrt …“).
  Die Zeiten kommen aus dem HA-Verlauf und überstehen Neustarts (`data/bewegungen.json`).
  Maus über die Zeit zeigt Datum und Uhrzeit.
- **Kamera-Standbilder alle 10 Minuten** (`JARVIS_KAMERA_MIN`), mit Uhrzeit der Aufnahme.
  Ein Klick auf ein Bild öffnet das Livebild.

## 7. Spracheingabe und Benachrichtigungen

Browser erlauben Mikrofon und Benachrichtigungen nur über **HTTPS**. Über `http://<pi-ip>:3000`
ist der Mikrofon-Knopf deshalb ausgegraut. Vorlesen funktioniert trotzdem.

Möglicher Weg: **Tailscale** auf Pi und Handy installieren und auf dem Pi
`sudo tailscale serve --bg 3000` ausführen. Dann ist Jarvis unter `https://<pi-name>.<tailnet>.ts.net`
erreichbar, auch unterwegs, ohne Portfreigabe im Router. (Auf eurem Netz noch nicht getestet.)

Hinweis: Die Spracherkennung in Chrome/Edge schickt die Aufnahme an Google zur Auswertung.

## Sicherheit

- Ports 3000, 3001, 8123 **nicht** im Router freigeben. Fernzugriff nur per VPN (z. B. Tailscale).
- `JARVIS_PIN` setzen: Ohne PIN kann jeder im WLAN schalten und Kamerabilder sehen.
  Die Energiewerte bleiben ohne PIN sichtbar.
- Die Alarmanlage lässt sich nur schalten, wenn HA dafür keinen Code verlangt.

## Ohne echtes Home Assistant ausprobieren

`node tools/mock-ha.js` startet ein Test-HA mit erfundenen Geräten (Port 8124, Token `test`):
```bash
HA_URL=http://127.0.0.1:8124 HA_TOKEN=test PORT=3999 node server.js
```

## Prüfprotokoll Fremd-Code (07.11.2026)

**Offizielle Pakete:** `@anthropic-ai/sdk` 1.6.0 (Herausgeber Anthropic) und `chart.js` 4.4.0
(bisher per CDN geladen, jetzt lokal) – beide ohne Installationsskripte, `npm audit`: 0 bekannte Lücken.
Dabei wurden drei bekannte Lücken in Express-Unterpaketen (body-parser, proxy-addr, qs) per Update behoben.

### Community-Code

Gesichtet: Quellcode beider Projekte nach `eval`, `child_process`, verschleiertem Code
(Base64/atob) und fremden Server-Adressen. **Ergebnis: nichts Auffälliges**; die einzigen
fest eingetragenen Adressen sind Dokumentations-Links (github.com, bropat.github.io).

Nicht geprüft (Grenzen):
- die Bibliothek `eufy-security-client` 4.1.0, die die eigentliche eufy-Kommunikation macht,
- das fertige Docker-Image `bropat/eufy-security-ws` (ob es exakt dem Quellcode entspricht).
