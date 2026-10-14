// Online-Spiel über WebRTC (PeerJS). GitHub Pages ist rein statisch – die Browser verbinden sich deshalb direkt.
// Der Vermittlungsserver von PeerJS (0.peerjs.com) bringt die Browser nur zusammen; die Spielzüge laufen danach
// direkt zwischen den Geräten. Der Browser, der das Spiel erstellt, rechnet das Spiel (Gastgeber).

const PREFIX = 'hacken-sg-';
let loading = null;

export function loadPeer() {
  if (window.Peer) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'js/vendor/peerjs.min.js';
    s.onload = () => resolve();
    s.onerror = () => { loading = null; reject(new Error('Die Online-Funktion konnte nicht geladen werden.')); };
    document.head.appendChild(s);
  });
  return loading;
}

// Für Tests mit eigenem Server: ?peer=localhost:9000
function options() {
  const q = new URLSearchParams(location.search).get('peer');
  const base = { debug: 1 }; // Standard-STUN/TURN-Server von PeerJS
  if (!q) return base;
  const [host, port] = q.split(':');
  return { ...base, host, port: Number(port) || 443, path: '/', secure: host !== 'localhost' && host !== '127.0.0.1' };
}

function openPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = id ? new window.Peer(id, options()) : new window.Peer(options());
    const fail = (e) => { cleanup(); peer.destroy(); reject(e); };
    const ok = () => { cleanup(); resolve(peer); };
    const timer = setTimeout(() => fail(Object.assign(new Error('timeout'), { type: 'timeout' })), 12000);
    function cleanup() { clearTimeout(timer); peer.off('open', ok); peer.off('error', fail); }
    peer.on('open', ok);
    peer.on('error', fail);
  });
}

/** Erstellt ein Spiel mit einem freien 4-stelligen Code. */
export async function host(onConnection) {
  await loadPeer();
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    try {
      const peer = await openPeer(PREFIX + code);
      peer.on('connection', onConnection);
      peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
      peer.on('error', (e) => console.warn('Peer-Fehler', e.type));
      return { peer, code };
    } catch (e) {
      if (e.type !== 'unavailable-id') throw friendly(e);
    }
  }
  throw new Error('Es wurde kein freier Code gefunden. Bitte nochmals versuchen.');
}

/** Tritt einem Spiel bei und liefert die offene Verbindung zum Gastgeber. */
export async function join(code) {
  await loadPeer();
  let peer;
  try { peer = await openPeer(); } catch (e) { throw friendly(e); }
  return new Promise((resolve, reject) => {
    const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
    const timer = setTimeout(() => { peer.destroy(); reject(new Error('Keine Antwort vom Spiel. Stimmt der Code?')); }, 15000);
    conn.on('open', () => { clearTimeout(timer); resolve({ peer, conn }); });
    peer.on('error', (e) => { clearTimeout(timer); peer.destroy(); reject(friendly(e)); });
  });
}

function friendly(e) {
  const map = {
    'peer-unavailable': 'Kein Spiel mit diesem Code gefunden.',
    'network': 'Keine Verbindung zum Vermittlungsserver. Bist du online?',
    'server-error': 'Der Vermittlungsserver ist gerade nicht erreichbar.',
    'socket-error': 'Der Vermittlungsserver ist gerade nicht erreichbar.',
    'browser-incompatible': 'Dieser Browser unterstützt keine Online-Spiele.',
    'timeout': 'Der Vermittlungsserver antwortet nicht. Bitte später nochmals versuchen.',
  };
  return new Error(map[e?.type] || e?.message || 'Unbekannter Verbindungsfehler.');
}

export function randomToken() {
  const a = new Uint8Array(12); crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
