/**
 * sync.js — WebRTC P2P with self-contained SDP codes
 *
 * ─── THE APPROACH ────────────────────────────────────────────────
 *
 * We eliminate ALL external API dependencies by encoding the full
 * WebRTC SDP directly into a compact base64url string (~300 chars).
 *
 * Instead of storing SDP somewhere and exchanging a short lookup key,
 * the code IS the SDP — just compressed and encoded.
 *
 * The code is displayed in 4-character groups for easy copy-paste:
 *   eyJ0-Ijoi-byIs-InUi-OiJh-QmNE-...
 *
 * This works 100% offline after initial page load, with zero API
 * calls, zero dependencies, and zero points of failure.
 *
 * ─── SDP COMPRESSION ─────────────────────────────────────────────
 *
 * A raw Chrome/Firefox SDP for a DataChannel is ~1.5KB.
 * We extract only the 5 fields WebRTC actually needs:
 *   u = ice-ufrag   (~4 chars)
 *   p = ice-pwd     (~24 chars)
 *   f = fingerprint (~64 hex chars, colons stripped)
 *   s = setup       (1 char: 'a'=actpass, 'c'=active, 'p'=passive)
 *   c = candidates  (ip|port|type encoded, comma-separated)
 *
 * Serialised to JSON then base64url → ~280-320 chars.
 * Displayed in 4-char hyphen-separated groups for readability.
 *
 * ─── CONNECTION FLOW ─────────────────────────────────────────────
 *
 *   HOST creates room:
 *     → createOffer() + gather ICE
 *     → encodeSDP(localDescription) → OFFER_CODE (~300 chars)
 *     → User copies OFFER_CODE, shares with guest (any channel)
 *
 *   GUEST joins:
 *     → Pastes OFFER_CODE
 *     → decodeSDP(OFFER_CODE) → RTCSessionDescription
 *     → setRemoteDescription(offer)
 *     → createAnswer() + gather ICE
 *     → encodeSDP(localDescription) → ANSWER_CODE (~300 chars)
 *     → User copies ANSWER_CODE, shares back with host
 *
 *   HOST finishes:
 *     → Pastes ANSWER_CODE
 *     → decodeSDP(ANSWER_CODE) → RTCSessionDescription
 *     → setRemoteDescription(answer)
 *     → ICE negotiation begins → DataChannel opens → CONNECTED!
 *
 * ─────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  /* ── ICE servers (public STUN, no TURN needed for most networks) */
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302'   },
    { urls: 'stun:stun1.l.google.com:19302'  },
    { urls: 'stun:stun.cloudflare.com:3478'  },
    { urls: 'stun:stun.stunprotocol.org:3478' },
  ];

  const ICE_GATHER_TIMEOUT = 10000; // ms — wait up to 10s for candidates
  const PING_INTERVAL      = 6000;
  const PING_TIMEOUT       = 15000;

  /* ════════════════════════════════════════════════════════════════
     SDP ENCODE / DECODE
     Converts a full RTCSessionDescription ↔ compact base64url code
  ════════════════════════════════════════════════════════════════ */

  /**
   * Encode an RTCSessionDescription into a compact shareable code.
   * @param {RTCSessionDescription|{type,sdp}} desc
   * @returns {string}  base64url string, ~280-320 chars
   */
  function encodeSDP(desc) {
    const lines = desc.sdp.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    const get = (prefix) => {
      const line = lines.find(l => l.startsWith(prefix));
      return line ? line.slice(prefix.length).trim() : '';
    };

    // Fingerprint: strip colons  "AA:BB:CC..." → "AABBCC..."
    const fp = get('a=fingerprint:sha-256 ').replace(/:/g, '');

    // Setup: encode as single char
    const setupMap = { actpass: 'a', active: 'c', passive: 'p', holdconn: 'h' };
    const setup = setupMap[get('a=setup:')] || 'a';

    // Candidates: encode as "ip|port|typeproto" or "ip|port|typeproto|raddr|rport"
    const cands = lines
      .filter(l => l.startsWith('a=candidate:'))
      .map(l => {
        const p = l.slice('a=candidate:'.length).split(' ');
        // p[2]=protocol, p[4]=ip, p[5]=port, p[7]=typ
        const proto  = (p[2] || 'udp').toLowerCase();
        const ip     = p[4] || '';
        const port   = p[5] || '';
        const ctype  = p[7] || 'host';

        if (!ip || !port) return null;

        const ptag = proto === 'tcp' ? 't' : 'u';

        if (ctype === 'srflx') {
          // Find raddr (index 9) and rport (index 11)
          const raddr = p[9] || '';
          const rport = p[11] || '';
          return `${ip}|${port}|s${ptag}|${raddr}|${rport}`;
        }
        if (ctype === 'host') {
          return `${ip}|${port}|h${ptag}`;
        }
        return null; // skip relay (requires TURN), prflx, etc.
      })
      .filter(Boolean);

    const mini = {
      t: desc.type[0],   // 'o' = offer, 'a' = answer
      u: get('a=ice-ufrag:'),
      p: get('a=ice-pwd:'),
      f: fp,
      s: setup,
      c: cands,
    };

    const json   = JSON.stringify(mini);
    const b64url = btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    return b64url;
  }

  /**
   * Decode a shareable code back into an RTCSessionDescription object.
   * Tolerates hyphens, spaces, and mixed case (display formatting).
   * @param {string} code
   * @returns {{ type: string, sdp: string }}
   */
  function decodeSDP(code) {
    // Strip display formatting (hyphens, spaces, newlines)
    const clean = code.replace(/[\s\-\n\r]/g, '');

    // Restore base64 padding
    const padded = clean + '===='.slice(0, (4 - clean.length % 4) % 4);
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');

    let json;
    try {
      json = decodeURIComponent(escape(atob(base64)));
    } catch (e) {
      throw new Error('Invalid code — could not decode. Make sure you copied the full code.');
    }

    let mini;
    try {
      mini = JSON.parse(json);
    } catch (e) {
      throw new Error('Invalid code — corrupted data. Please re-copy and try again.');
    }

    const required = ['t', 'u', 'p', 'f', 'c'];
    for (const k of required) {
      if (mini[k] === undefined || mini[k] === null) {
        throw new Error(`Invalid code — missing field "${k}". The code may be truncated.`);
      }
    }

    // Reconstruct type
    const type = mini.t === 'o' ? 'offer' : 'answer';

    // Reconstruct fingerprint with colons
    const fp = (mini.f.match(/.{1,2}/g) || []).join(':');

    // Reconstruct setup
    const setupMap = { a: 'actpass', c: 'active', p: 'passive', h: 'holdconn' };
    const setup = setupMap[mini.s] || 'actpass';

    // Reconstruct candidate lines
    const candidates = (Array.isArray(mini.c) ? mini.c : [])
      .map((c, i) => {
        const parts   = c.split('|');
        const ip      = parts[0];
        const port    = parts[1];
        const ctag    = parts[2] || 'hu'; // 'hu'=host-udp, 'su'=srflx-udp, etc.
        const ctype   = ctag[0];          // 'h' or 's'
        const proto   = ctag[1] === 't' ? 'tcp' : 'udp';
        const prio    = ctype === 's' ? (1686052607 - i) : (2122260223 - i);

        if (ctype === 's') {
          const raddr = parts[3] || ip;
          const rport = parts[4] || port;
          return `a=candidate:${i + 1} 1 ${proto} ${prio} ${ip} ${port} typ srflx raddr ${raddr} rport ${rport} generation 0`;
        }
        return `a=candidate:${i + 1} 1 ${proto} ${prio} ${ip} ${port} typ host generation 0`;
      })
      .join('\r\n');

    const sdp = [
      'v=0',
      'o=- 0 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=group:BUNDLE 0',
      'a=msid-semantic: WMS',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'c=IN IP4 0.0.0.0',
      `a=ice-ufrag:${mini.u}`,
      `a=ice-pwd:${mini.p}`,
      'a=ice-options:trickle',
      `a=fingerprint:sha-256 ${fp}`,
      `a=setup:${setup}`,
      'a=mid:0',
      'a=sctp-port:5000',
      'a=max-message-size:262144',
      candidates,
      'a=end-of-candidates',
      '',
    ].join('\r\n');

    return { type, sdp };
  }

  /**
   * Format a raw code string into readable 4-char groups.
   * e.g. "eyJ0IjoibyIsInUiOiJh..." → "eyJ0-Ijoi-byIs-..."
   * @param {string} code
   * @returns {string}
   */
  function formatCode(code) {
    return code.replace(/(.{4})/g, '$1-').replace(/-$/, '');
  }

  /* ════════════════════════════════════════════════════════════════
     SYNC ENGINE
  ════════════════════════════════════════════════════════════════ */

  class SyncEngine extends EventTarget {
    constructor() {
      super();
      this._pc        = null;
      this._ch        = null;
      this._connected = false;
      this._isHost    = false;
      this._queue     = [];
      this._pingTimer = null;
      this._pongTimer = null;
    }

    /* ── HOST: createOffer → returns formatted code ─────────────── */
    async createOfferCode() {
      this._isHost = true;
      this._setupPC();

      // Host creates the data channel
      this._ch = this._pc.createDataChannel('tictac', {
        ordered:  true,
        protocol: 'tictac-v1',
      });
      this._wireChannel(this._ch);

      await this._pc.setLocalDescription(await this._pc.createOffer());
      const desc = await this._gatherICE();

      return formatCode(encodeSDP(desc));
    }

    /* ── GUEST: offerCode → createAnswer → returns formatted code ── */
    async createAnswerCode(offerCode) {
      this._isHost = false;
      this._setupPC();

      // Guest receives channel from host
      this._pc.ondatachannel = (e) => {
        this._ch = e.channel;
        this._wireChannel(this._ch);
      };

      // Decode and apply the offer
      const offerDesc = decodeSDP(offerCode);
      await this._pc.setRemoteDescription(new RTCSessionDescription(offerDesc));

      await this._pc.setLocalDescription(await this._pc.createAnswer());
      const desc = await this._gatherICE();

      return formatCode(encodeSDP(desc));
    }

    /* ── HOST: accept formatted answer code ─────────────────────── */
    async acceptAnswerCode(answerCode) {
      const answerDesc = decodeSDP(answerCode);
      await this._pc.setRemoteDescription(new RTCSessionDescription(answerDesc));
      // ICE proceeds → DataChannel opens → fires 'connected'
    }

    /* ── Send a typed game message ───────────────────────────────── */
    send(type, payload) {
      const raw = JSON.stringify({ type, payload });
      if (this._ch?.readyState === 'open') {
        try { this._ch.send(raw); return; } catch (_) {}
      }
      this._queue.push(raw);
    }

    /* ── Tear down everything ────────────────────────────────────── */
    disconnect() {
      this._stopPing();
      try { this._ch?.close(); } catch (_) {}
      try { this._pc?.close(); } catch (_) {}
      this._ch        = null;
      this._pc        = null;
      this._connected = false;
      this._queue     = [];
    }

    get isConnected() { return this._connected; }
    get isHost()      { return this._isHost; }

    /* ── Private: init RTCPeerConnection ────────────────────────── */
    _setupPC() {
      this.disconnect();
      this._pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      this._pc.oniceconnectionstatechange = () => {
        const s = this._pc?.iceConnectionState;
        console.log('[sync] ICE:', s);
        if (s === 'failed' || s === 'disconnected') {
          this._connected = false;
          this._stopPing();
          this._dispatch('statuschange', { status: 'offline' });
        }
      };

      this._pc.onconnectionstatechange = () => {
        console.log('[sync] Conn:', this._pc?.connectionState);
      };
    }

    /* ── Private: wait for ICE gathering to finish ───────────────── */
    _gatherICE() {
      return new Promise((resolve) => {
        const done = () => {
          if (this._pc?.iceGatheringState === 'complete') {
            resolve(this._pc.localDescription);
          }
        };

        // Already complete (rare but possible)
        if (this._pc.iceGatheringState === 'complete') {
          resolve(this._pc.localDescription);
          return;
        }

        this._pc.onicegatheringstatechange = done;

        // Hard timeout — don't wait forever
        const timer = setTimeout(() => {
          console.warn('[sync] ICE gather timeout — using partial candidates');
          resolve(this._pc.localDescription);
        }, ICE_GATHER_TIMEOUT);

        // Clean up timer if we finish early
        this._pc.onicegatheringstatechange = () => {
          if (this._pc?.iceGatheringState === 'complete') {
            clearTimeout(timer);
            resolve(this._pc.localDescription);
          }
        };
      });
    }

    /* ── Private: wire up DataChannel event handlers ─────────────── */
    _wireChannel(ch) {
      ch.onopen = () => {
        console.log('[sync] ✓ DataChannel open');
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

      ch.onerror = (e) => {
        console.warn('[sync] DataChannel error:', e);
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
        } catch (err) {
          console.warn('[sync] bad message:', err);
        }
      };
    }

    /* ── Private: flush queued messages after reconnect ─────────── */
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

    /* ── Private: keepalive ping/pong ────────────────────────────── */
    _startPing() {
      this._stopPing();
      this._pingTimer = setInterval(() => {
        if (this._ch?.readyState === 'open') {
          this.send('PING', {});
          this._pongTimer = setTimeout(() => {
            console.warn('[sync] Pong timeout — peer offline');
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

    /* ── Private: dispatch CustomEvent ──────────────────────────── */
    _dispatch(name, detail) {
      this.dispatchEvent(new CustomEvent(name, { detail }));
    }
  }

  /* Export globals */
  window.TicTacSync = new SyncEngine();

  // Expose for debugging in console
  window._decodeSDP = decodeSDP;
  window._encodeSDP = encodeSDP;

})();
