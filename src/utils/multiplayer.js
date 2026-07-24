import { supabase } from '../supabase.js';

// Local Player Unique ID
export const LOCAL_PLAYER_ID = 'driver_' + Math.random().toString(36).substring(2, 9);

export const mpState = {
  isMultiplayer: false,
  isHost: false,
  roomCode: null,
  trackId: 'monaco-oval',
  channel: null,
  players: [],           // Sorted array of connected presence players: [{ id, name, carId, isHost, joinedAt, gridPos }]
  localPlayer: {
    id: LOCAL_PLAYER_ID,
    name: 'DRIVER 1',
    carId: 'scuderia-furiosa',
    joinedAt: Date.now()
  },
  remotePlayers: new Map(), // playerId -> { id, name, carId, targetX, targetY, targetRotation, speed, lap, checkpoint, timeMs, lastUpdate, sprite, nameTag }
  finishedPlayers: [],      // [{ id, name, carId, timeMs }]
  updateTimer: null,
  raceStarted: false,
  startCountDownTime: 0
};

/**
 * Generates a 4-character uppercase alphanumeric room code (e.g., R7K2)
 */
export function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Helper to retrieve local player name from DOM or localStorage
 */
export function getLocalPlayerName() {
  const input = document.getElementById('player-name-input');
  if (input && input.value.trim()) {
    return input.value.trim().toUpperCase();
  }
  return localStorage.getItem('pixel-prix:player-name') || 'DRIVER 1';
}

/**
 * Subscribe, track presence, and fail cleanly if Realtime cannot establish a
 * usable room. A timeout prevents the UI from being left in a pending state
 * when a browser loses its network without emitting a channel error.
 */
function subscribeToRoom(channel, onSubscribed, errorMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      fail(new Error(`${errorMessage} (TIMED_OUT)`));
    }, 12000);

    const succeed = (result) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      resolve(result);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      leaveMultiplayerRoom();
      reject(error);
    };

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        try {
          succeed(await onSubscribed());
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        fail(new Error(`${errorMessage} (${status})`));
      }
    });
  });
}

/**
 * Initialize / Create a new Multiplayer Room as Host
 */
export async function createMultiplayerRoom(trackId, carId, playerName) {
  if (!supabase) {
    throw new Error('Supabase client is not available. Please check network connection.');
  }

  leaveMultiplayerRoom(); // Clean up any existing connection

  const roomCode = generateRoomCode();
  const channelName = `race-${trackId}-${roomCode}`;

  mpState.isMultiplayer = true;
  mpState.isHost = true;
  mpState.roomCode = roomCode;
  mpState.trackId = trackId;
  mpState.finishedPlayers = [];
  mpState.remotePlayers.clear();

  mpState.localPlayer = {
    id: LOCAL_PLAYER_ID,
    name: playerName || getLocalPlayerName(),
    carId: carId || 'scuderia-furiosa',
    joinedAt: Date.now(),
    isHost: true
  };

  const channel = supabase.channel(channelName, {
    config: {
      broadcast: { self: false },
      presence: { key: LOCAL_PLAYER_ID }
    }
  });

  mpState.channel = channel;
  setupChannelListeners(channel);

  return subscribeToRoom(channel, async () => {
    await channel.track(mpState.localPlayer);
    return { roomCode, channelName };
  }, 'Failed to create online lobby');
}

/**
 * Join an existing Multiplayer Room as Joiner
 */
export async function joinMultiplayerRoom(roomCode, trackId, carId, playerName) {
  if (!supabase) {
    throw new Error('Supabase client is not available. Please check network connection.');
  }

  leaveMultiplayerRoom(); // Clean up any existing connection

  const cleanCode = roomCode.trim().toUpperCase();
  if (cleanCode.length < 4) {
    throw new Error('Invalid room code. Please enter a valid 4-character code.');
  }

  const channelName = `race-${trackId}-${cleanCode}`;

  mpState.isMultiplayer = true;
  mpState.isHost = false;
  mpState.roomCode = cleanCode;
  mpState.trackId = trackId;
  mpState.finishedPlayers = [];
  mpState.remotePlayers.clear();

  mpState.localPlayer = {
    id: LOCAL_PLAYER_ID,
    name: playerName || getLocalPlayerName(),
    carId: carId || 'scuderia-furiosa',
    joinedAt: Date.now(),
    isHost: false
  };

  const channel = supabase.channel(channelName, {
    config: {
      broadcast: { self: false },
      presence: { key: LOCAL_PLAYER_ID }
    }
  });

  mpState.channel = channel;
  setupChannelListeners(channel);

  return subscribeToRoom(channel, async () => {
    // Evaluate room capacity via Presence before adding this driver.
    const presenceState = channel.presenceState();
    const currentCount = Object.keys(presenceState).length;
    if (currentCount >= 8) {
      throw new Error('ONLINE LOBBY FULL (MAXIMUM 8 DRIVERS)');
    }

    await channel.track(mpState.localPlayer);
    return { roomCode: cleanCode, channelName };
  }, `Unable to join online lobby ${cleanCode}`);
}

/**
 * Configure Supabase Realtime Listeners (Presence & Broadcasts)
 */
function setupChannelListeners(channel) {
  // 1. Presence Sync (Track Lobby Players & Host Failover)
  channel.on('presence', { event: 'sync' }, () => {
    const presenceState = channel.presenceState();
    const playerList = [];

    Object.keys(presenceState).forEach((key) => {
      const presences = presenceState[key];
      if (presences && presences.length > 0) {
        playerList.push(presences[0]);
      }
    });

    // Sort players by join order (joinedAt ascending)
    playerList.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));

    const hostId = playerList[0]?.id || null;

    // Assign grid positions and derive host status from the current presence
    // list. This avoids stale HOST labels after a host disconnects.
    playerList.forEach((p, idx) => {
      p.gridPos = idx;
      p.isHost = p.id === hostId;
    });

    mpState.isHost = hostId === LOCAL_PLAYER_ID;
    mpState.localPlayer.isHost = mpState.isHost;

    mpState.players = playerList;

    // Dispatch DOM event to update Lobby UI
    window.dispatchEvent(new CustomEvent('pixel-prix:mp-lobby-update', {
      detail: { players: playerList, isHost: mpState.isHost, roomCode: mpState.roomCode }
    }));
  });

  // 2. Broadcast Listener: Race Start Command
  channel.on('broadcast', { event: 'race_start' }, (payload) => {
    const data = payload.payload;
    mpState.startCountDownTime = data.startTimestamp;
    mpState.raceStarted = true;

    window.dispatchEvent(new CustomEvent('pixel-prix:mp-race-start', { detail: data }));
  });

  // 3. Broadcast Listener: Position Updates (10 Hz)
  channel.on('broadcast', { event: 'car_update' }, (payload) => {
    const data = payload.payload;
    if (data.id === LOCAL_PLAYER_ID) return;

    const existing = mpState.remotePlayers.get(data.id) || {};
    mpState.remotePlayers.set(data.id, {
      ...existing,
      id: data.id,
      name: data.name || 'REMOTE DRIVER',
      carId: data.carId || 'scuderia-furiosa',
      targetX: data.x,
      targetY: data.y,
      targetRotation: data.rotation,
      speed: data.speed,
      lap: data.lap,
      checkpoint: data.checkpoint,
      timeMs: data.timeMs,
      lastUpdate: Date.now()
    });
  });

  // 4. Broadcast Listener: Race Finish
  channel.on('broadcast', { event: 'race_finish' }, (payload) => {
    const data = payload.payload;
    const exists = mpState.finishedPlayers.some(p => p.id === data.id);
    if (!exists) {
      mpState.finishedPlayers.push(data);
      mpState.finishedPlayers.sort((a, b) => a.timeMs - b.timeMs);
    }

    window.dispatchEvent(new CustomEvent('pixel-prix:mp-race-finish-update', {
      detail: { finishedPlayers: mpState.finishedPlayers }
    }));
  });
}

/**
 * Host Command: Broadcast Race Start with synchronized 3s future timestamp
 */
export function broadcastRaceStart() {
  if (!mpState.channel || !mpState.isHost) return;

  const startTimestamp = Date.now() + 3000;
  mpState.startCountDownTime = startTimestamp;
  mpState.raceStarted = true;

  mpState.channel.send({
    type: 'broadcast',
    event: 'race_start',
    payload: {
      startTimestamp,
      trackId: mpState.trackId,
      players: mpState.players
    }
  });

  window.dispatchEvent(new CustomEvent('pixel-prix:mp-race-start', {
    detail: { startTimestamp, trackId: mpState.trackId, players: mpState.players }
  }));
}

/**
 * Low-Rate 10 Hz Position Broadcast Loop
 */
export function startPositionBroadcast(raceScene) {
  stopPositionBroadcast();

  if (!mpState.isMultiplayer || !mpState.channel) return;

  mpState.updateTimer = setInterval(() => {
    if (!raceScene || !raceScene.player || !mpState.channel) return;

    mpState.channel.send({
      type: 'broadcast',
      event: 'car_update',
      payload: {
        id: LOCAL_PLAYER_ID,
        name: mpState.localPlayer.name,
        carId: raceScene.carData ? raceScene.carData.id : 'scuderia-furiosa',
        x: Math.round(raceScene.player.x),
        y: Math.round(raceScene.player.y),
        rotation: Number(raceScene.player.rotation.toFixed(3)),
        speed: Math.round(raceScene.currentSpeed),
        lap: raceScene.currentLap,
        checkpoint: raceScene.nextCheckpointIndex,
        timeMs: Math.round(raceScene.elapsedMs || 0)
      }
    });
  }, 100); // 10 Hz (every 100ms)
}

export function stopPositionBroadcast() {
  if (mpState.updateTimer) {
    clearInterval(mpState.updateTimer);
    mpState.updateTimer = null;
  }
}

/**
 * Broadcast Race Finish for Local Player
 */
export function broadcastRaceFinish(finalTimeMs) {
  // Keep the local finish available even if the realtime connection drops at
  // the chequered flag.  Previously the local result was only pushed into
  // state; because this client does not receive its own broadcasts, the UI
  // was never told to render it.
  if (!mpState.isMultiplayer) return;

  const finishPayload = {
    id: LOCAL_PLAYER_ID,
    name: mpState.localPlayer.name,
    carId: mpState.localPlayer.carId,
    timeMs: Math.round(finalTimeMs)
  };

  const exists = mpState.finishedPlayers.some(p => p.id === LOCAL_PLAYER_ID);
  if (!exists) {
    mpState.finishedPlayers.push(finishPayload);
    mpState.finishedPlayers.sort((a, b) => a.timeMs - b.timeMs);
  }

  window.dispatchEvent(new CustomEvent('pixel-prix:mp-race-finish-update', {
    detail: { finishedPlayers: mpState.finishedPlayers }
  }));

  if (mpState.channel) {
    mpState.channel.send({
      type: 'broadcast',
      event: 'race_finish',
      payload: finishPayload
    });
  }
}

/**
 * Computes live real-time position/rank (e.g. 2nd out of 6) for HUD
 */
export function calculateLiveRank(localLap, localCheckpoint, localTimeMs) {
  if (!mpState.isMultiplayer) return { rank: 1, total: 1 };

  const allDrivers = [
    {
      id: LOCAL_PLAYER_ID,
      score: localLap * 1000 + localCheckpoint,
      timeMs: localTimeMs
    }
  ];

  mpState.remotePlayers.forEach((rp) => {
    if (Date.now() - rp.lastUpdate < 4000) {
      allDrivers.push({
        id: rp.id,
        score: (rp.lap || 1) * 1000 + (rp.checkpoint || 1),
        timeMs: rp.timeMs || 0
      });
    }
  });

  allDrivers.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.timeMs - b.timeMs;
  });

  const rank = allDrivers.findIndex(d => d.id === LOCAL_PLAYER_ID) + 1;
  return { rank: Math.max(1, rank), total: allDrivers.length };
}

/**
 * Leave / Unsubscribe from Multiplayer Channel
 */
export function leaveMultiplayerRoom() {
  stopPositionBroadcast();

  if (mpState.channel) {
    try {
      mpState.channel.unsubscribe();
    } catch (e) {}
    mpState.channel = null;
  }

  mpState.isMultiplayer = false;
  mpState.isHost = false;
  mpState.roomCode = null;
  mpState.players = [];
  mpState.remotePlayers.clear();
  mpState.finishedPlayers = [];
  mpState.raceStarted = false;
}
