// Transporte P2P com PeerJS (WebRTC). O servidor público do PeerJS só faz a
// "apresentação" entre navegadores; o jogo trafega direto entre eles.
/* global Peer */

const PREFIX = 'dominio-global-v1-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(len = 5) {
  let s = '';
  const buf = crypto.getRandomValues(new Uint32Array(len));
  for (const v of buf) s += ALPHABET[v % ALPHABET.length];
  return s;
}

export function normalizeCode(c) {
  return (c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

/** Anfitrião: abre a sala com o código dado e aceita conexões. */
export class HostTransport {
  constructor(code, { onOpen, onMessage, onLeave, onError }) {
    this.code = code;
    this.conns = new Set();
    this.handlers = { onOpen, onMessage, onLeave, onError };
    this.attempts = 0;
    this.start();
  }

  start() {
    this.peer = new Peer(PREFIX + this.code, { debug: 0 });
    this.peer.on('open', () => { this.attempts = 0; this.handlers.onOpen?.(); });
    this.peer.on('connection', (conn) => this.accept(conn));
    this.peer.on('disconnected', () => {
      // perdeu o servidor de sinalização: as conexões existentes continuam
      setTimeout(() => !this.peer.destroyed && this.peer.reconnect(), 1500);
    });
    this.peer.on('error', (e) => {
      if (e.type === 'unavailable-id' && this.attempts++ < 12) {
        // o código ainda está preso (ex.: recarregou a página); tenta de novo
        this.peer.destroy();
        setTimeout(() => this.start(), 2500);
        return;
      }
      if (e.type === 'peer-unavailable') return;
      this.handlers.onError?.(e);
    });
  }

  accept(conn) {
    conn.on('open', () => this.conns.add(conn));
    conn.on('data', (msg) => this.handlers.onMessage?.(conn, msg));
    const gone = () => {
      if (!this.conns.delete(conn)) return;
      this.handlers.onLeave?.(conn);
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  send(conn, msg) {
    if (conn.open) conn.send(msg);
  }

  broadcast(fn) {
    for (const c of this.conns) if (c.open) c.send(fn(c));
  }

  destroy() { this.peer?.destroy(); }
}

/** Convidado: conecta na sala e reconecta sozinho se cair. */
export class ClientTransport {
  constructor(code, { onOpen, onMessage, onStatus }) {
    this.code = code;
    this.handlers = { onOpen, onMessage, onStatus };
    this.closed = false;
    this.peer = new Peer({ debug: 0 });
    this.peer.on('open', () => this.connect());
    this.peer.on('disconnected', () => !this.closed && setTimeout(() => this.peer.reconnect(), 1500));
    this.peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') {
        this.handlers.onStatus?.('notfound');
        this.retry();
      } else {
        this.handlers.onStatus?.('error', e);
      }
    });
  }

  connect() {
    if (this.closed) return;
    this.handlers.onStatus?.('connecting');
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true, serialization: 'json' });
    this.conn = conn;
    conn.on('open', () => { this.handlers.onStatus?.('online'); this.handlers.onOpen?.(); });
    conn.on('data', (msg) => this.handlers.onMessage?.(msg));
    conn.on('close', () => { if (this.conn === conn) { this.handlers.onStatus?.('offline'); this.retry(); } });
  }

  retry() {
    if (this.closed || this.retrying) return;
    this.retrying = true;
    setTimeout(() => { this.retrying = false; if (!this.conn?.open) this.connect(); }, 2500);
  }

  send(msg) {
    if (this.conn?.open) { this.conn.send(msg); return true; }
    return false;
  }

  destroy() { this.closed = true; this.peer?.destroy(); }
}
