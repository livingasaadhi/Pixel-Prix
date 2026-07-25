import Phaser from 'phaser';
import { getCarById } from '../data/cars.js';
import { getTrackById } from '../data/tracks.js';
import { renderTrackGraphics } from '../utils/trackRenderer.js';
import { getNearestSegmentIndex, checkCheckpointProximity, isOffRoad } from '../utils/trackPhysics.js';
import { startEngineSound, updateEnginePitch, stopEngineSound, setEngineActive, playBoostSound, playCheckpointSound, playFinishSound } from '../utils/audio.js';
import { mpState, startPositionBroadcast, stopPositionBroadcast, broadcastRaceFinish, calculateLiveRank } from '../utils/multiplayer.js';

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

    // Racing state
    this.currentLap = 1;
    this.nextCheckpointIndex = 1;
    this.totalCheckpointsHit = 0;
    this.raceStarted = false;
    this.raceFinished = false;
    this.lightsGreen = false;
    this.hasFalseStartPenalty = false;

    // Penalty state
    this.trackLimitsCount = 0;
    this.penaltyMs = 0;
    this.offRoadDurationMs = 0;
    this.advantageAlertActive = false;
    this.advantageTimerMs = 0;
    this.offRoadGraceMs = 0; // Grace period when returning to track
    this.offRoadWarningIssued = false;
    const stewardProfile = this.trackData.stewards || {};
    this.warningThresholdMs = stewardProfile.reviewMs ?? 2600;
    this.penaltyThresholdMs = stewardProfile.breachMs ?? 5400;
    this.shortcutThresholdMs = stewardProfile.shortcutMs ?? 4400;
    this.offTrackSpeedKph = stewardProfile.offTrackSpeedKph ?? 170;
    this.shortcutSpeedKph = stewardProfile.shortcutSpeedKph ?? 275;
    this.offRoadRecoveryMs = stewardProfile.recoveryMs ?? 950;
    this.trackLimitsWarningLimit = stewardProfile.warningLimit ?? 3;
    this.trackLimitPenaltyMs = stewardProfile.trackLimitPenaltyMs ?? 2000;
    this.shortcutPenaltyMs = stewardProfile.shortcutPenaltyMs ?? 3000;

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

    // Tunable physics parameters (scaled by 2.4x for high-speed AAA racing feel)
    const VEL_MULT = 2.4;
    this.maxSpeed = (this.carData.maxSpeed || this.carData.topSpeed || 275) * VEL_MULT;
    this.boostMaxSpeed = (this.carData.boostMaxSpeed || (this.maxSpeed * (this.carData.boostPower || 1.45))) * VEL_MULT;
    this.acceleration = (this.carData.acceleration || 180) * VEL_MULT;
    this.boostAcceleration = (this.carData.boostAcceleration || 380) * VEL_MULT;
    this.brakeForce = (this.carData.brakeForce || 450) * VEL_MULT;
    this.drag = (this.carData.drag || 25.0) * VEL_MULT;
    this.steeringSensitivity = (this.carData.steeringSensitivity || this.carData.handling || 4.4) * 1.48;
    this.highSpeedSteeringMultiplier = this.carData.highSpeedSteeringMultiplier || 0.48;

    // Vehicle identity is deliberately expressed through a few intuitive
    // behaviours. Defaults preserve the original roster while newer cars
    // gain meaningful launch, cornering and ERS trade-offs.
    this.launchGrip = Phaser.Math.Clamp(this.carData.launchGrip ?? 1, 0.92, 1.16);
    this.corneringGrip = Phaser.Math.Clamp(this.carData.corneringGrip ?? 1, 0.92, 1.14);
    this.ersRecovery = Phaser.Math.Clamp(this.carData.ersRecovery ?? 12, 8, 16);
    this.boostDrain = Phaser.Math.Clamp(this.carData.boostDrain ?? 35, 28, 42);

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

    // 3. Create player car sprite (with deterministic grid slot placement for multiplayer)
    const startPos = this.trackData.startPos;
    let gridSlot = 0;
    if (mpState.isMultiplayer && mpState.players.length > 0) {
      const pMatch = mpState.players.find(p => p.id === mpState.localPlayer.id);
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

    // Guaranteed fallback when a browser animation/event is interrupted.
    this.time.delayedCall(4500, () => this.beginRace());

    // 7. Register shutdown handler
    this.events.once('shutdown', this.cleanup, this);

    // 8. Start countdown and emit initial HUD values
    this.emitHUDUpdate();
    this.startCountdown();
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
        this.penaltyMs += 2000;
        this.showStewardsNotification('STEWARDS: +2.0s PENALTY (FALSE START)');
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
    if (this.time.now - this.lastHUDUpdate > 33) {
      this.emitHUDUpdate();
      this.lastHUDUpdate = this.time.now;
    }

    this.prevSpeed = this.currentSpeed;

    const speedRatio = Math.min(1.0, Math.abs(this.currentSpeed) / (this.maxSpeed || 275));
    const targetZoom = (this.baseZoom || 0.7) * (1.0 - speedRatio * 0.10);
    cam.zoom = Phaser.Math.Linear(cam.zoom, targetZoom, 2.5 * dt);

    this.updateSpeedVignette(speedRatio);

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

    setEngineActive(gasOn || boostActive);

    const steerSpeedRatio = Math.min(1.0, Math.abs(this.currentSpeed) / (this.maxSpeed || 275));
    const speedDamping = Math.max(this.highSpeedSteeringMultiplier, 1.0 - steerSpeedRatio * 0.55);
    const boostBonus = boostActive ? 1.15 : 1.0;
    if (Math.abs(this.currentSpeed) > 1.0) {
      // Joystick absolute heading mode (mobile touch)
      if (this.joystickActive) {
        // Compute shortest angular difference toward target heading
        const diff = Phaser.Math.Angle.Wrap(this.joystickHeading - this.player.rotation);
        // Apply limited turn rate per second for smooth rotation
        const maxTurn = this.turnRate * speedDamping * boostBonus * dt;
        const step = Math.sign(diff) * Math.min(Math.abs(diff), maxTurn);
        this.player.rotation += step;
      } else {
        // Keyboard / button steering: relative delta (existing behavior)
        this.player.rotation += steerDir * this.steeringSensitivity * speedDamping * boostBonus * dt;
      }
    }

    const grassCheck = getNearestSegmentIndex(this.player.x, this.player.y, this.curvePoints, this.nearestSegmentIndex);
    this.nearestSegmentIndex = grassCheck.nearestIndex;
    // Use the updated track tolerance (+35) as the single source of truth for off-road.
    this.onGrass = isOffRoad(this.player.x, this.player.y, this.curvePoints, this.roadWidth);

    const displayedSpeed = Math.abs(this.currentSpeed) / 2.4;
    const isMeaningfulOffTrack = this.onGrass && displayedSpeed >= this.offTrackSpeedKph;

    if (isMeaningfulOffTrack) {
      this.offRoadDurationMs += delta;
      this.offRoadGraceMs = 0; // Reset grace when actively off-road

      // A high-speed sustained cut is a direct advantage, separate from the
      // normal three-warning track-limit ladder.
      if (this.offRoadDurationMs >= this.shortcutThresholdMs && displayedSpeed >= this.shortcutSpeedKph) {
        this.penaltyMs += this.shortcutPenaltyMs;
        this.offRoadDurationMs = 0;
        this.offRoadWarningIssued = false;
        this.advantageAlertActive = false;
        this.showStewardsNotification(`STEWARDS: +${(this.shortcutPenaltyMs / 1000).toFixed(1)}s PENALTY (SUSTAINED SHORTCUT)`);
      } else if (this.offRoadDurationMs >= this.penaltyThresholdMs) {
        this.handleTrackLimitsViolation();
        this.offRoadDurationMs = 0; // Reset after penalty
        this.offRoadWarningIssued = false;
      } else if (this.offRoadDurationMs >= this.warningThresholdMs && !this.offRoadWarningIssued) {
        this.offRoadWarningIssued = true;
        this.showStewardsNotification('STEWARDS: TRACK LIMITS UNDER REVIEW');
      }
    } else {
      // A brief re-entry cannot erase a repeated cut. Once the driver has
      // genuinely recovered, accumulated off-track time drains gradually.
      this.offRoadGraceMs += delta;
      if (this.offRoadGraceMs >= this.offRoadRecoveryMs) {
        this.offRoadDurationMs = Math.max(0, this.offRoadDurationMs - delta * 1.35);
        if (this.offRoadDurationMs < 250) this.offRoadWarningIssued = false;
      }
    }

    // Speed physics with momentum
    let targetMaxSpeed = boostActive ? this.boostMaxSpeed : this.maxSpeed;
    let currentAccel = boostActive ? this.boostAcceleration : this.acceleration;

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

    // Apply car-specific off-road behavior based on handling characteristic
    // offRoadFactor: higher = better grip on grass (handling cars), lower = struggles more (speed cars)
    const offRoadFactor = (this.carData.offRoadFactor ?? 0.55);
    if (this.onGrass) {
      targetMaxSpeed *= offRoadFactor;
      currentAccel *= 0.6 + (offRoadFactor - 0.55) * 0.5; // More handling = slightly better acceleration on grass
    }

    if (gasOn) {
      if (this.currentSpeed < 0) {
        this.currentSpeed += this.brakeForce * dt;
        if (this.currentSpeed > 0) this.currentSpeed = 0;
      } else if (this.currentSpeed < targetMaxSpeed) {
        const ratio = Math.max(0, this.currentSpeed / targetMaxSpeed);
        const launchWindow = Math.max(0, 1 - ratio / 0.24);
        const launchModifier = 1 + (this.launchGrip - 1) * launchWindow;
        const launchAccel = currentAccel * (1.75 - 0.95 * Math.pow(ratio, 1.3)) * launchModifier;
        this.currentSpeed += launchAccel * gasValue * dt;
        if (this.currentSpeed > targetMaxSpeed) {
          this.currentSpeed = targetMaxSpeed;
        }
      } else if (this.currentSpeed > targetMaxSpeed) {
        this.currentSpeed -= (this.onGrass ? this.drag * 3.5 : this.drag) * dt;
        if (this.currentSpeed < targetMaxSpeed) {
          this.currentSpeed = targetMaxSpeed;
        }
      }
    } else if (boostActive) {
      if (this.currentSpeed < targetMaxSpeed) {
        this.currentSpeed += currentAccel * dt;
        if (this.currentSpeed > targetMaxSpeed) {
          this.currentSpeed = targetMaxSpeed;
        }
      }
    } else if (brakeOn) {
      if (this.currentSpeed > 0) {
        this.currentSpeed -= this.brakeForce * brakeValue * dt;
        if (this.currentSpeed < 0) this.currentSpeed = 0;
      } else {
        if (this.currentSpeed > -85 * 2.4) {
          this.currentSpeed -= this.acceleration * 0.8 * brakeValue * dt;
        }
      }
    } else {
      const currentDrag = this.onGrass ? (this.drag * 3.5) : this.drag;
      if (this.currentSpeed > targetMaxSpeed) {
        this.currentSpeed -= currentDrag * dt;
        if (this.currentSpeed < targetMaxSpeed) {
          this.currentSpeed = targetMaxSpeed;
        }
      } else if (this.currentSpeed > 0) {
        this.currentSpeed -= currentDrag * dt;
        if (this.currentSpeed < 0) this.currentSpeed = 0;
      } else if (this.currentSpeed < 0) {
        this.currentSpeed += currentDrag * dt;
        if (this.currentSpeed > 0) this.currentSpeed = 0;
      }
    }

    const targetVx = Math.cos(this.player.rotation) * this.currentSpeed;
    const targetVy = Math.sin(this.player.rotation) * this.currentSpeed;
    const baseGrip = (boostActive || steerDir !== 0) ? 0.98 : 0.94;
    const grip = Phaser.Math.Clamp(baseGrip + (this.corneringGrip - 1) * 0.035 - (this.onGrass ? 0.025 : 0), 0.9, 0.992);
    this.vx = Phaser.Math.Linear(this.vx, targetVx, grip);
    this.vy = Phaser.Math.Linear(this.vy, targetVy, grip);

    // Apply movement velocity to Arcade Physics body and sprite position
    if (this.player && this.player.body) {
      this.player.body.setVelocity(this.vx, this.vy);
    }
    this.player.x += this.vx * dt;
    this.player.y += this.vy * dt;

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

    if (mpState.isMultiplayer) {
      this.updateMultiplayerView();
      this.updateMultiplayerHUD(false);
    }
  }

  getRaceProgress() {
    const segmentCount = this.curvePoints?.length || 1;
    const segmentProgress = this.nearestSegmentIndex >= 0
      ? Phaser.Math.Clamp(this.nearestSegmentIndex / segmentCount, 0, 0.999)
      : 0;
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

  handleTrackLimitsViolation() {
    this.trackLimitsCount++;
    if (this.trackLimitsCount < this.trackLimitsWarningLimit) {
      this.showStewardsNotification(`STEWARDS: TRACK LIMITS WARNING ${this.trackLimitsCount}/${this.trackLimitsWarningLimit}`);
    } else if (this.trackLimitsCount === this.trackLimitsWarningLimit) {
      this.showStewardsNotification(`STEWARDS: FINAL WARNING ${this.trackLimitsWarningLimit}/${this.trackLimitsWarningLimit}`);
    } else {
      this.penaltyMs += this.trackLimitPenaltyMs;
      this.showStewardsNotification(`STEWARDS: +${(this.trackLimitPenaltyMs / 1000).toFixed(1)}s TIME PENALTY (TRACK LIMITS)`);
    }
    // Reset off-road duration after violation to give driver a chance to recover
    this.offRoadDurationMs = 0;
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
        bestSectors: this.bestSectors
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
        sectorTimeMs: this.raceStarted && !this.raceFinished ? (this.time.now - this.sectorStartTime) : 0
      }
    }));
  }

  // Touch control setters (called from main.js)
  setAccelerate(v) { this.isAccelerating = v; }
  setSteerLeft(v) { this.isSteeringLeft = v; }
  setSteerRight(v) { this.isSteeringRight = v; }
  setBrake(v) { this.isBraking = v; }
  setBoost(v) { this.isBoosting = v; }
  setSteeringValue(v) { this.touchSteerValue = v; }
  setTouchGas(v) { this.touchGas = v; }
  setTouchBrake(v) { this.touchBrake = v; }
  setJoystickHeading(heading, active) {
    this.joystickHeading = heading;
    this.joystickActive = active;
    // When joystick is released, stop the car's angular rotation immediately.
    // If the joystick becomes active but heading hasn't changed, treat as release.
    if (!active) {
      this.joystickActive = false;
    }
  }

  cleanup() {
    stopEngineSound();
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
