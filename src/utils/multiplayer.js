import { supabase } from '../supabase.js';
import { CARS } from '../data/cars.js';

const ROOM_CHANNEL_PREFIX = 'pixel-prix-v2';
const RACE_START_LEAD_MS = 5000;
const RACE_RECONNECT_GRACE_MS = 12000;
const ROOM_CODE_LENGTH = 6;

function getRoomChannelName(roomCode) {
  return `${ROOM_CHANNEL_PREFIX}-${String(roomCode || '').trim().toUpperCase()}`;
}

// Local Player Unique ID
export const LOCAL_PLAYER_ID = 'driver_' + Math.random().toString(36).substring(2, 9);

export const mpState = {
  // Incremented whenever a room is abandoned or recreated. Every async
  // callback captures this value, so packets from a previous room can never
  // mutate a newly joined one.
  sessionEpoch: 0,
  isMultiplayer: false,
  isHost: false,
  hostId: null,
  roomCode: null,
  trackId: 'monaco-oval',
  trackRevision: 0,
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
  spectating: false,
  updateTimer: null,
  raceStarted: false,
  startCountDownTime: 0,
  raceId: null,
  raceRoster: [],          // frozen grid for the active/countdown race
  presentPlayerIds: new Set(),
  retireTimers: new Map(),
  hostClockOffsetMs: 0     // host clock minus this device's wall clock
};

function isCurrentRoom(channel, sessionEpoch) {
  return Boolean(
    mpState.isMultiplayer &&
    mpState.channel === channel &&
    mpState.sessionEpoch === sessionEpoch
  );
}

function isCurrentHostIssuer(issuerId) {
  return Boolean(issuerId && mpState.hostId && issuerId === mpState.hostId);
}

function createSupersededRoomError() {
  const error = new Error('ONLINE ROOM REQUEST CANCELLED');
  error.code = 'ROOM_SESSION_SUPERSEDED';
  return error;
}

function sortPlayersByJoinOrder(players) {
  return [...players].sort((a, b) => (
    (a.joinedAt || 0) - (b.joinedAt || 0) || String(a.id).localeCompare(String(b.id))
  ));
}

function freezeRaceRoster(players) {
  return sortPlayersByJoinOrder(Array.isArray(players) ? players : [])
    .map((player, gridPos) => ({
      id: player.id,
      name: player.name || 'DRIVER',
      carId: player.carId || 'scuderia-furiosa',
      joinedAt: player.joinedAt || 0,
      gridPos,
      retired: false
    }));
}

function getRaceRosterIds() {
  return new Set(mpState.raceRoster.map((player) => player.id));
}

function isActiveRaceRosterPlayer(playerId) {
  return mpState.raceRoster.some((player) => player.id === playerId && !player.retired);
}

function clearRaceRetireTimers() {
  mpState.retireTimers.forEach((timer) => window.clearTimeout(timer));
  mpState.retireTimers.clear();
}

function markRaceRosterDriverRetired(playerId) {
  const driver = mpState.raceRoster.find((player) => player.id === playerId);
  if (!driver || driver.retired) return false;
  driver.retired = true;
  const timer = mpState.retireTimers.get(playerId);
  if (timer) window.clearTimeout(timer);
  mpState.retireTimers.delete(playerId);
  return true;
}

function dispatchRaceFinishUpdate() {
  window.dispatchEvent(new CustomEvent('pixel-prix:mp-race-finish-update', {
    detail: { finishedPlayers: mpState.finishedPlayers }
  }));
}

function getLatestTrackPresence(players, fallbackTrackId) {
  const candidates = (Array.isArray(players) ? players : [])
    .filter((player) => typeof player?.trackId === 'string' && player.trackId);
  if (!candidates.length) return { trackId: fallbackTrackId, revision: 0 };

  const latest = [...candidates].sort((a, b) => (
    Number(b.trackRevision || 0) - Number(a.trackRevision || 0) ||
    (a.joinedAt || 0) - (b.joinedAt || 0) ||
    String(a.id).localeCompare(String(b.id))
  ))[0];
  return { trackId: latest.trackId, revision: Number(latest.trackRevision || 0) };
}

/**
 * Generates a six-character uppercase alphanumeric room code (e.g., R7K2M9).
 * Six symbols reduce accidental collisions now that a code is the whole room
 * identity rather than a track-specific suffix.
 */
export function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
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

function getPresencePlayers(presenceState) {
  return Object.values(presenceState || {}).flatMap((presences) => (
    Array.isArray(presences) ? presences : []
  ));
}

function reserveAvailableCar(preferredCarId, players) {
  const knownIds = new Set(CARS.map((car) => car.id));
  const occupied = new Set(
    players.map((player) => player?.carId).filter((carId) => knownIds.has(carId))
  );

  if (knownIds.has(preferredCarId) && !occupied.has(preferredCarId)) {
    return preferredCarId;
  }

  return CARS.find((car) => !occupied.has(car.id))?.id || null;
}

// Presence is eventually consistent, so simultaneous joiners can briefly
// advertise the same car. The stable join order below makes every client
// resolve the collision in exactly the same way; the later driver re-tracks
// their presence with the first free car.
function resolveLocalCarReservation(channel, players) {
  const ordered = [...players].sort((a, b) => (
    (a.joinedAt || 0) - (b.joinedAt || 0) || String(a.id).localeCompare(String(b.id))
  ));
  const occupied = new Set();
  let replacement = null;

  ordered.forEach((player) => {
    const requestedCar = CARS.some((car) => car.id === player.carId) ? player.carId : null;
    const assignedCar = requestedCar && !occupied.has(requestedCar)
      ? requestedCar
      : CARS.find((car) => !occupied.has(car.id))?.id;

    if (!assignedCar) return;
    occupied.add(assignedCar);

    if (player.id === LOCAL_PLAYER_ID && assignedCar !== mpState.localPlayer.carId) {
      replacement = assignedCar;
    }
  });

  if (!replacement) return false;

  mpState.localPlayer = { ...mpState.localPlayer, carId: replacement };
  window.dispatchEvent(new CustomEvent('pixel-prix:mp-car-reassigned', {
    detail: { carId: replacement }
  }));
  // Do not await this in the sync callback: tracking itself triggers a fresh
  // presence sync and the lobby should remain responsive while it settles.
  channel.track(mpState.localPlayer).catch(() => {});
  return true;
}

/**
 * Subscribe, track presence, and fail cleanly if Realtime cannot establish a
 * usable room. A timeout prevents the UI from being left in a pending state
 * when a browser loses its network without emitting a channel error.
 */
function subscribeToRoom(channel, sessionEpoch, onSubscribed, errorMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (!isCurrentRoom(channel, sessionEpoch)) {
        fail(createSupersededRoomError(), false);
      } else {
        fail(new Error(`${errorMessage} (TIMED_OUT)`));
      }
    }, 12000);

    const succeed = (result) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      resolve(result);
    };

    const fail = (error, cleanupCurrentRoom = true) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      if (cleanupCurrentRoom && isCurrentRoom(channel, sessionEpoch)) {
        leaveMultiplayerRoom();
      }
      reject(error);
    };

    channel.subscribe(async (status) => {
      if (!isCurrentRoom(channel, sessionEpoch)) {
        fail(createSupersededRoomError(), false);
        return;
      }

      if (status === 'SUBSCRIBED') {
        try {
          const result = await onSubscribed();
          if (!isCurrentRoom(channel, sessionEpoch)) {
            fail(createSupersededRoomError(), false);
            return;
          }
          succeed(result);
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
  const sessionEpoch = mpState.sessionEpoch;

  const roomCode = generateRoomCode();
  const channelName = getRoomChannelName(roomCode);

  mpState.isMultiplayer = true;
  mpState.isHost = true;
  mpState.hostId = LOCAL_PLAYER_ID;
  mpState.hostClockOffsetMs = 0;
  mpState.roomCode = roomCode;
  mpState.trackId = trackId;
  mpState.trackRevision = 0;
  mpState.finishedPlayers = [];
  mpState.spectating = false;
  mpState.remotePlayers.clear();

  mpState.localPlayer = {
    id: LOCAL_PLAYER_ID,
    name: playerName || getLocalPlayerName(),
    carId: carId || 'scuderia-furiosa',
    trackId,
    trackRevision: 0,
    joinedAt: Date.now(),
    isHost: true,
    hostClaim: true,
    racePhase: 'lobby',
    raceId: null
  };

  const channel = supabase.channel(channelName, {
    config: {
      broadcast: { self: false },
      presence: { key: LOCAL_PLAYER_ID }
    }
  });

  mpState.channel = channel;
  setupChannelListeners(channel, sessionEpoch);

  return subscribeToRoom(channel, sessionEpoch, async () => {
    await channel.track(mpState.localPlayer);
    return { roomCode, channelName, sessionEpoch };
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
  const sessionEpoch = mpState.sessionEpoch;

  const cleanCode = roomCode.trim().toUpperCase();
  if (!new RegExp(`^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{${ROOM_CODE_LENGTH}}$`).test(cleanCode)) {
    throw new Error('Invalid room code. Please enter a valid 6-character code.');
  }

  // The room code alone identifies a lobby. Joining a room must not require
  // the guest to have independently selected the host's circuit first.
  const channelName = getRoomChannelName(cleanCode);

  mpState.isMultiplayer = true;
  mpState.isHost = false;
  mpState.hostId = null;
  mpState.hostClockOffsetMs = 0;
  mpState.roomCode = cleanCode;
  mpState.trackId = trackId;
  mpState.trackRevision = 0;
  mpState.finishedPlayers = [];
  mpState.spectating = false;
  mpState.remotePlayers.clear();

  mpState.localPlayer = {
    id: LOCAL_PLAYER_ID,
    name: playerName || getLocalPlayerName(),
    carId: carId || 'scuderia-furiosa',
    trackId,
    trackRevision: 0,
    joinedAt: Date.now(),
    isHost: false,
    hostClaim: false,
    racePhase: 'lobby',
    raceId: null
  };

  const channel = supabase.channel(channelName, {
    config: {
      broadcast: { self: false },
      presence: { key: LOCAL_PLAYER_ID }
    }
  });

  mpState.channel = channel;
  setupChannelListeners(channel, sessionEpoch);

  return subscribeToRoom(channel, sessionEpoch, async () => {
    // Evaluate room capacity via Presence before adding this driver.
    const existingPlayers = getPresencePlayers(channel.presenceState());
    const currentCount = existingPlayers.length;
    if (currentCount === 0) {
      throw new Error('ROOM NOT FOUND OR HOST IS OFFLINE');
    }
    if (currentCount >= 8) {
      throw new Error('ONLINE LOBBY FULL (MAXIMUM 8 DRIVERS)');
    }

    if (existingPlayers.some((player) => player?.racePhase === 'countdown' || player?.racePhase === 'racing')) {
      throw new Error('RACE ALREADY IN PROGRESS — ASK THE HOST TO CREATE A NEW LOBBY');
    }
    const latestTrack = getLatestTrackPresence(existingPlayers, trackId);
    const assignedTrackId = latestTrack.trackId;
    mpState.trackId = assignedTrackId;
    mpState.trackRevision = latestTrack.revision;

    const assignedCarId = reserveAvailableCar(mpState.localPlayer.carId, existingPlayers);
    if (!assignedCarId) {
      throw new Error('NO UNIQUE CARS ARE AVAILABLE IN THIS LOBBY');
    }
    const carChanged = assignedCarId !== mpState.localPlayer.carId;
    mpState.localPlayer = {
      ...mpState.localPlayer,
      carId: assignedCarId,
      trackId: assignedTrackId,
      trackRevision: latestTrack.revision
    };
    await channel.track(mpState.localPlayer);
    requestHostClockSync(channel, sessionEpoch);
    requestRaceState(channel, sessionEpoch);
    return { roomCode: cleanCode, channelName, assignedCarId, carChanged, assignedTrackId, sessionEpoch };
  }, `Unable to join online lobby ${cleanCode}`);
}

function requestHostClockSync(channel, sessionEpoch) {
  if (!isCurrentRoom(channel, sessionEpoch)) return;
  if (mpState.isHost) {
    mpState.hostClockOffsetMs = 0;
    return;
  }

  const clientSentAt = Date.now();
  channel.send({
    type: 'broadcast',
    event: 'clock_ping',
    payload: { clientId: LOCAL_PLAYER_ID, clientSentAt }
  }).catch(() => {});
}

function requestRaceState(channel, sessionEpoch) {
  if (!isCurrentRoom(channel, sessionEpoch)) return;
  channel.send({
    type: 'broadcast',
    event: 'race_state_request',
    payload: { clientId: LOCAL_PLAYER_ID }
  }).catch(() => {});
}

function localRaceStartTimestamp(hostStartTimestamp) {
  const hostTimestamp = Number(hostStartTimestamp);
  if (!Number.isFinite(hostTimestamp)) return Date.now() + RACE_START_LEAD_MS;
  const offset = mpState.isHost ? 0 : Number(mpState.hostClockOffsetMs || 0);
  return Math.round(hostTimestamp - offset);
}

function applyRaceStart(data, channel, sessionEpoch) {
  if (!isCurrentRoom(channel, sessionEpoch)) return null;
  const hostStartTimestamp = Number(data?.startTimestamp);
  if (!Number.isFinite(hostStartTimestamp) || hostStartTimestamp <= 0) return null;
  const raceId = typeof data?.raceId === 'string' && data.raceId
    ? data.raceId
    : `${mpState.roomCode || 'room'}-${hostStartTimestamp}`;
  // Replayed commands for the current race are idempotent. A different
  // host-authorized race ID is allowed to replace a stale post-race state so
  // a player with an open result modal cannot miss the next session.
  if (mpState.raceStarted && mpState.raceId === raceId) return null;

  const roster = freezeRaceRoster(
    Array.isArray(data?.players) && data.players.length ? data.players : mpState.players
  );
  if (!roster.some((player) => player.id === LOCAL_PLAYER_ID)) return null;

  resetMultiplayerRaceState();
  const trackRevision = Number.isFinite(Number(data?.trackRevision))
    ? Number(data.trackRevision)
    : mpState.trackRevision;

  mpState.raceRoster = roster;
  mpState.raceId = raceId;
  mpState.presentPlayerIds = new Set(mpState.players.map((player) => player.id));
  mpState.startCountDownTime = localRaceStartTimestamp(hostStartTimestamp);
  mpState.raceStarted = true;
  mpState.trackId = data.trackId || mpState.trackId;
  mpState.trackRevision = Math.max(mpState.trackRevision, trackRevision);
  mpState.localPlayer = {
    ...mpState.localPlayer,
    trackId: mpState.trackId,
    trackRevision: mpState.trackRevision,
    racePhase: 'countdown',
    raceId
  };
  channel.track(mpState.localPlayer).catch(() => {});

  return {
    ...data,
    raceId,
    players: roster,
    hostStartTimestamp,
    startTimestamp: mpState.startCountDownTime,
    sessionEpoch
  };
}

function scheduleRaceRosterRetirements(channel, sessionEpoch, presentIds) {
  if (!mpState.raceStarted || !mpState.isHost || !isCurrentRoom(channel, sessionEpoch)) return;
  const finishedIds = new Set(mpState.finishedPlayers.map((player) => player.id));
  const raceId = mpState.raceId;

  mpState.raceRoster.forEach((driver) => {
    const isStillPresent = presentIds.has(driver.id);
    if (driver.retired || finishedIds.has(driver.id) || isStillPresent) {
      const timer = mpState.retireTimers.get(driver.id);
      if (timer) window.clearTimeout(timer);
      mpState.retireTimers.delete(driver.id);
      return;
    }
    if (mpState.retireTimers.has(driver.id)) return;

    const timer = window.setTimeout(() => {
      mpState.retireTimers.delete(driver.id);
      if (
        !isCurrentRoom(channel, sessionEpoch) ||
        !mpState.isHost ||
        mpState.hostId !== LOCAL_PLAYER_ID ||
        !mpState.raceStarted ||
        mpState.raceId !== raceId ||
        mpState.presentPlayerIds.has(driver.id) ||
        !isActiveRaceRosterPlayer(driver.id)
      ) return;

      if (!markRaceRosterDriverRetired(driver.id)) return;
      const payload = { raceId, playerId: driver.id, issuerId: LOCAL_PLAYER_ID };
      channel.send({ type: 'broadcast', event: 'race_retire', payload }).catch(() => {});
      dispatchRaceFinishUpdate();
    }, RACE_RECONNECT_GRACE_MS);
    mpState.retireTimers.set(driver.id, timer);
  });
}

/**
 * Configure Supabase Realtime Listeners (Presence & Broadcasts)
 */
function setupChannelListeners(channel, sessionEpoch) {
  // 1. Presence Sync (Track Lobby Players & Host Failover)
  channel.on('presence', { event: 'sync' }, () => {
    if (!isCurrentRoom(channel, sessionEpoch)) return;
    const presenceState = channel.presenceState();
    const playerList = [];

    Object.keys(presenceState).forEach((key) => {
      const presences = presenceState[key];
      if (presences && presences.length > 0) {
        playerList.push(presences[0]);
      }
    });

    // The ID tie-break makes host election reproducible when two presence
    // updates share the same millisecond timestamp.
    playerList.sort((a, b) => (
      (a.joinedAt || 0) - (b.joinedAt || 0) || String(a.id).localeCompare(String(b.id))
    ));

    // Preserve the original room creator while they are present; timestamp
    // ordering is only a deterministic failover rule, never a way for a
    // later joiner with a skewed clock to seize the lobby immediately.
    const hostPlayer = playerList.find((player) => player.hostClaim === true) || playerList[0] || null;
    const hostId = hostPlayer?.id || null;

    // Assign grid positions and derive host status from the current presence
    // list. This avoids stale HOST labels after a host disconnects.
    playerList.forEach((p, idx) => {
      p.gridPos = idx;
      p.isHost = p.id === hostId;
    });

    if (!mpState.raceStarted) resolveLocalCarReservation(channel, playerList);

    const previousHostId = mpState.hostId;
    const wasHost = mpState.isHost;
    mpState.hostId = hostId;
    mpState.isHost = hostId === LOCAL_PLAYER_ID;
    if (wasHost && !mpState.isHost) clearRaceRetireTimers();
    mpState.localPlayer.isHost = mpState.isHost;
    if (mpState.isHost && !mpState.localPlayer.hostClaim) {
      mpState.localPlayer = { ...mpState.localPlayer, hostClaim: true };
      channel.track(mpState.localPlayer).catch(() => {});
    }
    if (mpState.isHost) mpState.hostClockOffsetMs = 0;

    // Highest monotonic revision wins across presence records. This prevents
    // an elected host with an older cached circuit from rolling a lobby back.
    const latestTrack = getLatestTrackPresence(playerList, mpState.trackId);
    if (latestTrack.trackId && (
      latestTrack.revision > mpState.trackRevision ||
      (latestTrack.revision === mpState.trackRevision && latestTrack.trackId !== mpState.trackId)
    )) {
      mpState.trackId = latestTrack.trackId;
      mpState.trackRevision = latestTrack.revision;
      window.dispatchEvent(new CustomEvent('pixel-prix:mp-track-update', {
        detail: { trackId: latestTrack.trackId }
      }));
    }

    mpState.players = playerList;

    // Dispatch DOM event to update Lobby UI
    window.dispatchEvent(new CustomEvent('pixel-prix:mp-lobby-update', {
      detail: { players: playerList, isHost: mpState.isHost, roomCode: mpState.roomCode }
    }));

    // Presence is transient, so a racer is never removed immediately. The
    // elected host alone declares a DNF after a reconnect grace period and
    // broadcasts that decision to every client.
    if (mpState.raceStarted) {
      const presentIds = new Set(playerList.map((player) => player.id));
      mpState.presentPlayerIds = presentIds;
      scheduleRaceRosterRetirements(channel, sessionEpoch, presentIds);
      dispatchRaceFinishUpdate();
    }

    if (!mpState.isHost && hostId && hostId !== previousHostId) {
      requestHostClockSync(channel, sessionEpoch);
    }
  });

  // 2. Broadcast Listener: Race Start Command
  channel.on('broadcast', { event: 'race_start' }, (payload) => {
    if (!isCurrentRoom(channel, sessionEpoch)) return;
    const data = payload.payload;
    if (!isCurrentHostIssuer(data?.issuerId)) return;
    const raceData = applyRaceStart(data, channel, sessionEpoch);
    if (raceData) {
      window.dispatchEvent(new CustomEvent('pixel-prix:mp-race-start', { detail: raceData }));
    }
  });

  channel.on('broadcast', { event: 'lobby_track_update' }, (payload) => {
    if (!isCurrentRoom(channel, sessionEpoch) || mpState.raceStarted) return;
    if (!isCurrentHostIssuer(payload.payload?.issuerId)) return;
    const trackId = payload.payload?.trackId;
    const trackRevision = Number(payload.payload?.trackRevision);
    if (!trackId || !Number.isFinite(trackRevision) || trackRevision <= mpState.trackRevision) return;
    mpState.trackId = trackId;
    mpState.trackRevision = trackRevision;
    // Every driver's presence is the recovery source if the host disconnects.
    // Keep it current on guests too, otherwise an old track can be resurrected
    // by the next elected host.
    mpState.localPlayer = { ...mpState.localPlayer, trackId, trackRevision };
    channel.track(mpState.localPlayer).catch(() => {});
    window.dispatchEvent(new CustomEvent('pixel-prix:mp-track-update', { detail: { trackId } }));
  });

  // 3. Broadcast Listener: Position Updates (10 Hz)
  channel.on('broadcast', { event: 'car_update' }, (payload) => {
    if (!isCurrentRoom(channel, sessionEpoch) || !mpState.raceStarted) return;
    const data = payload.payload;
    if (
      !data ||
      data.id === LOCAL_PLAYER_ID ||
      data.issuerId !== data.id ||
      data.raceId !== mpState.raceId
    ) return;
    const rosterIds = getRaceRosterIds();
    if (rosterIds.size && !rosterIds.has(data.id)) return;
    if (!isActiveRaceRosterPlayer(data.id)) return;

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
      progress: Number.isFinite(data.progress) ? data.progress : null,
      lastUpdate: Date.now()
    });
  });

  // 4. Broadcast Listener: Race Finish
  channel.on('broadcast', { event: 'race_finish' }, (payload) => {
    if (!isCurrentRoom(channel, sessionEpoch) || !mpState.raceStarted) return;
    const data = payload.payload;
    if (!data?.id || data.raceId !== mpState.raceId || data.issuerId !== data.id) return;
    const rosterIds = getRaceRosterIds();
    if (rosterIds.size && !rosterIds.has(data.id)) return;
    if (!isActiveRaceRosterPlayer(data.id)) return;
    const exists = mpState.finishedPlayers.some(p => p.id === data.id);
    if (!exists) {
      mpState.finishedPlayers.push(data);
      mpState.finishedPlayers.sort((a, b) => a.timeMs - b.timeMs);
    }

    dispatchRaceFinishUpdate();
  });

  channel.on('broadcast', { event: 'race_retire' }, (payload) => {
    if (!isCurrentRoom(channel, sessionEpoch) || !mpState.raceStarted) return;
    const data = payload.payload;
    if (
      data?.raceId !== mpState.raceId ||
      !isCurrentHostIssuer(data?.issuerId) ||
      !data?.playerId
    ) return;
    if (markRaceRosterDriverRetired(data.playerId)) dispatchRaceFinishUpdate();
  });

  // A joiner may subscribe between a host's presence update and the start
  // broadcast. Ask for current race state so it cannot sit in a dead lobby.
  channel.on('broadcast', { event: 'race_state_request' }, (payload) => {
    if (!isCurrentRoom(channel, sessionEpoch) || !mpState.isHost || !mpState.raceStarted) return;
    const clientId = payload.payload?.clientId;
    if (!clientId || clientId === LOCAL_PLAYER_ID) return;
    channel.send({
      type: 'broadcast',
      event: 'race_state_response',
      payload: {
        targetId: clientId,
        issuerId: LOCAL_PLAYER_ID,
        raceId: mpState.raceId
      }
    }).catch(() => {});
  });

  channel.on('broadcast', { event: 'race_state_response' }, (payload) => {
    if (!isCurrentRoom(channel, sessionEpoch) || mpState.raceStarted) return;
    const data = payload.payload;
    if (data?.targetId !== LOCAL_PLAYER_ID || !isCurrentHostIssuer(data?.issuerId)) return;
    leaveMultiplayerRoom();
    window.dispatchEvent(new CustomEvent('pixel-prix:mp-room-locked', {
      detail: { raceId: data.raceId }
    }));
  });

  // A lightweight NTP-style handshake estimates the host's clock offset.
  // It is deliberately ignored for the host itself and refreshed on failover.
  channel.on('broadcast', { event: 'clock_ping' }, (payload) => {
    if (!isCurrentRoom(channel, sessionEpoch) || !mpState.isHost) return;
    const data = payload.payload;
    if (!data?.clientId || !Number.isFinite(Number(data.clientSentAt))) return;
    const hostReceivedAt = Date.now();
    channel.send({
      type: 'broadcast',
      event: 'clock_pong',
      payload: {
        targetId: data.clientId,
        clientSentAt: Number(data.clientSentAt),
        hostReceivedAt,
        hostSentAt: Date.now()
      }
    }).catch(() => {});
  });

  channel.on('broadcast', { event: 'clock_pong' }, (payload) => {
    if (!isCurrentRoom(channel, sessionEpoch) || mpState.isHost) return;
    const data = payload.payload;
    if (data?.targetId !== LOCAL_PLAYER_ID) return;
    const clientSentAt = Number(data.clientSentAt);
    const hostReceivedAt = Number(data.hostReceivedAt);
    const hostSentAt = Number(data.hostSentAt);
    const clientReceivedAt = Date.now();
    if (![clientSentAt, hostReceivedAt, hostSentAt].every(Number.isFinite)) return;

    const roundTripMs = clientReceivedAt - clientSentAt;
    if (roundTripMs < 0 || roundTripMs > 5000) return;
    const hostMidpoint = (hostReceivedAt + hostSentAt) / 2;
    const localMidpoint = (clientSentAt + clientReceivedAt) / 2;
    const sampleOffset = hostMidpoint - localMidpoint;
    // Smooth brief network jitter but let a newly elected host calibrate fast.
    mpState.hostClockOffsetMs = Math.round(
      mpState.hostClockOffsetMs * 0.35 + sampleOffset * 0.65
    );
  });
}

/**
 * Host Command: Broadcast Race Start with synchronized 3s future timestamp
 */
export function broadcastRaceStart() {
  if (!mpState.channel || !mpState.isHost) return;
  const uniqueCars = new Set(mpState.players.map((player) => player.carId));
  if (mpState.players.length < 2 || uniqueCars.size !== mpState.players.length) return;

  // Leave enough time for every client to receive the command and render the
  // same five-light sequence before the host-clock green-light timestamp.
  const channel = mpState.channel;
  const sessionEpoch = mpState.sessionEpoch;
  const startTimestamp = Date.now() + RACE_START_LEAD_MS;
  const roster = freezeRaceRoster(mpState.players);
  const racePayload = {
    raceId: `${mpState.roomCode || 'room'}-${startTimestamp}`,
    issuerId: LOCAL_PLAYER_ID,
    startTimestamp,
    trackId: mpState.trackId,
    trackRevision: mpState.trackRevision,
    players: roster
  };
  const localRaceData = applyRaceStart(racePayload, channel, sessionEpoch);
  if (!localRaceData) return;

  channel.send({
    type: 'broadcast',
    event: 'race_start',
    payload: racePayload
  }).catch(() => {});

  window.dispatchEvent(new CustomEvent('pixel-prix:mp-race-start', {
    detail: localRaceData
  }));
}

export async function broadcastLobbyTrackChange(trackId) {
  if (!mpState.channel || !mpState.isHost || !trackId || mpState.raceStarted) return false;
  const channel = mpState.channel;
  const sessionEpoch = mpState.sessionEpoch;
  const trackRevision = mpState.trackRevision + 1;
  mpState.trackId = trackId;
  mpState.trackRevision = trackRevision;
  mpState.localPlayer = { ...mpState.localPlayer, trackId, trackRevision };
  await channel.track(mpState.localPlayer);
  if (!isCurrentRoom(channel, sessionEpoch)) return false;
  await channel.send({
    type: 'broadcast',
    event: 'lobby_track_update',
    payload: { trackId, trackRevision, issuerId: LOCAL_PLAYER_ID }
  });
  window.dispatchEvent(new CustomEvent('pixel-prix:mp-track-update', { detail: { trackId } }));
  return true;
}

export function resetMultiplayerRaceState() {
  stopPositionBroadcast();
  clearRaceRetireTimers();
  mpState.finishedPlayers = [];
  mpState.remotePlayers.clear();
  mpState.raceStarted = false;
  mpState.spectating = false;
  mpState.raceId = null;
  mpState.raceRoster = [];
  mpState.presentPlayerIds = new Set();
}

/**
 * Low-Rate 10 Hz Position Broadcast Loop
 */
export function startPositionBroadcast(raceScene) {
  stopPositionBroadcast();

  if (!mpState.isMultiplayer || !mpState.channel) return;
  const channel = mpState.channel;
  const sessionEpoch = mpState.sessionEpoch;

  mpState.updateTimer = setInterval(() => {
    if (!isCurrentRoom(channel, sessionEpoch)) {
      stopPositionBroadcast();
      return;
    }
    if (!raceScene || !raceScene.player) return;

    channel.send({
      type: 'broadcast',
      event: 'car_update',
      payload: {
        id: LOCAL_PLAYER_ID,
        issuerId: LOCAL_PLAYER_ID,
        raceId: mpState.raceId,
        name: mpState.localPlayer.name,
        carId: raceScene.carData ? raceScene.carData.id : 'scuderia-furiosa',
        x: Math.round(raceScene.player.x),
        y: Math.round(raceScene.player.y),
        rotation: Number(raceScene.player.rotation.toFixed(3)),
        speed: Math.round(raceScene.currentSpeed),
        lap: raceScene.currentLap,
        checkpoint: raceScene.nextCheckpointIndex,
        timeMs: Math.round(raceScene.elapsedMs || 0),
        progress: Number(raceScene.getRaceProgress?.() || 0)
      }
    }).catch(() => {});
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
export function broadcastRaceFinish(finalTimeMs, fastestLapMs = null) {
  // Keep the local finish available even if the realtime connection drops at
  // the chequered flag.  Previously the local result was only pushed into
  // state; because this client does not receive its own broadcasts, the UI
  // was never told to render it.
  if (!mpState.isMultiplayer || !mpState.raceStarted) return;
  const rosterIds = new Set(
    mpState.raceRoster.filter((player) => !player.retired).map((player) => player.id)
  );
  if (rosterIds.size && !rosterIds.has(LOCAL_PLAYER_ID)) return;

  const finishPayload = {
    id: LOCAL_PLAYER_ID,
    issuerId: LOCAL_PLAYER_ID,
    raceId: mpState.raceId,
    name: mpState.localPlayer.name,
    carId: mpState.localPlayer.carId,
    timeMs: Math.round(finalTimeMs),
    fastestLapMs: Number.isFinite(fastestLapMs) ? Math.round(fastestLapMs) : null
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
export function calculateLiveRank(localLap, localCheckpoint, localTimeMs, localProgress = 0) {
  if (!mpState.isMultiplayer) return { rank: 1, total: 1, gapMs: 0, leaderFinished: false };

  const allDrivers = [
    {
      id: LOCAL_PLAYER_ID,
      score: Number.isFinite(localProgress) ? localProgress : localLap * 1000 + localCheckpoint,
      timeMs: localTimeMs,
      progress: Number.isFinite(localProgress) ? localProgress : 0
    }
  ];

  const rosterIds = new Set(
    mpState.raceRoster.filter((player) => !player.retired).map((player) => player.id)
  );
  mpState.remotePlayers.forEach((rp) => {
    if (rosterIds.size && !rosterIds.has(rp.id)) return;
    if (Date.now() - rp.lastUpdate < 4000) {
      allDrivers.push({
        id: rp.id,
        score: Number.isFinite(rp.progress) ? rp.progress : (rp.lap || 1) * 1000 + (rp.checkpoint || 1),
        timeMs: rp.timeMs || 0,
        progress: Number.isFinite(rp.progress) ? rp.progress : 0
      });
    }
  });

  const finished = mpState.finishedPlayers
    .filter((player) => !rosterIds.size || rosterIds.has(player.id))
    .map((player) => ({
    id: player.id,
    score: Number.POSITIVE_INFINITY,
    timeMs: player.timeMs || 0,
    progress: Number.POSITIVE_INFINITY,
    finished: true
    }));
  // A chequered driver replaces any stale position packet so racing drivers
  // immediately see that the leader has finished rather than a frozen ghost.
  const finishedIds = new Set(finished.map((driver) => driver.id));
  const liveDrivers = allDrivers.filter((driver) => !finishedIds.has(driver.id));
  allDrivers.length = 0;
  allDrivers.push(...liveDrivers, ...finished);

  allDrivers.sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.timeMs - b.timeMs;
  });

  const rank = allDrivers.findIndex(d => d.id === LOCAL_PLAYER_ID) + 1;
  const leader = allDrivers[0];
  const local = allDrivers.find((driver) => driver.id === LOCAL_PLAYER_ID);
  const leaderFinished = Boolean(leader?.finished && leader.id !== LOCAL_PLAYER_ID);
  let gapMs = 0;
  if (!leaderFinished && rank > 1 && leader && local) {
    const paceMsPerLap = leader.timeMs / Math.max(leader.progress, 0.08);
    gapMs = Math.max(0, Math.round((leader.progress - local.progress) * paceMsPerLap));
  }

  return {
    rank: Math.max(1, rank),
    total: rosterIds.size || allDrivers.length,
    gapMs,
    leaderFinished,
    leaderId: leader?.id || LOCAL_PLAYER_ID
  };
}

/**
 * Leave / Unsubscribe from Multiplayer Channel
 */
export function leaveMultiplayerRoom() {
  // Invalidate listeners and in-flight subscribe callbacks before asking the
  // transport to unsubscribe. Supabase may still deliver a queued message.
  mpState.sessionEpoch += 1;
  const channel = mpState.channel;
  mpState.channel = null;
  resetMultiplayerRaceState();

  if (channel) {
    try {
      channel.unsubscribe();
    } catch (e) {}
  }

  mpState.isMultiplayer = false;
  mpState.isHost = false;
  mpState.hostId = null;
  mpState.hostClockOffsetMs = 0;
  mpState.roomCode = null;
  mpState.trackRevision = 0;
  mpState.players = [];
}
