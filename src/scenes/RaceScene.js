import Phaser from 'phaser';
import { CARS, getCarById } from '../data/cars.js';
import { getTrackById } from '../data/tracks.js';
import { renderTrackGraphics } from '../utils/trackRenderer.js';
import { getNearestSegmentIndex, checkCheckpointProximity, isOffRoad } from '../utils/trackPhysics.js';
import { assessTrackLimits, createStewardState } from '../utils/stewarding.js';
import { calculateHandling } from '../utils/handling.js';
import { advanceVehicleDynamics, buildTrackProfile, sampleTrackContext } from '../utils/vehicleDynamics.js';
import { startEngineSound, updateEnginePitch, stopEngineSound, setEngineActive, playBoostSound, playCheckpointSound, playFinishSound } from '../utils/audio.js';
import { mpState, startPositionBroadcast, stopPositionBroadcast, broadcastRaceFinish, calculateLiveRank } from '../utils/multiplayer.js';
import { createAiGrid, getGrandPrixClassification, resolveWeatherCondition, updateAiProgress } from '../utils/grandPrix.js';
import { captureGhostSample, createGhostRecorder, loadGhostReplay, sampleGhostReplay, saveGhostReplay } from '../utils/ghostReplay.js';

const SETUP_PRESETS = Object.freeze({
  attack: Object.freeze({
    id: 'attack',
    label: 'Attack',
    gripMultiplier: 0.97,
    accelerationMultiplier: 1.045,
    topSpeedMultiplier: 1.012,
    brakingMultiplier: 0.98,
    ersRecoveryMultiplier: 0.93,
    boostDrainMultiplier: 0.96
  }),
  balanced: Object.freeze({
    id: 'balanced',
    label: 'Balanced',
    gripMultiplier: 1,
    accelerationMultiplier: 1,
    topSpeedMultiplier: 1,
    brakingMultiplier: 1,
    ersRecoveryMultiplier: 1,
    boostDrainMultiplier: 1
  }),
  rain: Object.freeze({
    id: 'rain',
    label: 'Rain',
    gripMultiplier: 1.08,
    accelerationMultiplier: 0.97,
    topSpeedMultiplier: 0.985,
    brakingMultiplier: 1.08,
    ersRecoveryMultiplier: 1.05,
    boostDrainMultiplier: 1.07
  })
});

function resolveSetup(id) {
  return SETUP_PRESETS[String(id || '').toLowerCase()] || SETUP_PRESETS.balanced;
}

export class RaceScene extends Phaser.Scene {
  constructor() {
    super({ key: 'RaceScene' });
  }

  init(data) {
    const carId = (data && data.carId) ? data.carId : '';
    const trackId = (data && data.trackId) ? data.trackId : 'monaco-oval';
    this.carData = getCarById(carId);
    this.trackData = getTrackById(trackId);
    this.totalLaps = this.trackData.laps ?? 3;
    this.raceMode = data?.raceMode === 'grand-prix' && !mpState.isMultiplayer
      ? 'grand-prix'
      : 'time-trial';
    this.isGrandPrix = this.raceMode === 'grand-prix';
    this.driverName = String(data?.driverName || 'DRIVER 1').trim().toUpperCase().slice(0, 16) || 'DRIVER 1';
    this.weatherId = data?.weatherId === 'auto' || !data?.weatherId
      ? this.trackData.weather
      : data.weatherId;
    this.weatherCondition = resolveWeatherCondition(this.weatherId);
    this.defaultWeatherCondition = resolveWeatherCondition(this.trackData.weather);
    this.setupProfile = resolveSetup(data?.setupId);
    this.leaderboardEligible = !this.isGrandPrix &&
      this.weatherCondition.id === this.defaultWeatherCondition.id &&
      this.setupProfile.id === 'balanced';
    this.gridSize = Phaser.Math.Clamp(Math.round(Number(data?.gridSize) || 6), 2, Math.min(12, CARS.length));

    // Racing state
    this.currentLap = 1;
    this.nextCheckpointIndex = 1;
    this.totalCheckpointsHit = 0;
    this.raceStarted = false;
    this.raceFinished = false;
    this.lightsGreen = false;
    this.hasFalseStartPenalty = false;
    this.scheduledStartAt = Number.isFinite(Number(data?.startTimestamp))
      ? Number(data.startTimestamp)
      : null;

    // Penalty state
    this.stewardState = createStewardState();
    this.trackLimitsCount = 0;
    this.penaltyMs = 0;
    this.advantageAlertActive = false;
    this.offRoadWarningIssued = false;
    this.stewardProfile = this.trackData.stewards || {};

    // Timer state
    this.startTime = 0;
    this.elapsedMs = 0;
    this.lapTimes = [];
    this.lapStartTime = 0;

    // Sector state
    this.currentSector = 1;
    this.sectorStartTime = 0;
    this.currentLapSectors = [0, 0, 0];
    this.lapSectors = [];
    this.bestSectors = [null, null, null];

    // Car physics state
    this.currentSpeed = 0;
    this.boostEnergy = 100;
    this.isAccelerating = false;
    this.isBoosting = false;
    this.isBraking = false;
    this.isSteeringLeft = false;
    this.isSteeringRight = false;
    this.onGrass = false;
    this.wasBoostActive = false;    // track boost state change
    this.prevSpeed = 0;             // track speed for camera shake on hit
    this.hardBrakeCount = 0;        // spark trigger counter
    this.boostActive = false;       // toggle-style active boost state
    this.boostWasPressed = false;   // rising-edge detection for keypresses
    this.touchSteerValue = 0;       // analog touch steering wheel input (-1 to 1)
    this.touchGas = 0;              // analog touch gas input (0 to 1)
    this.touchBrake = 0;            // analog touch brake input (0 to 1)
    this.joystickHeading = 0;       // absolute target heading from joystick (radians)
    this.joystickActive = false;    // whether joystick is currently engaged
    this.turnRate = 4.8;            // max rotation per second toward target heading
    this.gamepadInput = { steer: 0, throttle: 0, brake: 0, boost: false };

    // Tunable physics parameters (scaled by 2.4x for high-speed AAA racing feel).
    // Conditions and the selected setup alter the same native force model,
    // rather than bolting on a separate arcade path for weather.
    const VEL_MULT = 2.4;
    const weatherPhysics = this.weatherCondition.physics;
    const baseTopSpeed = this.carData.maxSpeed || this.carData.topSpeed || 275;
    const baseBoostTopSpeed = this.carData.boostMaxSpeed || (baseTopSpeed * (this.carData.boostPower || 1.45));
    this.referenceTopSpeedKph = baseTopSpeed * weatherPhysics.topSpeedMultiplier * this.setupProfile.topSpeedMultiplier;
    this.referenceBoostTopSpeedKph = baseBoostTopSpeed * weatherPhysics.topSpeedMultiplier * this.setupProfile.topSpeedMultiplier;
    this.accelerationStat = (this.carData.acceleration || 180) * weatherPhysics.accelerationMultiplier * this.setupProfile.accelerationMultiplier;
    this.boostAccelerationStat = (this.carData.boostAcceleration || 380) * weatherPhysics.accelerationMultiplier * this.setupProfile.accelerationMultiplier;
    this.brakeForceStat = (this.carData.brakeForce || 450) * weatherPhysics.brakingMultiplier * this.setupProfile.brakingMultiplier;
    this.maxSpeed = this.referenceTopSpeedKph * VEL_MULT;
    this.boostMaxSpeed = this.referenceBoostTopSpeedKph * VEL_MULT;
    this.acceleration = this.accelerationStat * VEL_MULT;
    this.boostAcceleration = this.boostAccelerationStat * VEL_MULT;
    this.brakeForce = this.brakeForceStat * VEL_MULT;
    this.drag = (this.carData.drag || 25.0) * VEL_MULT;
    this.steeringSensitivity = (this.carData.steeringSensitivity || this.carData.handling || 4.4) * 1.48 * weatherPhysics.steeringMultiplier;
    this.highSpeedSteeringMultiplier = this.carData.highSpeedSteeringMultiplier || 0.48;

    // Vehicle identity is deliberately expressed through a few intuitive
    // behaviours. Defaults preserve the original roster while newer cars
    // gain meaningful launch, cornering and ERS trade-offs.
    this.launchGrip = Phaser.Math.Clamp((this.carData.launchGrip ?? 1) * weatherPhysics.gripMultiplier * this.setupProfile.gripMultiplier, 0.72, 1.22);
    this.corneringGrip = Phaser.Math.Clamp((this.carData.corneringGrip ?? 1) * weatherPhysics.gripMultiplier * this.setupProfile.gripMultiplier, 0.72, 1.22);
    this.ersRecovery = Phaser.Math.Clamp((this.carData.ersRecovery ?? 12) * this.setupProfile.ersRecoveryMultiplier, 7, 17);
    this.boostDrain = Phaser.Math.Clamp((this.carData.boostDrain ?? 35) * this.setupProfile.boostDrainMultiplier, 27, 45);

    // Lateral drift physics
    this.vx = 0;
    this.vy = 0;

    // Cleanup refs
    this._preventScrollHandler = null;
    this._kbHandler = null;
    this._notifEvent = null;
    this.nearestSegmentIndex = -1;
    this.lastHUDUpdate = 0;
    this.sparkDuration = 0;
    this.spectatorMode = false;
    this.lastMultiplayerContactAt = 0;
    this.startSegmentIndex = 0;
    this.trackLength = 1;
    this.aiRivals = [];
    this.grandPrixClassification = [];
    this.grandPrixPosition = 1;
    this.lastAiContactAt = 0;
    this.weatherOverlay = null;
    this.rainEmitter = null;

    this.ghostSession = {
      trackId: this.trackData.id,
      carId: this.carData.id,
      weatherId: this.weatherCondition.id,
      setupId: this.setupProfile.id
    };
    this.ghostReplay = !this.isGrandPrix && !mpState.isMultiplayer
      ? loadGhostReplay(this.ghostSession)
      : null;
    this.ghostRecorder = !this.isGrandPrix && !mpState.isMultiplayer
      ? createGhostRecorder({ carId: this.carData.id })
      : null;
    this.ghostSprite = null;
    this.ghostLabel = null;
    this.lastGhostSampleAt = -Infinity;
  }

  create() {
    // Re-enable keyboard driving
    if (this.input && this.input.keyboard) this.input.keyboard.enabled = true;
    document.getElementById('screen-hud')?.classList.remove('spectator-mode');
    document.getElementById('hud-mp-status')?.classList.toggle('hidden', !mpState.isMultiplayer);

    // Guard against any control 'active' state leaking across races.
    this.isAccelerating = this.isBraking = this.isBoosting = false;
    this.isSteeringLeft = this.isSteeringRight = false;

    // 1. World bounds
    this.physics.world.setBounds(0, 0, this.trackData.worldWidth, this.trackData.worldHeight);

    // 2. Render Track
    const trackResult = renderTrackGraphics(this, this.trackData);
    this.curvePoints = trackResult.curvePoints;
    this.roadWidth = trackResult.roadWidth;
    this.trackProfile = buildTrackProfile(this.curvePoints, this.roadWidth);
    this.trackLength = Math.max(1, this.trackProfile.worldLength || 1);
    this.startSegmentIndex = getNearestSegmentIndex(
      this.trackData.startPos.x,
      this.trackData.startPos.y,
      this.curvePoints,
      -1
    ).nearestIndex;

    // 3. Create player car sprite (with deterministic grid slot placement for multiplayer)
    const startPos = this.trackData.startPos;
    let gridSlot = 0;
    const multiplayerGrid = mpState.raceRoster.length > 0 ? mpState.raceRoster : mpState.players;
    if (mpState.isMultiplayer && multiplayerGrid.length > 0) {
      const pMatch = multiplayerGrid.find(p => p.id === mpState.localPlayer.id);
      if (pMatch && typeof pMatch.gridPos === 'number') {
        gridSlot = pMatch.gridPos;
      }
    }

    const baseRot = startPos.rotation || 0;
    const sideOffset = (gridSlot % 2 === 0 ? -1 : 1) * 22;
    const backOffset = gridSlot * 32;

    const startX = startPos.x - Math.cos(baseRot + Math.PI / 2) * sideOffset - Math.cos(baseRot) * backOffset;
    const startY = startPos.y - Math.sin(baseRot + Math.PI / 2) * sideOffset - Math.sin(baseRot) * backOffset;

    const textureKey = 'car_' + this.carData.id + '_straight';
    this.player = this.physics.add.sprite(startX, startY, textureKey);
    this.player.setOrigin(0.5, 0.5);
    this.player.setCollideWorldBounds(true);
    this.player.rotation = baseRot;
    this.player.setDepth(12);

    // A soft projected shadow keeps the car grounded against the richer track
    // surface without requiring an image asset or expensive post-processing.
    this.playerShadow = this.add.ellipse(startX + 7, startY + 9, 50, 18, 0x000000, 0.34);
    this.playerShadow.setDepth(11);

    if (this.isGrandPrix) {
      this.createGrandPrixField();
    }
    this.createGhostReplay();

    // Start 10 Hz multiplayer position broadcast
    if (mpState.isMultiplayer) {
      startPositionBroadcast(this);
    }

    // 4. Camera: remove bounds and follow lag so player is hard-locked to screen center
    this.cameras.main.removeBounds();
    this.frameCamera();
    this.scale.on('resize', this.frameCamera, this);

    // 5. Particles
    // Smoke emitter
    this.smokeEmitter = this.add.particles(0, 0, 'smoke_particle', {
      speed: { min: 15, max: 45 },
      scale: { start: 0.7, end: 0 },
      alpha: { start: 0.55, end: 0 },
      lifespan: 380,
      blendMode: 'NORMAL',
      emitting: false
    });
    this.smokeEmitter.startFollow(this.player, -14, 0);

    // Boost exhaust emitter (cyan)
    this.boostEmitter = this.add.particles(0, 0, 'boost_particle', {
      speed: { min: 80, max: 160 },
      scale: { start: 0.9, end: 0 },
      alpha: { start: 0.9, end: 0 },
      lifespan: 220,
      blendMode: 'ADD',
      emitting: false,
      angle: { min: 160, max: 200 },
      frequency: 25
    });
    this.boostEmitter.startFollow(this.player, -16, 0);

    // Spark emitter — braking / collision
    this.sparkEmitter = this.add.particles(0, 0, 'spark_particle', {
      speed: { min: 60, max: 180 },
      scale: { start: 0.5, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: 280,
      blendMode: 'ADD',
      emitting: false,
      quantity: 6,
      angle: { min: 120, max: 240 }
    });
    this.sparkEmitter.startFollow(this.player, -12, 0);

    // Skid mark emitter (particles freeze on track during slides/braking)
    this.skidEmitter = this.add.particles(0, 0, 'skid_mark', {
      speed: 0,
      lifespan: 5000,
      alpha: { start: 0.45, end: 0 },
      emitting: false
    });

    this.createWeatherAtmosphere();

    // 6. Keyboard inputs
    this.cursors = this.input.keyboard.createCursorKeys();
    this.wasd = this.input.keyboard.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
      space: Phaser.Input.Keyboard.KeyCodes.SPACE,
      shift: Phaser.Input.Keyboard.KeyCodes.SHIFT
    });
    this.boostKeyZ = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.Z);
    this.boostKeyC = this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.C);

    // Robust keyboard fallback (checks both e.key and e.code)
    this._kb = {
      up: false, down: false, left: false, right: false,
      space: false, shift: false, z: false, c: false
    };
    const keyActionMap = {
      w: 'up', W: 'up', ArrowUp: 'up', KeyW: 'up',
      s: 'down', S: 'down', ArrowDown: 'down', KeyS: 'down',
      a: 'left', A: 'left', ArrowLeft: 'left', KeyA: 'left',
      d: 'right', D: 'right', ArrowRight: 'right', KeyD: 'right',
      ' ': 'space', Space: 'space', Shift: 'shift', ShiftLeft: 'shift', ShiftRight: 'shift',
      z: 'z', Z: 'z', KeyZ: 'z', c: 'c', C: 'c', KeyC: 'c'
    };
    this._kbHandler = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      const action = keyActionMap[e.key] || keyActionMap[e.code];
      if (action) {
        this._kb[action] = e.type === 'keydown';
        if (e.code === 'Space' || e.code.startsWith('Arrow') || e.key.startsWith('Arrow')) e.preventDefault();
      }
    };
    window.addEventListener('keydown', this._kbHandler);
    window.addEventListener('keyup', this._kbHandler);

    // Browsers can miss keyup/touchend when a tab loses focus. Reset every
    // control source so the car never keeps accelerating in the background.
    this._resetInputHandler = () => {
      Object.keys(this._kb).forEach((key) => { this._kb[key] = false; });
      this.isAccelerating = false;
      this.isBraking = false;
      this.isBoosting = false;
      this.isSteeringLeft = false;
      this.isSteeringRight = false;
      this.touchSteerValue = 0;
      this.touchGas = 0;
      this.touchBrake = 0;
      this.joystickActive = false;
    };
    window.addEventListener('blur', this._resetInputHandler);
    document.addEventListener('visibilitychange', this._resetInputHandler);

    this._preventScrollHandler = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', this._preventScrollHandler);

    this._lightsGreenHandler = () => {
      this.beginRace();
    };
    window.addEventListener('pixel-prix:lights-green', this._lightsGreenHandler);

    // Guaranteed fallback when a browser animation/event is interrupted. In
    // multiplayer it honours the shared lights-out timestamp rather than
    // creating a second local countdown.
    const fallbackDelay = this.scheduledStartAt
      ? Math.max(0, this.scheduledStartAt - Date.now() + 250)
      : 4500;
    this.time.delayedCall(fallbackDelay, () => this.beginRace());

    // 7. Register shutdown handler
    this.events.once('shutdown', this.cleanup, this);

    // 8. Start countdown and emit initial HUD values
    this.emitHUDUpdate();
    this.startCountdown();
  }

  createGrandPrixField() {
    const aiCount = Phaser.Math.Clamp(this.gridSize, 1, Math.max(1, CARS.length - 1));
    const sessionSeed = `${this.trackData.id}:${this.carData.id}:${this.weatherCondition.id}:${this.setupProfile.id}:${aiCount}`;
    const baseLapTimeMs = Phaser.Math.Clamp(this.trackLength * 1.68, 50_000, 112_000);

    this.aiRivals = createAiGrid({
      cars: CARS,
      playerCarId: this.carData.id,
      trackId: this.trackData.id,
      count: aiCount,
      seed: sessionSeed
    }).map((rival) => ({
      ...rival,
      baseLapTimeMs
    }));

    this.aiRivals.forEach((rival) => {
      const textureKey = `car_${rival.carId}_straight`;
      const sprite = this.add.sprite(this.player.x, this.player.y, textureKey);
      sprite.setOrigin(0.5, 0.5);
      sprite.setAlpha(0.94);
      sprite.setDepth(14);

      const nameTag = this.add.text(this.player.x, this.player.y - 30, rival.name.toUpperCase(), {
        fontFamily: 'monospace',
        fontSize: '10px',
        fontStyle: 'bold',
        color: '#f4f7fb',
        backgroundColor: 'rgba(7, 10, 15, 0.82)',
        padding: { x: 4, y: 2 }
      });
      nameTag.setOrigin(0.5, 0.5);
      nameTag.setDepth(16);
      rival.sprite = sprite;
      rival.nameTag = nameTag;
      this.positionAiRival(rival, true);
    });

    this.updateGrandPrixClassification();
  }

  positionAiRival(rival, onGrid = false) {
    if (!rival?.sprite || !this.curvePoints?.length) return;
    const pointCount = Math.max(1, this.curvePoints.length - 1);
    const lapDistance = Number.isFinite(rival.distance) ? rival.distance : 0;
    const lapProgress = Phaser.Math.Clamp(lapDistance / Math.max(1, this.trackLength), 0, 1);
    const rawSegment = this.startSegmentIndex + lapProgress * pointCount;
    const startIndex = ((Math.floor(rawSegment) % pointCount) + pointCount) % pointCount;
    const nextIndex = (startIndex + 1) % pointCount;
    const segmentRatio = rawSegment - Math.floor(rawSegment);
    const current = this.curvePoints[startIndex];
    const next = this.curvePoints[nextIndex];
    const x = Phaser.Math.Linear(current.x, next.x, segmentRatio);
    const y = Phaser.Math.Linear(current.y, next.y, segmentRatio);
    const heading = Math.atan2(next.y - current.y, next.x - current.x);
    const normalX = -Math.sin(heading);
    const normalY = Math.cos(heading);
    const slot = Math.max(1, rival.gridPosition || 1);
    const lane = (slot % 2 === 0 ? 1 : -1) * Math.min(this.roadWidth * 0.18, 70);
    const gridFade = onGrid ? 1 : Math.max(0, 1 - (rival.raceTimeMs || 0) / 3600);
    const gridBack = Math.ceil(slot / 2) * 46 * gridFade;
    const drift = Math.sin((rival.raceTimeMs || 0) / 1350 + (rival.variationSeed || 0) % 17) * this.roadWidth * 0.025;
    const finalX = x + normalX * (lane + drift) - Math.cos(heading) * gridBack;
    const finalY = y + normalY * (lane + drift) - Math.sin(heading) * gridBack;

    rival.sprite.setPosition(finalX, finalY);
    rival.sprite.rotation = heading;
    rival.nameTag?.setPosition(finalX, finalY - 30);
    if (rival.finished) rival.nameTag?.setText(`${rival.name.toUpperCase()} ✓`);
  }

  updateGrandPrixField(deltaMs) {
    if (!this.isGrandPrix || this.aiRivals.length === 0) return;
    this.aiRivals = this.aiRivals.map((rival) => {
      const next = updateAiProgress(rival, deltaMs, this.totalLaps, this.trackLength, this.weatherCondition);
      this.positionAiRival(next);
      return next;
    });
    this.updateGrandPrixClassification();
    this.applyGrandPrixCarContacts();
  }

  buildPlayerGrandPrixEntry() {
    const totalDistance = this.raceFinished
      ? this.trackLength * this.totalLaps
      : Math.min(this.trackLength * this.totalLaps, this.getRaceProgress() * this.trackLength);
    const completedLaps = this.raceFinished ? this.totalLaps : Math.min(this.totalLaps, Math.floor(totalDistance / this.trackLength));
    const currentDistance = this.raceFinished
      ? this.trackLength
      : Math.max(0, totalDistance - completedLaps * this.trackLength);
    const finalTimeMs = this.finalTimeMs ?? (this.elapsedMs + this.penaltyMs);
    return {
      id: 'player',
      name: this.driverName,
      carId: this.carData.id,
      carName: this.carData.name,
      isPlayer: true,
      completedLaps,
      distance: currentDistance,
      totalDistance,
      progress: totalDistance / Math.max(1, this.trackLength * this.totalLaps),
      lap: this.raceFinished ? this.totalLaps : this.currentLap,
      raceTimeMs: this.elapsedMs,
      finished: this.raceFinished,
      finishTimeMs: this.raceFinished ? finalTimeMs : null
    };
  }

  updateGrandPrixClassification() {
    if (!this.isGrandPrix) return [];
    this.grandPrixClassification = getGrandPrixClassification(
      this.buildPlayerGrandPrixEntry(),
      this.aiRivals
    ).map((entry) => {
      const { sprite, nameTag, ...publicEntry } = entry;
      return publicEntry;
    });
    this.grandPrixPosition = this.grandPrixClassification.find((entry) => entry.isPlayer)?.position || 1;
    return this.grandPrixClassification;
  }

  applyGrandPrixCarContacts() {
    if (!this.player || this.time.now - this.lastAiContactAt < 120) return;
    const contactRadius = 44;
    const contactRadiusSq = contactRadius * contactRadius;
    const rival = this.aiRivals.find((entry) => {
      if (!entry.sprite || entry.finished) return false;
      const dx = this.player.x - entry.sprite.x;
      const dy = this.player.y - entry.sprite.y;
      return dx * dx + dy * dy < contactRadiusSq;
    });
    if (!rival?.sprite) return;

    const dx = this.player.x - rival.sprite.x;
    const dy = this.player.y - rival.sprite.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const normalX = dx / distance;
    const normalY = dy / distance;
    const overlap = contactRadius - distance;
    this.player.x += normalX * overlap * 0.55;
    this.player.y += normalY * overlap * 0.55;
    this.vx += normalX * Math.min(70, overlap * 5);
    this.vy += normalY * Math.min(70, overlap * 5);
    this.currentSpeed *= 0.975;
    this.lastAiContactAt = this.time.now;
  }

  createGhostReplay() {
    if (!this.ghostReplay || !this.player) return;
    const initial = sampleGhostReplay(this.ghostReplay, 0);
    if (!initial) return;
    const textureKey = `car_${this.ghostReplay.carId || this.carData.id}_straight`;
    this.ghostSprite = this.add.sprite(initial.x, initial.y, textureKey);
    this.ghostSprite.setOrigin(0.5, 0.5);
    this.ghostSprite.setAlpha(0.38);
    this.ghostSprite.setTint(0x78dcff);
    this.ghostSprite.setDepth(10);
    this.ghostLabel = this.add.text(initial.x, initial.y - 29, 'PERSONAL GHOST', {
      fontFamily: 'monospace',
      fontSize: '9px',
      fontStyle: 'bold',
      color: '#a9edff',
      backgroundColor: 'rgba(8, 35, 52, 0.62)',
      padding: { x: 4, y: 2 }
    });
    this.ghostLabel.setOrigin(0.5, 0.5);
    this.ghostLabel.setDepth(10);
  }

  updateGhostReplay() {
    if (!this.ghostSprite || !this.ghostReplay) return;
    const sample = sampleGhostReplay(this.ghostReplay, this.elapsedMs);
    if (!sample) {
      this.ghostSprite.setVisible(false);
      this.ghostLabel?.setVisible(false);
      return;
    }
    this.ghostSprite.setVisible(true);
    this.ghostLabel?.setVisible(true);
    this.ghostSprite.setPosition(sample.x, sample.y);
    this.ghostSprite.rotation = sample.rotation;
    this.ghostLabel?.setPosition(sample.x, sample.y - 29);
  }

  recordGhostReplay() {
    if (!this.ghostRecorder || !this.raceStarted || this.raceFinished) return;
    if (this.elapsedMs - this.lastGhostSampleAt < 90) return;
    captureGhostSample(this.ghostRecorder, {
      timeMs: this.elapsedMs,
      x: this.player.x,
      y: this.player.y,
      rotation: this.player.rotation
    });
    this.lastGhostSampleAt = this.elapsedMs;
  }

  createWeatherAtmosphere() {
    const { width, height } = this.scale;
    const weatherId = this.weatherCondition.id;
    const overlayColor = weatherId === 'night'
      ? 0x020616
      : weatherId === 'wet'
        ? 0x183954
        : weatherId === 'overcast'
          ? 0x6c8195
          : null;
    const overlayAlpha = weatherId === 'night' ? 0.42 : weatherId === 'wet' ? 0.16 : weatherId === 'overcast' ? 0.07 : 0;
    if (overlayColor !== null && overlayAlpha > 0) {
      this.weatherOverlay = this.add.rectangle(0, 0, width, height, overlayColor, overlayAlpha)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(30);
    }

    if (weatherId !== 'wet') return;
    const textureKey = 'pixel_prix_rain_drop';
    if (!this.textures.exists(textureKey)) {
      const graphic = this.make.graphics({ add: false });
      graphic.fillStyle(0xd9f7ff, 0.92);
      graphic.fillRect(0, 0, 2, 14);
      graphic.generateTexture(textureKey, 2, 14);
      graphic.destroy();
    }
    this.rainEmitter = this.add.particles(0, 0, textureKey, {
      x: { min: 0, max: width },
      y: { min: -40, max: 0 },
      speedX: { min: -95, max: -45 },
      speedY: { min: 500, max: 730 },
      scale: { min: 0.7, max: 1.15 },
      alpha: { start: 0.72, end: 0.18 },
      lifespan: 1100,
      frequency: 12,
      quantity: 2,
      blendMode: 'ADD'
    });
    this.rainEmitter.setScrollFactor(0);
    this.rainEmitter.setDepth(40);
  }

  frameCamera() {
    const cam = this.cameras.main;
    const pad = (this.roadWidth || 100) + 60;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of this.curvePoints) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const trackW = (maxX - minX) + pad * 2;
    const trackH = (maxY - minY) + pad * 2;

    const vw = this.scale.width || window.innerWidth;
    const vh = this.scale.height || window.innerHeight;

    cam.setViewport(0, 0, vw, vh);
    this.weatherOverlay?.setSize(vw, vh);

    const cover = Math.max(vw / trackW, vh / trackH);
    this.baseZoom = Math.max(0.28, Math.min(cover, 0.85));
    cam.setZoom(this.baseZoom);

    cam.setRotation(0);
    cam.setFollowOffset(0, 0);
    cam.removeBounds();
    this.centerCameraOnPlayer();
    if (this.playerShadow) {
      this.playerShadow.setPosition(this.player.x + 7, this.player.y + 9);
      this.playerShadow.rotation = this.player.rotation;
    }
  }

  beginRace() {
    if (this.lightsGreen || this.raceFinished) return;
    this.raceStarted = true;
    this.lightsGreen = true;
    this.startTime = this.time.now;
    this.lapStartTime = this.time.now;
    this.sectorStartTime = this.time.now;
    startEngineSound();
    this.showNotification('LIGHTS OUT — GO!');
    this.emitHUDUpdate();
  }

  centerCameraOnPlayer() {
    if (!this.player || !this.cameras.main) return;
    const cam = this.cameras.main;
    cam.rotation = 0;

    let ox = 0;
    let oy = 0;
    if (this.onGrass && Math.abs(this.currentSpeed) > 100) {
      // Simulate grass off-road vibration based on vehicle speed
      const intensity = (Math.abs(this.currentSpeed) / this.maxSpeed) * 12;
      ox = (Math.random() - 0.5) * intensity;
      oy = (Math.random() - 0.5) * intensity;
    }

    cam.centerOn(this.player.x + ox, this.player.y + oy);
  }

  startCountdown() {
    // RaceScene waits for the pixel-prix:lights-green event from F1 countdown lights
  }

  update(time, delta) {
    const dt = delta / 1000;
    const cam = this.cameras.main;
    this.gamepadInput = this.readGamepadInputs();

    this.centerCameraOnPlayer();
    if (this.playerShadow) {
      this.playerShadow.setPosition(this.player.x + 7, this.player.y + 9);
      this.playerShadow.rotation = this.player.rotation;
    }

    if (!this.lightsGreen) {
      const isTryingToDrive = this.isAccelerating || this.touchGas > 0.1 ||
                              this.gamepadInput.throttle > 0.1 ||
                              (this.cursors && this.cursors.up && this.cursors.up.isDown) ||
                              (this.wasd && this.wasd.up && this.wasd.up.isDown) ||
                              (this._kb && this._kb.up);

      if (isTryingToDrive && !this.hasFalseStartPenalty) {
        this.hasFalseStartPenalty = true;
        this.penaltyMs += 5000;
        this.showStewardsNotification('STEWARDS: +5.0s PENALTY (FALSE START)');
        this.emitHUDUpdate();
      }
      return;
    }

    if (this.raceFinished) {
      if (this.spectatorMode && mpState.isMultiplayer) {
        this.updateMultiplayerView();
        this.centerCameraOnSpectator();
        this.updateMultiplayerHUD(true);
      }
      return;
    }

    this.elapsedMs = this.time.now - this.startTime;
    this.updateGhostReplay();
    if (this.time.now - this.lastHUDUpdate > 33) {
      this.emitHUDUpdate();
      this.lastHUDUpdate = this.time.now;
    }

    this.prevSpeed = this.currentSpeed;

    const cameraSpeedRatio = Math.min(1.0, Math.abs(this.currentSpeed) / (this.maxSpeed || 275));
    const targetZoom = (this.baseZoom || 0.7) * (1.0 - cameraSpeedRatio * 0.10);
    cam.zoom = Phaser.Math.Linear(cam.zoom, targetZoom, 2.5 * dt);

    this.updateSpeedVignette(cameraSpeedRatio);

    // Steering
    let steerDir = 0;
    if (this.isSteeringLeft || this.cursors.left.isDown || this.wasd.left.isDown || this._kb.left) steerDir -= 1;
    if (this.isSteeringRight || this.cursors.right.isDown || this.wasd.right.isDown || this._kb.right) steerDir += 1;

    if (Math.abs(this.gamepadInput.steer) > 0) {
      steerDir = this.gamepadInput.steer;
    }

    if (this.touchSteerValue !== 0) {
      // Map to an exponential response curve (power of 1.6) for smooth analog control and no snap jump
      steerDir = Math.sign(this.touchSteerValue) * Math.pow(Math.abs(this.touchSteerValue), 1.6);
    }

    const carTexBase = 'car_' + this.carData.id + '_';
    if (steerDir < -0.15) this.player.setTexture(carTexBase + 'left');
    else if (steerDir > 0.15) this.player.setTexture(carTexBase + 'right');
    else this.player.setTexture(carTexBase + 'straight');

    if (this.currentSpeed < -5) steerDir *= -1;

    // Boost activation logic: single tap/press toggles boost. Stays active until 0.
    const boostButtonPressed = this.isBoosting || this.wasd.space.isDown || this.wasd.shift.isDown ||
      this.boostKeyZ.isDown || this.boostKeyC.isDown ||
      this._kb.space || this._kb.shift || this._kb.z || this._kb.c || this.gamepadInput.boost;

    const boostJustPressed = boostButtonPressed && !this.boostWasPressed;
    this.boostWasPressed = boostButtonPressed;

    if (boostJustPressed && !this.boostActive && this.boostEnergy >= 30) {
      this.boostActive = true;
      this.cameras.main.shake(200, 0.006); // Camera shake
      playBoostSound();
      window.dispatchEvent(new CustomEvent('pixel-prix:boost-state', { detail: { active: true } }));
    }

    const boostActive = this.boostActive;

    // Proportional analog inputs mapping
    let gasValue = 0;
    if (this.isAccelerating || this.cursors.up.isDown || this.wasd.up.isDown || this._kb.up) {
      gasValue = 1.0;
    } else if (this.touchGas > 0) {
      gasValue = this.touchGas;
    }
    gasValue = Math.max(gasValue, this.gamepadInput.throttle);

    let brakeValue = 0;
    if (this.isBraking || this.cursors.down.isDown || this.wasd.down.isDown || this._kb.down) {
      brakeValue = 1.0;
    } else if (this.touchBrake > 0) {
      brakeValue = this.touchBrake;
    }
    brakeValue = Math.max(brakeValue, this.gamepadInput.brake);

    const gasOn = gasValue > 0;
    const brakeOn = brakeValue > 0;

    const grassCheck = getNearestSegmentIndex(this.player.x, this.player.y, this.curvePoints, this.nearestSegmentIndex);
    this.nearestSegmentIndex = grassCheck.nearestIndex;
    this.onGrass = isOffRoad(this.player.x, this.player.y, this.curvePoints, this.roadWidth, grassCheck);
    const displayedSpeed = Math.abs(this.currentSpeed) / 2.4;
    const trackContext = sampleTrackContext(this.trackProfile, this.nearestSegmentIndex, {
      speedKph: displayedSpeed,
      roadWidth: this.roadWidth,
      distanceFromCenter: Math.sqrt(grassCheck.minDistanceSq),
      corneringGrip: this.corneringGrip,
      onGrass: this.onGrass
    });
    const cornerOverspeed = Number.isFinite(trackContext.cornerSpeedKph)
      ? Math.max(0, (displayedSpeed - trackContext.cornerSpeedKph) / Math.max(30, trackContext.cornerSpeedKph))
      : 0;

    setEngineActive(gasOn || boostActive);

    const handling = calculateHandling({
      speedKph: displayedSpeed,
      maxSpeedKph: this.maxSpeed / 2.4,
      steerInput: steerDir,
      throttle: gasValue,
      brake: brakeValue,
      boostActive,
      corneringGrip: this.corneringGrip,
      highSpeedSteeringMultiplier: this.highSpeedSteeringMultiplier
    });
    if (Math.abs(this.currentSpeed) > 1.0) {
      // Every control method uses the same traction-limited authority, so
      // braking before a turn matters on touch, keyboard, and gamepad alike.
      if (this.joystickActive) {
        const diff = Phaser.Math.Angle.Wrap(this.joystickHeading - this.player.rotation);
        const maxTurn = this.turnRate * handling.steeringAuthority / (1 + cornerOverspeed * 0.45) * dt;
        const step = Math.sign(diff) * Math.min(Math.abs(diff), maxTurn);
        this.player.rotation += step;
      } else {
        this.player.rotation += steerDir * this.steeringSensitivity * handling.steeringAuthority / (1 + cornerOverspeed * 0.45) * dt;
      }
    }
    const stewardDecision = assessTrackLimits(this.stewardState, {
      onGrass: this.onGrass,
      speedKph: displayedSpeed,
      deltaMs: delta
    }, this.stewardProfile);
    this.stewardState = stewardDecision.state;
    this.trackLimitsCount = this.stewardState.trackLimitsCount;
    this.offRoadWarningIssued = this.stewardState.reviewIssued;

    if (stewardDecision.event) {
      const { type, penaltyMs = 0 } = stewardDecision.event;
      if (type === 'review') {
        this.showStewardsNotification('STEWARDS: TRACK LIMITS UNDER REVIEW');
      } else if (type === 'warning') {
        this.showStewardsNotification(`STEWARDS: TRACK LIMITS WARNING ${this.trackLimitsCount}/${this.stewardProfile.warningLimit}`);
      } else if (type === 'final-warning') {
        this.showStewardsNotification(`STEWARDS: FINAL WARNING ${this.trackLimitsCount}/${this.stewardProfile.warningLimit}`);
      } else if (type === 'track-limit-penalty') {
        this.penaltyMs += penaltyMs;
        this.showStewardsNotification(`STEWARDS: +${(penaltyMs / 1000).toFixed(1)}s TIME PENALTY (TRACK LIMITS)`);
      } else if (type === 'shortcut-penalty') {
        this.penaltyMs += penaltyMs;
        this.advantageAlertActive = false;
        this.showStewardsNotification(`STEWARDS: +${(penaltyMs / 1000).toFixed(1)}s PENALTY (SUSTAINED SHORTCUT)`);
      }
    }

    // Engine, aero, braking, surface resistance, and corner scrub determine
    // speed continuously. Car top-speed stats calibrate this balance but no
    // longer act as a hard speed clamp.
    if (boostActive) {
      this.boostEnergy = Math.max(0, this.boostEnergy - this.boostDrain * dt);
      this.smokeEmitter.emitting = true;
      this.boostEmitter.emitting = true;
      if (Math.random() < 0.1) playBoostSound();

      // Exhaust particle position and rotation follow
      const offsetDist = -16;
      const rx = this.player.x + Math.cos(this.player.rotation) * offsetDist;
      const ry = this.player.y + Math.sin(this.player.rotation) * offsetDist;
      this.boostEmitter.setPosition(rx, ry);
      const oppositeAngle = Phaser.Math.RadToDeg(this.player.rotation) + 180;
      this.boostEmitter.setAngle({ min: oppositeAngle - 15, max: oppositeAngle + 15 });

      if (this.boostEnergy <= 0) {
        this.boostActive = false;
        this.smokeEmitter.emitting = false;
        this.boostEmitter.emitting = false;
        window.dispatchEvent(new CustomEvent('pixel-prix:boost-state', { detail: { active: false } }));
      }
    } else {
      this.boostEnergy = Math.min(100, this.boostEnergy + this.ersRecovery * dt);
      this.boostEmitter.emitting = false;
    }

    if (this.smokeEmitter.emitting) {
      const offsetDist = -14;
      const rx = this.player.x + Math.cos(this.player.rotation) * offsetDist;
      const ry = this.player.y + Math.sin(this.player.rotation) * offsetDist;
      this.smokeEmitter.setPosition(rx, ry);
    }

    const offRoadFactor = (this.carData.offRoadFactor ?? 0.55);
    if (this.currentSpeed < 0) {
      // Keep reverse behaviour intentionally simple and separate from the
      // forward force model.
      if (gasOn) {
        this.currentSpeed += this.brakeForce * dt;
        if (this.currentSpeed > 0) this.currentSpeed = 0;
      } else if (brakeOn) {
        this.currentSpeed = Math.max(-85 * 2.4, this.currentSpeed - this.acceleration * 0.8 * brakeValue * dt);
      } else {
        this.currentSpeed = Math.min(0, this.currentSpeed + this.drag * dt);
      }
    } else if (this.currentSpeed === 0 && brakeOn && !gasOn) {
      this.currentSpeed = Math.max(-85 * 2.4, -this.acceleration * 0.8 * brakeValue * dt);
    } else {
      const dynamics = advanceVehicleDynamics({
        speedKph: displayedSpeed,
        throttle: Math.max(gasValue, boostActive ? 0.45 : 0),
        brake: brakeValue,
        boostActive,
        onGrass: this.onGrass,
        offRoadFactor,
        accelerationStat: this.accelerationStat,
        brakeForceStat: this.brakeForceStat,
        dragStat: this.carData.drag ?? 25,
        referenceTopSpeedKph: this.referenceTopSpeedKph,
        boostAccelerationStat: this.boostAccelerationStat,
        boostReferenceTopSpeedKph: this.referenceBoostTopSpeedKph,
        accelerationFactor: handling.accelerationFactor * (1 / (1 + cornerOverspeed * 0.65)),
        steerInput: steerDir,
        trackContext,
        deltaSeconds: dt
      });
      this.currentSpeed = dynamics.speedKph * 2.4;
    }

    const targetVx = Math.cos(this.player.rotation) * this.currentSpeed;
    const targetVy = Math.sin(this.player.rotation) * this.currentSpeed;
    const terrainResponse = this.onGrass ? 0.82 : 1;
    const directionResponse = Phaser.Math.Clamp(
      handling.directionResponse * terrainResponse * trackContext.surfaceGrip / (1 + cornerOverspeed * 0.6),
      0.045,
      0.31
    );
    this.vx = Phaser.Math.Linear(this.vx, targetVx, directionResponse);
    this.vy = Phaser.Math.Linear(this.vy, targetVy, directionResponse);

    // Apply movement velocity to Arcade Physics body and sprite position
    if (this.player && this.player.body) {
      this.player.body.setVelocity(this.vx, this.vy);
    }

    // Spark emitter countdown timer to avoid setTimeout GC allocations
    if (this.sparkDuration > 0) {
      this.sparkDuration -= dt;
      if (this.sparkDuration <= 0) {
        this.sparkEmitter.emitting = false;
      }
    }

    // Smoke and sparks on lateral slide
    const lateralSlip = Math.abs(this.vx - targetVx) + Math.abs(this.vy - targetVy);
    const hardBraking = brakeOn && Math.abs(this.currentSpeed) > 100 * 2.4;

    const needsSkid = (hardBraking && Math.abs(this.currentSpeed) > 100 * 2.4) ||
                      (lateralSlip > 45 && Math.abs(this.currentSpeed) > 120 * 2.4 && steerDir !== 0);
    if (needsSkid) {
      this.skidEmitter.emitParticleAt(this.player.x, this.player.y);
    }

    if (lateralSlip > 45 && Math.abs(this.currentSpeed) > 120 * 2.4 && steerDir !== 0) {
      this.smokeEmitter.emitting = true;
      if (Math.random() < 0.15) {
        this.sparkEmitter.emitting = true;
        this.sparkDuration = 0.08;
      }
    } else if (!boostActive) {
      this.smokeEmitter.emitting = false;
    }

    if (hardBraking && Math.abs(this.currentSpeed) > 120 * 2.4) {
      if (Math.random() < 0.2) {
        this.sparkEmitter.emitting = true;
        this.sparkDuration = 0.06;
      }
    }

    const speedLoss = this.prevSpeed - this.currentSpeed;
    if (speedLoss > 60 * 2.4 && Math.abs(this.currentSpeed) < 20 * 2.4) {
      this.cameras.main.shake(250, 0.008);
    }

    const isThrottle = gasOn || this.boostActive;
    updateEnginePitch(Math.abs(this.currentSpeed) / this.maxSpeed, isThrottle);

    // Checkpoints
    this.checkCheckpoints();

    if (!this.raceFinished) {
      this.updateGrandPrixField(delta);
      this.recordGhostReplay();
    }

    if (mpState.isMultiplayer) {
      this.updateMultiplayerView();
      this.updateMultiplayerHUD(false);
    }
  }

  getRaceProgress() {
    const segmentCount = Math.max(1, (this.curvePoints?.length || 2) - 1);
    const currentSegment = this.nearestSegmentIndex >= 0
      ? this.nearestSegmentIndex
      : this.startSegmentIndex;
    const relativeSegment = ((currentSegment - this.startSegmentIndex) % segmentCount + segmentCount) % segmentCount;
    const segmentProgress = Phaser.Math.Clamp(relativeSegment / segmentCount, 0, 0.999);
    return Math.max(0, (this.currentLap - 1) + segmentProgress);
  }

  updateMultiplayerView() {
    const now = Date.now();
    const startPos = this.trackData.startPos;

    mpState.remotePlayers.forEach((rp, id) => {
      if (now - rp.lastUpdate > 3500) {
        rp.sprite?.destroy();
        rp.nameTag?.destroy();
        mpState.remotePlayers.delete(id);
        return;
      }

      const targetX = Number.isFinite(rp.targetX) ? rp.targetX : startPos.x;
      const targetY = Number.isFinite(rp.targetY) ? rp.targetY : startPos.y;
      if (!rp.sprite) {
        const tex = 'car_' + (rp.carId || 'scuderia-furiosa') + '_straight';
        rp.sprite = this.add.sprite(targetX, targetY, tex);
        rp.sprite.setOrigin(0.5, 0.5);
        rp.sprite.setAlpha(0.85);
        rp.sprite.setDepth(15);
        rp.sprite.setTint(0x00F0FF);

        const pInfo = mpState.players.find((player) => player.id === id);
        const gridText = pInfo ? `P${(pInfo.gridPos || 0) + 1} | ` : '';
        rp.nameTag = this.add.text(targetX, targetY - 28, `${gridText}${rp.name}`, {
          fontFamily: 'monospace',
          fontSize: '10px',
          fontWeight: 'bold',
          color: '#00F0FF',
          backgroundColor: 'rgba(8, 10, 15, 0.8)',
          padding: { x: 5, y: 2 }
        });
        rp.nameTag.setOrigin(0.5, 0.5);
        rp.nameTag.setDepth(16);
      }

      rp.sprite.x = Phaser.Math.Linear(rp.sprite.x, targetX, 0.25);
      rp.sprite.y = Phaser.Math.Linear(rp.sprite.y, targetY, 0.25);
      rp.sprite.rotation = Phaser.Math.Angle.Wrap(Phaser.Math.Linear(rp.sprite.rotation, rp.targetRotation || 0, 0.25));
      rp.nameTag?.setPosition(rp.sprite.x, rp.sprite.y - 28);
    });

    if (!this.spectatorMode && !this.raceFinished) {
      this.applyMultiplayerCarContacts();
    }
  }

  applyMultiplayerCarContacts() {
    if (!this.player) return;
    const contactRadius = 46;
    const contactRadiusSq = contactRadius * contactRadius;

    mpState.remotePlayers.forEach((remote) => {
      if (!remote.sprite) return;
      const dx = this.player.x - remote.sprite.x;
      const dy = this.player.y - remote.sprite.y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq >= contactRadiusSq) return;

      const distance = Math.max(1, Math.sqrt(distanceSq));
      const overlap = contactRadius - distance;
      const normalX = dx / distance;
      const normalY = dy / distance;

      // Contact is intentionally soft: each local simulation resolves its own
      // car away from the remote snapshot, avoiding network authority fights
      // while making side-by-side contact tangible instead of pass-through.
      this.player.x += normalX * overlap * 0.56;
      this.player.y += normalY * overlap * 0.56;
      remote.sprite.x -= normalX * overlap * 0.18;
      remote.sprite.y -= normalY * overlap * 0.18;
      this.vx += normalX * Math.min(95, overlap * 7);
      this.vy += normalY * Math.min(95, overlap * 7);

      const now = this.time.now;
      if (now - this.lastMultiplayerContactAt > 170) {
        this.currentSpeed *= 0.94;
        this.lastMultiplayerContactAt = now;
      }
    });
  }

  getSpectatorTarget() {
    const finishedIds = new Set(mpState.finishedPlayers.map((player) => player.id));
    return [...mpState.remotePlayers.values()]
      .filter((player) => player.sprite && !finishedIds.has(player.id) && Date.now() - player.lastUpdate < 3500)
      .sort((a, b) => (b.progress || 0) - (a.progress || 0))[0] || null;
  }

  centerCameraOnSpectator() {
    const target = this.getSpectatorTarget();
    if (target?.sprite) {
      this.cameras.main.centerOn(target.sprite.x, target.sprite.y);
      return;
    }
    this.centerCameraOnPlayer();
  }

  updateMultiplayerHUD(spectating) {
    const progress = this.getRaceProgress();
    const rankInfo = calculateLiveRank(this.currentLap, this.nextCheckpointIndex, this.elapsedMs, progress);
    const lapEl = document.getElementById('hud-lap-text');
    const status = document.getElementById('hud-mp-status');
    const statusLabel = document.getElementById('hud-mp-status-label');
    const statusText = document.getElementById('hud-mp-status-text');

    status?.classList.remove('hidden');
    if (spectating) {
      const target = this.getSpectatorTarget();
      if (lapEl) lapEl.textContent = 'SPECTATING';
      if (statusLabel) statusLabel.textContent = 'WATCHING';
      if (statusText) statusText.textContent = target ? target.name.toUpperCase() : 'RACE COMPLETE';
      return;
    }

    if (lapEl) {
      lapEl.innerHTML = `${this.currentLap}/${this.totalLaps} <span style="color:#00F0FF; margin-left:6px; font-weight:900;">P${rankInfo.rank}/${rankInfo.total}</span>`;
    }
    if (statusLabel) statusLabel.textContent = 'GAP';
    if (statusText) {
      statusText.textContent = rankInfo.rank === 1
        ? 'LEADER'
        : (rankInfo.leaderFinished ? 'LEADER FINISHED' : `+${(rankInfo.gapMs / 1000).toFixed(1)}s`);
    }
  }

  /**
   * Maps a standard browser gamepad to the same analog controls used by
   * touch input. Supports Xbox, PlayStation, and most generic controllers
   * without taking ownership of keyboard or touch controls.
   */
  readGamepadInputs() {
    if (!navigator.getGamepads) {
      return { steer: 0, throttle: 0, brake: 0, boost: false };
    }

    const gamepad = Array.from(navigator.getGamepads()).find((pad) => pad?.connected);
    if (!gamepad) {
      return { steer: 0, throttle: 0, brake: 0, boost: false };
    }

    const buttonValue = (index) => gamepad.buttons[index]?.value || 0;
    const buttonPressed = (index) => Boolean(gamepad.buttons[index]?.pressed) || buttonValue(index) > 0.5;
    const deadzone = 0.16;
    const rawSteer = gamepad.axes[0] || 0;
    const steer = Math.abs(rawSteer) >= deadzone
      ? Math.sign(rawSteer) * Math.pow(Math.abs(rawSteer), 1.45)
      : 0;

    return {
      steer,
      // Right trigger / A accelerates; left trigger / B brakes or reverses.
      throttle: Math.max(buttonValue(7), buttonPressed(0) ? 1 : 0),
      brake: Math.max(buttonValue(6), buttonPressed(1) ? 1 : 0),
      // Shoulder buttons activate ERS boost.
      boost: buttonPressed(4) || buttonPressed(5)
    };
  }

  checkCheckpoints() {
    const cps = this.trackData.checkpoints;
    const targetCPIndex = this.nextCheckpointIndex;
    const targetCP = cps[targetCPIndex];
    if (!targetCP) return;

    if (checkCheckpointProximity(this.player.x, this.player.y, targetCP, this.roadWidth)) {
      playCheckpointSound();

      const s1End = this.trackData.sector1End;
      const s2End = this.trackData.sector2End;

      if (targetCPIndex === s1End) {
        // Sector 1 completes
        const s1_time = this.time.now - this.sectorStartTime;
        this.currentLapSectors[0] = s1_time;

        const isBest = this.bestSectors[0] === null || s1_time < this.bestSectors[0];
        if (isBest) this.bestSectors[0] = s1_time;

        window.dispatchEvent(new CustomEvent('pixel-prix:sector-complete', {
          detail: { sector: 1, timeMs: s1_time, isBest }
        }));

        this.currentSector = 2;
        this.sectorStartTime = this.time.now;
      }
      else if (targetCPIndex === s2End) {
        // Sector 2 completes
        const s2_time = this.time.now - this.sectorStartTime;
        this.currentLapSectors[1] = s2_time;

        const isBest = this.bestSectors[1] === null || s2_time < this.bestSectors[1];
        if (isBest) this.bestSectors[1] = s2_time;

        window.dispatchEvent(new CustomEvent('pixel-prix:sector-complete', {
          detail: { sector: 2, timeMs: s2_time, isBest }
        }));

        this.currentSector = 3;
        this.sectorStartTime = this.time.now;
      }

      this.totalCheckpointsHit++;
      this.nextCheckpointIndex = (this.nextCheckpointIndex + 1) % cps.length;

      // Hitting START/FINISH line (checkpoint 0)
      if (this.nextCheckpointIndex === 1) {
        // Sector 3 completes
        const s3_time = this.time.now - this.sectorStartTime;
        this.currentLapSectors[2] = s3_time;

        const isBest = this.bestSectors[2] === null || s3_time < this.bestSectors[2];
        if (isBest) this.bestSectors[2] = s3_time;

        window.dispatchEvent(new CustomEvent('pixel-prix:sector-complete', {
          detail: { sector: 3, timeMs: s3_time, isBest }
        }));

        this.lapSectors.push([...this.currentLapSectors]);
        this.currentSector = 1;
        this.sectorStartTime = this.time.now;

        const lapTime = this.time.now - this.lapStartTime;
        this.lapTimes.push(lapTime);
        this.lapStartTime = this.time.now;
        
        // Reset current lap sectors
        this.currentLapSectors = [0, 0, 0];

        if (this.currentLap < this.totalLaps) {
          this.currentLap++;
          this.showNotification('LAP ' + this.currentLap + ' / ' + this.totalLaps);
        } else {
          this.finishRace();
        }
      } else if (targetCPIndex !== s1End && targetCPIndex !== s2End) {
        // Normal intermediate checkpoints
        this.showNotification('CHECKPOINT ' + targetCP.id);
      }
    }
  }

  finishRace() {
    this.raceFinished = true;
    this.player.setVelocity(0, 0);
    stopEngineSound();
    playFinishSound();

    if (this.input && this.input.keyboard) {
      this.input.keyboard.enabled = false;
      this.input.keyboard.clearCaptures();
    }

    this.boostActive = false;
    if (this.smokeEmitter) this.smokeEmitter.emitting = false;
    if (this.boostEmitter) this.boostEmitter.emitting = false;
    this.emitHUDUpdate();
    window.dispatchEvent(new CustomEvent('pixel-prix:boost-state', { detail: { active: false } }));

    const bestLapMs = this.lapTimes.length > 0 ? Math.min(...this.lapTimes) : this.elapsedMs;
    const finalTime = this.elapsedMs + this.penaltyMs;
    this.finalTimeMs = finalTime;

    if (this.ghostRecorder && !mpState.isMultiplayer) {
      captureGhostSample(this.ghostRecorder, {
        timeMs: this.elapsedMs,
        x: this.player.x,
        y: this.player.y,
        rotation: this.player.rotation
      });
      const savedGhost = saveGhostReplay(this.ghostSession, this.ghostRecorder, finalTime);
      if (savedGhost) this.showNotification('NEW PERSONAL GHOST RECORDED');
    }

    if (this.isGrandPrix) {
      this.updateGrandPrixClassification();
    }

    if (mpState.isMultiplayer) {
      stopPositionBroadcast();
      broadcastRaceFinish(finalTime, bestLapMs);
      this.spectatorMode = true;
      mpState.spectating = true;
      document.getElementById('screen-hud')?.classList.add('spectator-mode');
      this.showNotification('CHEQUERED FLAG — SPECTATING ACTIVE RACE');
      this.updateMultiplayerHUD(true);
      return;
    }

    window.dispatchEvent(new CustomEvent('pixel-prix:finish', {
      detail: {
        rawTimeMs: this.elapsedMs,
        penaltyMs: this.penaltyMs,
        totalTimeMs: finalTime,
        bestLapMs: bestLapMs,
        carId: this.carData.id,
        trackId: this.trackData.id,
        lapSectors: this.lapSectors,
        bestSectors: this.bestSectors,
        raceMode: this.raceMode,
        weatherId: this.weatherCondition.id,
        weatherLabel: this.weatherCondition.label,
        setupId: this.setupProfile.id,
        position: this.isGrandPrix ? this.grandPrixPosition : null,
        fieldSize: this.isGrandPrix ? this.grandPrixClassification.length : 1,
        classification: this.isGrandPrix ? this.grandPrixClassification : null,
        leaderboardEligible: this.leaderboardEligible
      }
    }));
  }

  showNotification(msg, type = 'normal') {
    window.dispatchEvent(new CustomEvent('pixel-prix:notify', {
      detail: { text: msg, type }
    }));
  }

  showStewardsNotification(msg) {
    this.showNotification(msg, 'stewards');
  }

  emitHUDUpdate() {
    window.dispatchEvent(new CustomEvent('pixel-prix:hud', {
      detail: {
        speed: Math.round(Math.abs(this.currentSpeed) / 2.4),
        isReverse: this.currentSpeed < -12,
        lap: this.currentLap,
        totalLaps: this.totalLaps,
        timeMs: this.elapsedMs,
        penaltyMs: this.penaltyMs,
        stewardInvestigation: this.offRoadWarningIssued || this.advantageAlertActive,
        boostEnergy: this.boostEnergy,
        boostActive: this.boostActive,
        speedRatio: Math.min(1.0, Math.abs(this.currentSpeed) / (this.maxSpeed || 275)),
        currentSector: this.currentSector,
        sectorTimeMs: this.raceStarted && !this.raceFinished ? (this.time.now - this.sectorStartTime) : 0,
        raceMode: this.raceMode,
        racePosition: this.isGrandPrix ? this.grandPrixPosition : null,
        fieldSize: this.isGrandPrix ? Math.max(1, this.grandPrixClassification.length) : null,
        weatherLabel: this.weatherCondition?.label || '',
        ghostActive: Boolean(this.ghostSprite?.visible)
      }
    }));
  }

  // Touch control setters (called from main.js)
  setAccelerate(v) { this.isAccelerating = Boolean(v); }
  setSteerLeft(v) { this.isSteeringLeft = Boolean(v); }
  setSteerRight(v) { this.isSteeringRight = Boolean(v); }
  setBrake(v) { this.isBraking = Boolean(v); }
  setBoost(v) { this.isBoosting = Boolean(v); }
  setSteeringValue(v) {
    this.touchSteerValue = Phaser.Math.Clamp(Number(v) || 0, -1, 1);
  }
  setTouchGas(v) {
    this.touchGas = Phaser.Math.Clamp(Number(v) || 0, 0, 1);
  }
  setTouchBrake(v) {
    this.touchBrake = Phaser.Math.Clamp(Number(v) || 0, 0, 1);
  }
  setJoystickHeading(heading, active) {
    this.joystickHeading = Number.isFinite(Number(heading)) ? Number(heading) : 0;
    this.joystickActive = Boolean(active);
    // When joystick is released, stop the car's angular rotation immediately.
    // If the joystick becomes active but heading hasn't changed, treat as release.
    if (!active) {
      this.joystickActive = false;
    }
  }

  cleanup() {
    stopPositionBroadcast();
    stopEngineSound();
    this.aiRivals.forEach((rival) => {
      rival.sprite?.destroy();
      rival.nameTag?.destroy();
    });
    this.aiRivals = [];
    this.ghostSprite?.destroy();
    this.ghostLabel?.destroy();
    this.weatherOverlay?.destroy();
    this.rainEmitter?.destroy();
    this.ghostSprite = null;
    this.ghostLabel = null;
    this.weatherOverlay = null;
    this.rainEmitter = null;
    if (this._lightsGreenHandler) {
      window.removeEventListener('pixel-prix:lights-green', this._lightsGreenHandler);
      this._lightsGreenHandler = null;
    }
    if (this._notifEvent) {
      this._notifEvent.destroy();
      this._notifEvent = null;
    }
    this.scale.off('resize', this.frameCamera, this);
    // Remove speed vignette on cleanup
    this.updateSpeedVignette(0);
    this.touchSteerValue = 0;
    this.touchGas = 0;
    this.touchBrake = 0;
    if (this._preventScrollHandler) {
      window.removeEventListener('keydown', this._preventScrollHandler);
      this._preventScrollHandler = null;
    }
    if (this._kbHandler) {
      window.removeEventListener('keydown', this._kbHandler);
      window.removeEventListener('keyup', this._kbHandler);
      this._kbHandler = null;
    }
    if (this._resetInputHandler) {
      window.removeEventListener('blur', this._resetInputHandler);
      document.removeEventListener('visibilitychange', this._resetInputHandler);
      this._resetInputHandler = null;
    }
  }

  updateSpeedVignette(ratio) {
    let el = document.getElementById('hud-speed-vignette');
    if (!el) {
      el = document.createElement('div');
      el.id = 'hud-speed-vignette';
      el.setAttribute('aria-hidden', 'true');
      Object.assign(el.style, {
        position: 'fixed',
        inset: '0',
        pointerEvents: 'none',
        zIndex: '5',
        transition: 'opacity 0.3s ease, background 0.4s ease',
        background:
          'radial-gradient(ellipse at center, transparent 40%, rgba(232,0,45,0.04) 70%, rgba(10,8,20,0.55) 100%)',
      });
      document.body.appendChild(el);
    }

    // Shift vignette colors if Boost is active (ERS Cyan glow vs F1 Red glow)
    if (this.boostActive) {
      el.style.background = 'radial-gradient(ellipse at center, transparent 30%, rgba(0,210,255,0.08) 60%, rgba(8,30,55,0.7) 100%)';
    } else {
      el.style.background = 'radial-gradient(ellipse at center, transparent 40%, rgba(232,0,45,0.04) 70%, rgba(10,8,20,0.55) 100%)';
    }

    el.style.opacity = Math.max(0, ratio - 0.3) * 1.4;
  }
}
