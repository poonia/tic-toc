/**
 * sync.js — WebRTC P2P sync with reliable short-code SDP exchange
 *
 * ─── HOW SHORT CODES WORK ────────────────────────────────────────
 *
 * Problem: WebRTC SDP is ~2KB of text. Humans can't type that.
 *
 * Solution: We store the SDP in a free anonymous key-value store
 * and give users a 6-character alphanumeric code to exchange.
 *
 * The SDP is stored using THREE brokers tried in order:
 *   1. npoint.io       — free anonymous JSON store, no auth
 *   2. paste.rs        — anonymous pastebin, CORS enabled
 *   3. localStorage    — same-browser fallback (for local testing)
 *
 * A localStorage registry persists code→{broker,fullId} so lookups
 * work after page refresh on the same device.
 *
 * ─── CONNECTION FLOW ─────────────────────────────────────────────
 *
 *   HOST                              GUEST
 *   ────                              ─────
 *   1. Create RTCPeerConnection
 *   2. Create DataChannel
 *   3. Create SDP offer + ICE
 *   4. Store SDP → OFFER CODE         ← Share OFFER CODE
 *                                     5. Fetch SDP by OFFER CODE
 *                                     6. Set remote description
 *                                     7. Create SDP answer + ICE
 *   Share ANSWER CODE ───────────→    8. Store SDP → ANSWER CODE
 *   9.  Fetch SDP by ANSWER CODE
 *   10. Set remote description
 *   11. ICE connects! ↔↔↔↔↔↔↔↔↔↔↔ 11. ICE connects!
 *   12. DataChannel opens ↔↔↔↔↔↔↔  12. DataChannel opens
 *
 * ─────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── ICE Servers ─────────────────────────────────────────────── */
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  const ICE_TIMEOUT   = 8000;  // ms to wait for ICE gathering
  const PING_INTERVAL = 6000;
  const PING_TIMEOUT  = 15000;

  /* ══════════════════════════════════════════════════════════════
     SDP BROKERS
     Each must implement:
       store(text: string) → Promise<{ code: string, fullId: string }>
       fetch(fullId: string) → Promise<string>
  ══════════════════════════════════════════════════════════════ */

  /**
   * Broker 1: npoint.io — free anonymous JSON storage, no auth needed.
   * POST /bins → { id, data }
   * GET  /bins/{id} → { id, data }
   */
  const npointBroker = {
    name: 'npoint',

    async store(text) {
      const res = await fetch('https://api.npoint.io/bins', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ sdp: text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const id   = String(data.id || data._id || '');
      if (!id) throw new Error('no id in response');
      const code = makeCode(id);
      return { code, fullId: id };
    },

    async fetch(fullId) {
      const res = await fetch(`https://api.npoint.io/bins/${fullId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.sdp) throw new Error('no sdp field');
      return data.sdp;
    },
  };

  /**
   * Broker 2: paste.rs — anonymous text pastebin with CORS headers.
   * POST / with text body → returns URL as plain text (e.g. https://paste.rs/Abc)
   * GET  /{id} → returns stored text
   */
  const pastersBroker = {
    name: 'paste.rs',

    async store(text) {
      const res = await fetch('https://paste.rs/', {
        method:  'POST',
        headers: { 'Content-Type': 'text/plain' },
        body:    text,
      });
      // paste.rs returns 201 on success
      if (res.status !== 201 && !res.ok) throw new Error(`HTTP ${res.status}`);
      const url  = (await res.text()).trim();
      // URL is like: https://paste.rs/xYz  or  https://paste.rs/xYz.txt
      const id   = url.split('/').pop().replace(/\.txt$/, '').trim();
      if (!id) throw new Error('no paste id in response');
      const code = makeCode(id);
      return { code, fullId: id };
    },

    async fetch(fullId) {
      // Try plain URL first, then .txt variant
      for (const suffix of ['', '.txt']) {
        try {
          const res = await fetch(`https://paste.rs/${fullId}${suffix}`);
          if (res.ok) return await res.text();
        } catch (_) {}
      }
      throw new Error(`paste.rs: could not fetch ${fullId}`);
    },
  };

  /**
   * Broker 3: localStorage — works only within the same browser.
   * Used as a last resort for same-device testing.
   */
  const localBroker = {
    name: 'local',
    _mem: new Map(),

    async store(text) {
      const code = randomCode(6);
      this._mem.set(code, text);
      _lsSet('tictac:sdp:' + code, text);
      return { code, fullId: code };
    },

    async fetch(fullId) {
      const code = fullId.toUpperCase();
      if (this._mem.has(code)) return this._mem.get(code);
      const v = _lsGet('tictac:sdp:' + code);
      if (v) return v;
      throw new Error(`local: code ${code} not found`);
    },
  };

  /* ── Broker list — tried in order ────────────────────────────── */
  const BROKERS = [npointBroker, pastersBroker, localBroker];

  /* ── Code registry — maps 6-char code → { brokerName, fullId } ── */
  const REG_KEY = 'tictac:code-registry';

  function regGet(code) {
    try {
      const m = JSON.parse(localStorage.getItem(REG_KEY) || '{}');
      return m[code.toUpperCase()] || null;
    } catch (_) { return null; }
  }

  function regSet(code, brokerName, fullId) {
    try {
      const m = JSON.parse(localStorage.getItem(REG_KEY) || '{}');
      m[code.toUpperCase()] = { brokerName, fullId };
      // Cap at 20 entries to stay lean
      const keys = Object.keys(m);
      if (keys.length > 20) delete m[keys[0]];
      localStorage.setItem(REG_KEY, JSON.stringify(m));
    } catch (_) {}
  }

  /* ── Helpers ─────────────────────────────────────────────────── */

  /** Convert any ID string to a 6-char uppercase display code */
  function makeCode(id) {
    const clean = String(id).replace(/[^A-Za-z0-9]/g, '');
    return clean.slice(-6).toUpperCase().padStart(6, 'X');
  }

  /** Generate a random N-char code — avoids ambiguous chars */
  function randomCode(n) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  /** localStorage helpers with error swallowing */
  function _lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch (_) {}
  }
  function _lsGet(key) {
    try { return localStorage.getItem(key) || null; } catch (_) { return null; }
  }

  /* ── Core store/fetch with multi-broker fallback ─────────────── */

  async function storeSDP(text) {
    const errs = [];
    for (const broker of BROKERS) {
      try {
        console.log(`[sync] store → trying ${broker.name}`);
        const { code, fullId } = await broker.store(text);
        regSet(code, broker.name, fullId);
        console.log(`[sync] stored via ${broker.name}: code=${code} fullId=${fullId}`);
        return code;
      } catch (e) {
        console.warn(`[sync] ${broker.name} store failed:`, e.message);
        errs.push(e.message);
      }
    }
    throw new Error('All SDP brokers failed: ' + errs.join(' | '));
  }

  async function fetchSDP(code) {
    const upper  = code.toUpperCase().trim();
    const entry  = regGet(upper);

    // Fast path: we have the exact broker + fullId registered
    if (entry) {
      const broker = BROKERS.find(b => b.name === entry.brokerName);
      if (broker) {
        try {
          const text = await broker.fetch(entry.fullId);
          console.log(`[sync] fetched via registered ${broker.name}`);
          return text;
        } catch (e) {
          console.warn(`[sync] registered broker fetch failed, trying fallbacks:`, e.message);
        }
      }
    }

    // Slow path: code came from another device, try each broker treating
    // the 6-char code itself as the fullId (works for local broker at least)
    const errs = [];
    for (const broker of BROKERS) {
      try {
        const text = await broker.fetch(upper);
        console.log(`[sync] fetched via fallback ${broker.name}`);
        return text;
      } catch (e) {
        errs.push(`${broker.name}: ${e.message}`);
      }
    }

    throw new Error(
      `Cannot find SDP for code "${upper}". ` +
      'Check the code is correct and both devices are online. ' +
      '(' + errs.join(' | ') + ')'
    );
  }

  /* ══════════════════════════════════════════════════════════════
     SYNC ENGINE
  ══════════════════════════════════════════════════════════════ */

  class SyncEngine extends EventTarget {

    constructor() {
      super();
      this._pc        = null;
      this._ch        = null;   // RTCDataChannel
      this._connected = false;
      this._isHost    = false;
      this._queue     = [];     // messages buffered while offline
      this._pingTimer = null;
      this._pongTimer = null;
    }

    /* ── HOST: create offer → return 6-char code ─────────────── */
    async createOfferCode() {
      this._isHost = true;
      this._initPC();

      // Host creates the DataChannel
      this._ch = this._pc.createDataChannel('tictac', { ordered: true });
      this._wireChannel(this._ch);

      // Generate offer and wait for all ICE candidates
      await this._pc.setLocalDescription(await this._pc.createOffer());
      const desc = await this._waitICE();

      // Store and return short code
      return storeSDP(JSON.stringify({ type: desc.type, sdp: desc.sdp }));
    }

    /* ── GUEST: take offer code → return 6-char answer code ───── */
    async createAnswerCode(offerCode) {
      this._isHost = false;
      this._initPC();

      // Guest receives DataChannel from host
      this._pc.ondatachannel = (e) => {
        this._ch = e.channel;
        this._wireChannel(this._ch);
      };

      // Fetch host's SDP and apply it
      const offerText = await fetchSDP(offerCode);
      const offerObj  = JSON.parse(offerText);
      await this._pc.setRemoteDescription(new RTCSessionDescription(offerObj));

      // Generate answer and wait for ICE
      await this._pc.setLocalDescription(await this._pc.createAnswer());
      const desc = await this._waitICE();

      // Store and return short code
      return storeSDP(JSON.stringify({ type: desc.type, sdp: desc.sdp }));
    }

    /* ── HOST: apply guest's answer code ────────────────────────── */
    async acceptAnswerCode(answerCode) {
      const answerText = await fetchSDP(answerCode);
      const answerObj  = JSON.parse(answerText);
      await this._pc.setRemoteDescription(new RTCSessionDescription(answerObj));
      // ICE will connect; DataChannel open event fires 'connected'
    }

    /* ── Send a typed message to peer ───────────────────────────── */
    send(type, payload) {
      const raw = JSON.stringify({ type, payload });
      if (this._ch?.readyState === 'open') {
        try { this._ch.send(raw); return; }
        catch (_) { /* fall through to queue */ }
      }
      this._queue.push(raw);
    }

    /* ── Tear down ───────────────────────────────────────────────── */
    disconnect() {
      this._stopPing();
      try { this._ch?.close();  } catch (_) {}
      try { this._pc?.close();  } catch (_) {}
      this._ch        = null;
      this._pc        = null;
      this._connected = false;
      this._queue     = [];
    }

    get isConnected() { return this._connected; }
    get isHost()      { return this._isHost; }

    /* ── Private ─────────────────────────────────────────────────── */

    _initPC() {
      this.disconnect();
      this._pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      this._pc.oniceconnectionstatechange = () => {
        const s = this._pc?.iceConnectionState;
        console.log('[sync] ICE state:', s);
        if (s === 'failed' || s === 'disconnected') {
          this._connected = false;
          this._stopPing();
          this._dispatch('statuschange', { status: 'offline' });
        }
      };
    }

    _waitICE() {
      return new Promise((resolve) => {
        if (this._pc.iceGatheringState === 'complete') {
          resolve(this._pc.localDescription);
          return;
        }
        this._pc.onicegatheringstatechange = () => {
          if (this._pc.iceGatheringState === 'complete') {
            resolve(this._pc.localDescription);
          }
        };
        setTimeout(() => {
          console.warn('[sync] ICE gather timeout — proceeding with partial candidates');
          resolve(this._pc.localDescription);
        }, ICE_TIMEOUT);
      });
    }

    _wireChannel(ch) {
      ch.onopen = () => {
        console.log('[sync] DataChannel OPEN ✓');
        this._connected = true;
        this._dispatch('statuschange', { status: 'connected' });
        this._startPing();
        this._flushQueue();
      };
      ch.onclose = () => {
        console.log('[sync] DataChannel closed');
        this._connected = false;
        this._stopPing();
        this._dispatch('statuschange', { status: 'offline' });
      };
      ch.onerror = () => {
        this._connected = false;
        this._dispatch('statuschange', { status: 'offline' });
      };
      ch.onmessage = (e) => {
        try {
          const { type, payload } = JSON.parse(e.data);
          if (type === 'PING') { this.send('PONG', {}); return; }
          if (type === 'PONG') {
            clearTimeout(this._pongTimer);
            this._pongTimer = null;
            return;
          }
          this._dispatch('message', { type, payload });
        } catch (_) {}
      };
    }

    _flushQueue() {
      const q = [...this._queue];
      this._queue = [];
      for (const raw of q) {
        if (this._ch?.readyState === 'open') {
          try { this._ch.send(raw); }
          catch (_) { this._queue.push(raw); }
        }
      }
    }

    _startPing() {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this._ch?.readyState === 'open') {
          this.send('PING', {});
          this._pongTimer = setTimeout(() => {
            this._connected = false;
            this._dispatch('statuschange', { status: 'offline' });
          }, PING_TIMEOUT);
        }
      }, PING_INTERVAL);
    }

    _stopPing() {
      clearInterval(this._pingTimer);
      clearTimeout(this._pongTimer);
      this._pingTimer = null;
      this._pongTimer = null;
    }

    _dispatch(name, detail) {
      this.dispatchEvent(new CustomEvent(name, { detail }));
    }
  }

  window.TicTacSync = new SyncEngine();

})();
