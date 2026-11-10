// TESTDATEN – minimale nachgebaute eufy-Brücke (eufy-security-ws) für den Jarvis-Systemcheck.
// Start: node tools/mock-eufy-ws.js   (Port 3001)   MOCK_PUSH=0 → Push-Verbindung „getrennt“
const http = require('http');
const crypto = require('crypto');

const PUSH = process.env.MOCK_PUSH !== '0';

function frame(text) {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([head, data]);
}

function parse(buf) {
  let len = buf[1] & 127, off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  const mask = buf.slice(off, off + 4);
  const payload = buf.slice(off + 4, off + 4 + len);
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode: buf[0] & 15, text: payload.toString(), size: off + 4 + len };
}

const server = http.createServer((_q, res) => res.end('eufy-security-ws (Test)'));
server.on('upgrade', (req, sock) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.write(frame(JSON.stringify({ type: 'version', driverVersion: '4.1.0', serverVersion: '3.1.0-test', minSchemaVersion: 0, maxSchemaVersion: 21 })));
  let buf = Buffer.alloc(0);
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 6) {
      const f = parse(buf);
      if (buf.length < f.size) break;
      buf = buf.slice(f.size);
      if (f.opcode === 8) { sock.end(); return; }
      const m = JSON.parse(f.text);
      const result = m.command === 'driver.is_connected' ? { connected: true } : m.command === 'driver.is_push_connected' ? { connected: PUSH } : {};
      sock.write(frame(JSON.stringify({ type: 'result', success: true, messageId: m.messageId, result })));
    }
  });
  sock.on('error', () => {});
});
server.listen(3001, () => console.log(`Test-eufy-Brücke (Testdaten) auf ws://127.0.0.1:3001 – Push ${PUSH ? 'verbunden' : 'getrennt'}`));
