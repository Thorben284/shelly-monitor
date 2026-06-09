#!/bin/sh
# Installationsskript für den Shelly PV Inverter Dienst auf dem Cerbo GX (Venus OS)
# Ausführen mit: sh setup_cerbo.sh
set -e

INSTALL_DIR=/data/shelly-pv-inverter
VELIB_DIR="$INSTALL_DIR/velib_python"
SERVICE_DIR=/service
DAEMONTOOLS_SVC="$SERVICE_DIR/shelly-pv-inverter"

echo "=== Shelly PV Inverter für Victron Cerbo GX ==="
echo

# ── 1. Verzeichnis anlegen ────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR" "$VELIB_DIR"

# ── 2. Skript kopieren ────────────────────────────────────────────────────────
cp "$(dirname "$0")/cerbo_pv_inverter.py" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/cerbo_pv_inverter.py"
echo "[OK] Skript nach $INSTALL_DIR kopiert"

# ── 3. velib_python bereitstellen ─────────────────────────────────────────────
# Bevorzugt: vorhandene System-Installation verwenden
SYSTEM_VELIB=""
for CANDIDATE in \
    /opt/victronenergy/dbus-digital-inputs \
    /opt/victronenergy/dbus-modem; do
    if [ -f "$CANDIDATE/vedbus.py" ]; then
        SYSTEM_VELIB="$CANDIDATE"
        break
    fi
done

if [ -n "$SYSTEM_VELIB" ]; then
    echo "[OK] Verwende System-velib_python: $SYSTEM_VELIB"
    # Symlink statt Kopie, um immer die System-Version zu nutzen
    ln -sf "$SYSTEM_VELIB/vedbus.py"    "$VELIB_DIR/vedbus.py"
    ln -sf "$SYSTEM_VELIB/ve_utils.py"  "$VELIB_DIR/ve_utils.py" 2>/dev/null || true
else
    echo "[..] Lade velib_python von GitHub..."
    VELIB_BASE="https://raw.githubusercontent.com/victronenergy/velib_python/master"
    for f in vedbus.py ve_utils.py dbusmonitor.py settingsdevice.py; do
        wget -q "$VELIB_BASE/$f" -O "$VELIB_DIR/$f" && echo "    $f" || true
    done
    echo "[OK] velib_python heruntergeladen"
fi

# ── 4. Konfigurationsdatei anlegen (falls noch nicht vorhanden) ───────────────
ENV_FILE="$INSTALL_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<'EOF'
# URL des shelly-monitor Servers (IP oder Hostname im lokalen Netz)
SHELLY_MONITOR_URL=http://192.168.1.100:3000/api/data

# Abfrageintervall in Sekunden
POLL_INTERVAL=10

# dbus-Instanznummer (30+ empfohlen für externe Geräte)
PV_INVERTER_INSTANCE=30

# Anzeigename im Cerbo GX / VRM-Portal
PV_INVERTER_NAME=Shelly PV Messung

# AC-Position: 0=AC-Eingang 1, 1=AC-Ausgang (Hausbus), 2=AC-Eingang 2
PV_INVERTER_POSITION=1
EOF
    echo "[OK] Konfigurationsdatei angelegt: $ENV_FILE"
    echo "     >>> Bitte SHELLY_MONITOR_URL in $ENV_FILE eintragen! <<<"
else
    echo "[OK] Konfigurationsdatei vorhanden: $ENV_FILE"
fi

# ── 5. Daemontools-Dienst einrichten (Venus OS Standard) ─────────────────────
mkdir -p "$DAEMONTOOLS_SVC"
cat > "$DAEMONTOOLS_SVC/run" <<RUNSCRIPT
#!/bin/sh
# Umgebungsvariablen laden
if [ -f $INSTALL_DIR/.env ]; then
    export \$(grep -v '^#' $INSTALL_DIR/.env | xargs)
fi
exec python3 $INSTALL_DIR/cerbo_pv_inverter.py
RUNSCRIPT
chmod +x "$DAEMONTOOLS_SVC/run"

mkdir -p "$DAEMONTOOLS_SVC/log"
cat > "$DAEMONTOOLS_SVC/log/run" <<'LOGRUN'
#!/bin/sh
exec multilog t /var/log/shelly-pv-inverter
LOGRUN
chmod +x "$DAEMONTOOLS_SVC/log/run"

echo "[OK] Daemontools-Dienst eingerichtet: $DAEMONTOOLS_SVC"

# ── 6. Dienst starten ─────────────────────────────────────────────────────────
echo
echo "=== Installation abgeschlossen ==="
echo
echo "Nächste Schritte:"
echo "  1. SHELLY_MONITOR_URL in $ENV_FILE eintragen"
echo "  2. Dienst starten:  svc -u $DAEMONTOOLS_SVC"
echo "  3. Logs prüfen:     tail -f /var/log/shelly-pv-inverter/current"
echo "  4. dbus prüfen:     dbus-spy  (im Cerbo GX GUI)"
echo
echo "Der Dienst startet beim nächsten Cerbo-Neustart automatisch."
