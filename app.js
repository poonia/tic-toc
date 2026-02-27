/**
 * app.js — Main game controller (PaperCSS + short-code edition)
 *
 * Uses TicTacSync's 6-character code API instead of raw SDP.
 * Same CRDT game logic — only the UI and connection flow changed.
 */

(function () {
  'use strict';

  /* ── Device identity ────────────────────────────────────────── */
  const DEVICE_ID = (() => {
    let id = localStorage.getItem('tictac-device-id');
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('tictac-device-id', id);
    }
    return id;
  })();

  /* ── Win patterns ───────────────────────────────────────────── */
  const WIN_LINES = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6],
  ];

  /* ── App state ──────────────────────────────────────────────── */
  let state = {
    roomId:        null,
    myRole:        null,
    moves:         [],
    board:         Array(9).fill(null),
    currentPlayer: 'X',
    status:        'playing',
    winner:        null,
    winLine:       null,
    isHost:        false,
  };

  /* ── DOM helpers ────────────────────────────────────────────── */
  const $ = (id) => document.getElementById(id);

  /* ── Screen management ──────────────────────────────────────── */
  const SCREENS = ['lobby', 'connect', 'game'];

  function showScreen(name) {
    SCREENS.forEach(s => {
      const el = $(`screen-${s}`);
      if (el) el.classList.toggle('active', s === name);
    });
  }

  /* ── Toasts ─────────────────────────────────────────────────── */
  function toast(msg, duration = 3000) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    $('toast-container').appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  /* ── Room ID generator (short, readable) ────────────────────── */
  function genRoomId() {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  /* ── Move ID ────────────────────────────────────────────────── */
  function genMoveId() {
    return `${DEVICE_ID}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  }

  /* ════════════════════════════════════════════════════════════ */
  /*  CRDT ENGINE                                                  */
  /* ════════════════════════════════════════════════════════════ */

  /**
   * Derive canonical board state from a move log.
   * Conflict resolution: earliest timestamp wins; ties by deviceId.
   */
  function deriveState(moves) {
    const board = Array(9).fill(null);

    const sorted = [...moves].sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.deviceId < b.deviceId ? -1 : 1;
    });

    for (const move of sorted) {
      if (board[move.cell] === null) {
        board[move.cell] = move.player;
      }
    }

    let winner = null, winLine = null;
    for (const line of WIN_LINES) {
      const [a, b, c] = line;
      if (board[a] && board[a] === board[b] && board[a] === board[c]) {
        winner = board[a]; winLine = line; break;
      }
    }

    const filled = board.filter(Boolean).length;
    const currentPlayer = filled % 2 === 0 ? 'X' : 'O';
    const status = winner ? 'win' : filled === 9 ? 'draw' : 'playing';

    return { board, currentPlayer, status, winner, winLine };
  }

  function mergeMoves(local, incoming) {
    const map = new Map();
    for (const m of local)    map.set(m.id, m);
    for (const m of incoming) map.set(m.id, m);
    return Array.from(map.values());
  }

  /* ════════════════════════════════════════════════════════════ */
  /*  PERSISTENCE                                                  */
  /* ════════════════════════════════════════════════════════════ */

  async function persistState() {
    if (!state.roomId) return;
    try {
      await TicTacDB.saveGame({
        roomId: state.roomId, myRole: state.myRole, isHost: state.isHost,
        board: state.board, status: state.status,
        winner: state.winner, winLine: state.winLine,
        deviceId: DEVICE_ID, updatedAt: Date.now(),
      });
      for (const move of state.moves) await TicTacDB.saveMove(move);
    } catch (e) { console.warn('[db] persist:', e); }
  }

  /* ════════════════════════════════════════════════════════════ */
  /*  GAME ACTIONS                                                  */
  /* ════════════════════════════════════════════════════════════ */

  async function makeMove(cellIndex) {
    if (state.currentPlayer !== state.myRole) { toast("Not your turn ✋"); return; }
    if (state.board[cellIndex] !== null)       { toast("Already taken!"); return; }
    if (state.status !== 'playing')            return;

    const move = {
      id: genMoveId(), roomId: state.roomId,
      cell: cellIndex, player: state.myRole,
      timestamp: Date.now(), deviceId: DEVICE_ID,
    };

    await applyMoves([move]);
    TicTacSync.send('MOVE', { move });
  }

  async function applyMoves(newMoves) {
    state.moves = mergeMoves(state.moves, newMoves);
    const derived = deriveState(state.moves);
    Object.assign(state, derived);
    await persistState();
    renderBoard();
    renderPlayerBar();
    renderGameStatus();
  }

  async function restartGame() {
    state.moves = []; state.board = Array(9).fill(null);
    state.currentPlayer = 'X'; state.status = 'playing';
    state.winner = null; state.winLine = null;
    try { await TicTacDB.clearRoom(state.roomId); await persistState(); } catch (_) {}
    TicTacSync.send('RESTART', {});
    renderBoard(); renderPlayerBar(); renderGameStatus();
  }

  /* ════════════════════════════════════════════════════════════ */
  /*  SYNC EVENTS                                                   */
  /* ════════════════════════════════════════════════════════════ */

  TicTacSync.addEventListener('message', async ({ detail: { type, payload } }) => {
    switch (type) {
      case 'MOVE':
        if (payload.move) {
          payload.move.roomId = payload.move.roomId || state.roomId;
          await applyMoves([payload.move]);
        }
        break;
      case 'GAME_STATE':
        if (payload.moves) await applyMoves(payload.moves);
        break;
      case 'RESTART':
        await restartGame();
        toast('Game restarted by opponent ↺');
        break;
    }
  });

  TicTacSync.addEventListener('statuschange', ({ detail: { status } }) => {
    updateConnectionStatus(status);
    if (status === 'connected') {
      TicTacSync.send('GAME_STATE', { moves: state.moves });
      // If we're on the connect screen, move to game
      if ($('screen-connect').classList.contains('active')) enterGame();
      else toast('Opponent connected! 🎮');
    } else if (status === 'offline') {
      toast('Opponent offline — game saved locally 💾');
    }
  });

  /* ════════════════════════════════════════════════════════════ */
  /*  UI RENDERING                                                  */
  /* ════════════════════════════════════════════════════════════ */

  function renderBoard() {
    const boardEl = $('board');
    boardEl.innerHTML = '';

    for (let i = 0; i < 9; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.setAttribute('role', 'gridcell');
      cell.dataset.index = i;

      const value = state.board[i];
      if (value) {
        cell.classList.add('taken', value === 'X' ? 'x-cell' : 'o-cell');
        const mark = document.createElement('span');
        mark.className = 'mark';
        mark.textContent = value === 'X' ? '✕' : '○';
        cell.appendChild(mark);
        if (state.winLine?.includes(i)) cell.classList.add('win-cell');
      } else if (state.status === 'playing') {
        cell.addEventListener('click', () => makeMove(i));
      }

      boardEl.appendChild(cell);
    }
  }

  function renderPlayerBar() {
    const xEl = $('player-x');
    const oEl = $('player-o');
    const turnText = $('turn-text');

    const playing = state.status === 'playing';
    xEl.classList.toggle('active', state.currentPlayer === 'X' && playing);
    oEl.classList.toggle('active', state.currentPlayer === 'O' && playing);

    if (playing) {
      const isMyTurn = state.currentPlayer === state.myRole;
      turnText.textContent = isMyTurn
        ? `Your turn (${state.myRole})`
        : `${state.currentPlayer}'s turn`;
    } else {
      turnText.textContent = state.status === 'win' ? 'Game over!' : 'Draw!';
    }
  }

  function renderGameStatus() {
    const msgEl  = $('game-message');
    const textEl = $('message-text');

    if (state.status === 'win') {
      const isMe = state.winner === state.myRole;
      textEl.textContent = isMe ? '🎉 You win!' : `Player ${state.winner} wins!`;
      msgEl.classList.remove('hidden');
    } else if (state.status === 'draw') {
      textEl.textContent = "It's a draw! 🤝";
      msgEl.classList.remove('hidden');
    } else {
      msgEl.classList.add('hidden');
    }
  }

  function updateConnectionStatus(status) {
    const badge  = $('connection-status');
    const textEl = $('status-text');
    const map = {
      connected:  ['status-connected',  'Connected ✓'],
      offline:    ['status-offline',    'Offline'],
      syncing:    ['status-syncing',    'Syncing…'],
      connecting: ['status-connecting', 'Connecting…'],
    };
    const [cls, label] = map[status] || map.connecting;
    badge.className = `status-pill ${cls}`;
    textEl.textContent = label;
  }

  function setConnectStatus(text, type = 'connecting') {
    const badge  = $('connect-status');
    const textEl = $('connect-status-text');
    badge.className = `status-pill status-${type}`;
    textEl.textContent = text;
  }

  /* ════════════════════════════════════════════════════════════ */
  /*  LOBBY EVENTS                                                  */
  /* ════════════════════════════════════════════════════════════ */

  $('btn-create').addEventListener('click', async () => {
    state.roomId = genRoomId();
    state.myRole = 'X';
    state.isHost = true;
    state.moves  = [];
    state.board  = Array(9).fill(null);
    state.status = 'playing';
    state.winner = null;
    state.winLine = null;

    await persistState();

    // Show connect screen — host flow
    $('connect-title').textContent = `Room: ${state.roomId}`;
    $('flow-host').classList.remove('hidden');
    $('flow-guest').classList.add('hidden');
    showScreen('connect');
    setConnectStatus('Generating offer code…', 'connecting');

    try {
      const code = await TicTacSync.createOfferCode();
      $('host-offer-code').textContent = code;
      setConnectStatus('Share the Room Code above', 'connecting');
      toast(`Room Code ready: ${code}`);
    } catch (e) {
      console.error('[connect] createOfferCode failed:', e);
      $('host-offer-code').innerHTML = '<span class="code-loading">Error — try again</span>';
      setConnectStatus('Failed to generate code', 'offline');
      toast('Error generating code — check network');
    }
  });

  $('btn-join').addEventListener('click', async () => {
    const roomId = $('input-room-id').value.trim().toUpperCase();
    if (!roomId || roomId.length < 4) { toast('Enter a valid Room ID'); return; }

    state.roomId  = roomId;
    state.myRole  = 'O';
    state.isHost  = false;
    state.moves   = [];
    state.board   = Array(9).fill(null);
    state.status  = 'playing';
    state.winner  = null;
    state.winLine = null;

    await persistState();

    $('connect-title').textContent = `Joining: ${roomId}`;
    $('flow-guest').classList.remove('hidden');
    $('flow-host').classList.add('hidden');
    showScreen('connect');
    setConnectStatus('Waiting for host offer code…', 'waiting');
  });

  /* ── Back button ─────────────────────────────────────────────── */
  $('btn-back-lobby').addEventListener('click', () => {
    TicTacSync.disconnect();
    state.roomId = null;
    $('host-offer-code').innerHTML = '<span class="code-loading">Generating…</span>';
    $('input-answer-code').value = '';
    $('input-offer-code').value  = '';
    $('guest-step-2').classList.add('hidden');
    showScreen('lobby');
  });

  /* ── Copy buttons ────────────────────────────────────────────── */
  function copyText(text) {
    navigator.clipboard.writeText(text)
      .then(() => toast('Copied! 📋'))
      .catch(() => { toast('Copy failed — select and copy manually'); });
  }

  $('btn-copy-offer').addEventListener('click', () => {
    const code = $('host-offer-code').textContent.trim();
    if (code && code !== 'Generating…') copyText(code);
  });

  $('btn-copy-answer').addEventListener('click', () => {
    const code = $('guest-answer-code').textContent.trim();
    if (code && code !== 'Generating…') copyText(code);
  });

  /* ── Auto-uppercase all code inputs ──────────────────────────── */
  ['input-answer-code', 'input-offer-code', 'input-room-id'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const pos = el.selectionStart;
      el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      try { el.setSelectionRange(pos, pos); } catch (_) {}
    });
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasted = (e.clipboardData.getData('text') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      el.value = pasted;
    });
  });

  /* ── Host: submit answer code ────────────────────────────────── */
  $('btn-submit-answer').addEventListener('click', async () => {
    const code = $('input-answer-code').value.trim().toUpperCase();
    if (!code || code.length < 4) { toast('Enter the 6-letter Join Code'); return; }

    setConnectStatus('Fetching answer & connecting…', 'connecting');
    $('btn-submit-answer').disabled = true;

    try {
      await TicTacSync.acceptAnswerCode(code);
      setConnectStatus('Waiting for P2P connection…', 'connecting');
      // statuschange 'connected' will fire → enterGame()
    } catch (e) {
      console.error('[connect] acceptAnswerCode failed:', e);
      const msg = e.message || 'Unknown error';
      toast('⚠ ' + (msg.length > 80 ? msg.slice(0, 80) + '…' : msg), 5000);
      setConnectStatus('Connection failed — try again', 'offline');
    } finally {
      $('btn-submit-answer').disabled = false;
    }
  });

  /* ── Guest: generate answer from offer code ──────────────────── */
  $('btn-generate-answer').addEventListener('click', async () => {
    const offerCode = $('input-offer-code').value.trim().toUpperCase();
    if (!offerCode || offerCode.length < 4) { toast('Enter the host\'s Room Code'); return; }

    setConnectStatus('Fetching offer & creating answer…', 'connecting');

    $('btn-generate-answer').disabled = true;
    try {
      const answerCode = await TicTacSync.createAnswerCode(offerCode);
      $('guest-answer-code').textContent = answerCode;
      $('guest-step-2').classList.remove('hidden');
      setConnectStatus('Send your Join Code to the host', 'connecting');
      toast(`Join Code ready: ${answerCode}`);
    } catch (e) {
      console.error('[connect] createAnswerCode failed:', e);
      const msg = e.message || 'Unknown error';
      toast('⚠ ' + (msg.length > 80 ? msg.slice(0, 80) + '…' : msg), 5000);
      setConnectStatus('Failed — check the offer code & try again', 'offline');
    } finally {
      $('btn-generate-answer').disabled = false;
    }
  });

  /* ── Enter game ──────────────────────────────────────────────── */
  function enterGame() {
    $('display-room-id').textContent = state.roomId;
    $('your-role').textContent       = `You are ${state.myRole === 'X' ? '✕ X' : '○ O'}`;
    updateConnectionStatus('connected');
    renderBoard();
    renderPlayerBar();
    renderGameStatus();
    showScreen('game');
  }

  /* ════════════════════════════════════════════════════════════ */
  /*  GAME EVENTS                                                   */
  /* ════════════════════════════════════════════════════════════ */

  $('btn-restart').addEventListener('click', restartGame);

  $('btn-disconnect').addEventListener('click', async () => {
    TicTacSync.disconnect();
    if (state.roomId) await TicTacDB.clearRoom(state.roomId);
    state.roomId = null;
    showScreen('lobby');
  });

  /* ════════════════════════════════════════════════════════════ */
  /*  INIT                                                          */
  /* ════════════════════════════════════════════════════════════ */

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js')
        .then(r  => console.log('[sw] Registered:', r.scope))
        .catch(e => console.warn('[sw] Failed:', e));
    });
  }

  showScreen('lobby');
  console.log(`[app] TicTac ready. Device: ${DEVICE_ID}`);

})();
