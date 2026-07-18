import Phaser from 'phaser';
import { getCarById } from '../data/cars.js';
import { getTrackById } from '../data/tracks.js';
import { renderTrackGraphics } from '../utils/trackRenderer.js';
import { isOffRoad, checkCheckpointProximity } from '../utils/trackPhysics.js';
import { startEngineSound, updateEnginePitch, stopEngineSound, playBoostSound, playCheckpointSound, playFinishSound } from '../utils/audio.js';

export class RaceScene extends Phaser.Scene {
  constructor() {
    super({ key: 'RaceScene' });
  }

  init(data) {
    const carId = (data && data.carId) ? data.carId : 'apex-phantom';
    const trackId = (data && data.trackId) ? data.trackId : 'monaco-oval';
    this.carData = getCarById(carId);
    this.trackData = getTrackById(trackId);
    this.totalLaps = this.trackData.laps || 2;

    // Racing state
    this.currentLap = 1;
    this.nextCheckpointIndex = 1;
    this.totalCheckpointsHit = 0;
    this.raceStarted = false;
    this.raceFinished = false;

    // Penalty state
    this.trackLimitsCount = 0;
    this.penaltyMs = 0;
    this.offRoadDurationMs = 0;
    this.advantageAlertActive = false;
    this.advantageTimerMs = 0;
    this.isBoostFiring = false;

    // Timer state
    this.startTime = 0;
    this.elapsedMs = 0;
    this.lapTimes = [];
    this.lapStartTime = 0;

    // Car physics state
    this.currentSpeed = 0;
    this.boostEnergy = 100;
    this.isAccelerating = false;
    this.isBoosting = false;
    this.isBraking = false;
    this.isSteeringLeft = false;
    this.isSteeringRight = false;
    this.onGrass = false;

    // Lateral drift physics
    this.vx = 0;
    this.vy = 0;

    // Cleanup refs
    this._notifTimeout = null;
    this._preventScrollHandler = null;
    this._kbHandler = null;
  }

  create() {
    // 1. World bounds
    this.physics.world.setBounds(0, 0, this.trackData.worldWidth, this.trackData.worldHeight);

    // 2. Render Track
    const trackResult = renderTrackGraphics(this, this.trackData);
    this.curvePoints = trackResult.curvePoints;
    this.roadWidth = trackResult.roadWidth;

    // 3. Create player car sprite
    const startPos = this.trackData.startPos;
    const textureKey = 'car_' + this.carData.id + '_straight';
    this.player = this.physics.add.sprite(startPos.x, startPos.y, textureKey);
    this.player.setOrigin(0.5, 0.5);
    this.player.setCollideWorldBounds(true);
    this.player.rotation = startPos.rotation || 0;

    // 4. Camera
    // Bound the camera to the track's actual footprint (not the oversized world
    // rectangle) so we never show large empty gridded margins around a small
    // loop, then frame it dynamically on resize.
    this.frameCamera();
    this.cameras.main.startFollow(this.player, true, 0.08, 0.08);
    this.scale.on('resize', this.frameCamera, this);

    // 5. Particles (smoke)
    this.smokeEmitter = this.add.particles(0, 0, 'smoke_particle', {
      speed: { min: 20, max: 60 },
      scale: { start: 0.8, end: 0 },
      alpha: { start: 0.6, end: 0 },
      lifespan: 350,
      blendMode: 'ADD',
      emitting: false
    });
    this.smokeEmitter.startFollow(this.player);

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

    // Robust keyboard fallback driven by event.code (case- and layout-
    // independent) so driving works whether the player types a/A, w/W, etc.
    // Phaser's own key objects are OR-ed with this in update() for redundancy.
    this._kb = {
      up: false, down: false, left: false, right: false,
      space: false, shift: false, z: false, c: false
    };
    const codeMap = {
      KeyW: 'up', ArrowUp: 'up',
      KeyS: 'down', ArrowDown: 'down',
      KeyA: 'left', ArrowLeft: 'left',
      KeyD: 'right', ArrowRight: 'right',
      Space: 'space', ShiftLeft: 'shift', ShiftRight: 'shift',
      KeyZ: 'z', KeyC: 'c'
    };
    this._kbHandler = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      const action = codeMap[e.code];
      if (action) {
        this._kb[action] = e.type === 'keydown';
        if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      }
    };
    window.addEventListener('keydown', this._kbHandler);
    window.addEventListener('keyup', this._kbHandler);

    // Prevent browser scrolling on game keys, but never while the user is
    // typing into a text field (e.g. the driver-name input on the results
    // screen) so those characters remain typeable.
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

    // 7. Register shutdown handler
    this.events.once('shutdown', this.cleanup, this);

    // 8. Start countdown
    this.startCountdown();
  }

  // Frame the camera around the track's real footprint. Using the spline
  // bounding box (instead of the full world rectangle) removes the empty
  // gridded margins, keeps the car centered, and zooms to show plenty of
  // upcoming track without leaving dead space above or below.
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

    cam.setBounds(minX - pad, minY - pad, trackW, trackH);

    const vw = this.scale.width || window.innerWidth;
    const vh = this.scale.height || window.innerHeight;

    // Cover the track footprint so it always fills the viewport (no empty
    // gridded margins). Clamp the zoom so the car never becomes a tiny dot on
    // large tracks nor too close on small ones; the follow camera keeps the
    // car centered while showing upcoming track.
    const cover = Math.max(vw / trackW, vh / trackH);
    const zoom = Math.max(0.45, Math.min(cover, 0.85));
    cam.setZoom(zoom);
  }

  startCountdown() {
    let count = 3;
    const el = document.getElementById('hud-notification');
    if (el) {
      el.classList.remove('hidden', 'stewards-warning');
      el.innerText = 'GET READY: 3';
    }

    this.time.addEvent({
      delay: 800,
      repeat: 3,
      callback: () => {
        count--;
        if (!el) return;
        if (count > 0) {
          el.innerText = 'GET READY: ' + count;
        } else if (count === 0) {
          el.innerText = 'LIGHTS OUT AND AWAY WE GO!';
          this.raceStarted = true;
          this.startTime = this.time.now;
          this.lapStartTime = this.time.now;
          startEngineSound();
        } else {
          el.classList.add('hidden');
        }
      }
    });
  }

  update(time, delta) {
    if (!this.raceStarted || this.raceFinished) return;

    const dt = delta / 1000;

    // Timer & HUD
    this.elapsedMs = this.time.now - this.startTime;
    this.emitHUDUpdate();

    // Steering
    let steerDir = 0;
    if (this.isSteeringLeft || this.cursors.left.isDown || this.wasd.left.isDown || this._kb.left) steerDir -= 1;
    if (this.isSteeringRight || this.cursors.right.isDown || this.wasd.right.isDown || this._kb.right) steerDir += 1;

    // Swap car texture for visual steering feedback
    const carTexBase = 'car_' + this.carData.id + '_';
    if (steerDir < 0) this.player.setTexture(carTexBase + 'left');
    else if (steerDir > 0) this.player.setTexture(carTexBase + 'right');
    else this.player.setTexture(carTexBase + 'straight');

    // Invert steering when reversing
    if (this.currentSpeed < -5) steerDir *= -1;

    // Boost activation logic: can only start boosting if energy >= 30%. Can sustain down to 2%.
    const boostButtonPressed = this.isBoosting || this.wasd.space.isDown || this.wasd.shift.isDown ||
                               this.boostKeyZ.isDown || this.boostKeyC.isDown ||
                               this._kb.space || this._kb.shift || this._kb.z || this._kb.c;
    
    if (boostButtonPressed) {
      if (this.isBoostFiring) {
        if (this.boostEnergy <= 2) {
          this.isBoostFiring = false;
        }
      } else {
        if (this.boostEnergy >= 75) {
          this.isBoostFiring = true;
        }
      }
    } else {
      this.isBoostFiring = false;
    }

    const boostActive = this.isBoostFiring && this.boostEnergy > 2;
    const gasOn = this.isAccelerating || this.cursors.up.isDown || this.wasd.up.isDown || this._kb.up;
    const brakeOn = this.isBraking || this.cursors.down.isDown || this.wasd.down.isDown || this._kb.down;

    // Realistic speed-dependent steering:
    // - At low speed: full turn rate (tight maneuvering)
    // - At high speed: reduced turn rate (wider, more stable arcs)
    // - Minimum floor of 0.35 so steering never fully locks up
    const speedRatio = Math.abs(this.currentSpeed) / this.carData.topSpeed;
    const speedDamping = Math.max(0.35, 1.0 - speedRatio * 0.65);
    const boostBonus = boostActive ? 1.15 : 1.0;
    if (Math.abs(this.currentSpeed) > 3) {
      this.player.rotation += steerDir * this.carData.handling * speedDamping * boostBonus * dt;
    }

    // Off-road check
    this.onGrass = isOffRoad(this.player.x, this.player.y, this.curvePoints, this.roadWidth);

    // Penalty engine (lenient: > 2.5s continuous off-road)
    if (this.onGrass && Math.abs(this.currentSpeed) > 60) {
      this.offRoadDurationMs += delta;
      
      // Track limits warning: triggered after 1.5 seconds off-road
      if (this.offRoadDurationMs > 1500) {
        this.handleTrackLimitsViolation();
        this.offRoadDurationMs = 0;
      }

      // Corner cutting detection: driving off-road at speed > 125 px/s (100 KM/H in UI) for more than 1.0 seconds
      if (Math.abs(this.currentSpeed) > 125 && !this.advantageAlertActive) {
        this.advantageAlertActive = true;
        this.advantageTimerMs = 3000; // 3 seconds to yield advantage
        this.showStewardsNotification('STEWARDS: SLOW DOWN BELOW 100 KM/H TO YIELD ADVANTAGE!');
      }
    } else {
      this.offRoadDurationMs = Math.max(0, this.offRoadDurationMs - delta * 2);
    }

    // Gained advantage resolution timer
    if (this.advantageAlertActive) {
      if (Math.abs(this.currentSpeed) * 0.8 < 100) {
        this.advantageAlertActive = false;
        this.advantageTimerMs = 0;
        this.showStewardsNotification('STEWARDS: ADVANTAGE YIELDED - WARNING CLEARED');
      } else {
        this.advantageTimerMs -= delta;
        if (this.advantageTimerMs <= 0) {
          this.penaltyMs += 10000; // +10s penalty
          this.advantageAlertActive = false;
          this.showStewardsNotification('STEWARDS: +10.0s PENALTY (CORNER CUTTING)');
        } else {
          const remainingSec = Math.ceil(this.advantageTimerMs / 1000);
          const el = document.getElementById('hud-notification');
          if (el) {
            el.innerText = `YIELD ADVANTAGE (<100 KM/H) OR +10s PENALTY IN ${remainingSec}s`;
            el.classList.remove('hidden');
            el.classList.add('stewards-warning');
          }
        }
      }
    }

    // Speed physics
    let topSpeed = this.carData.topSpeed;
    let accel = this.carData.acceleration;

    if (boostActive && gasOn) {
      topSpeed *= this.carData.boostPower;
      accel *= 2.2;
      this.boostEnergy = Math.max(0, this.boostEnergy - 35 * dt);
      this.smokeEmitter.emitting = true;
      if (Math.random() < 0.1) playBoostSound();
    } else {
      this.boostEnergy = Math.min(100, this.boostEnergy + 12 * dt);
    }

    if (this.onGrass) {
      topSpeed *= 0.55;
      accel *= 0.6;
    }

    if (gasOn) {
      if (this.currentSpeed < 0) {
        this.currentSpeed += accel * 3.0 * dt;
        if (this.currentSpeed > 0) this.currentSpeed = 0;
      } else {
        const ratio = Math.max(0, this.currentSpeed / topSpeed);
        const launchAccel = accel * (1.75 - 0.9 * Math.pow(ratio, 1.3));
        if (this.currentSpeed < topSpeed) {
          this.currentSpeed += launchAccel * dt;
        }
      }
    } else if (brakeOn) {
      if (this.currentSpeed > 15) {
        this.currentSpeed -= accel * 2.8 * dt;
        if (this.currentSpeed < 0) this.currentSpeed = 0;
      } else {
        if (this.currentSpeed > -85) {
          this.currentSpeed -= accel * 0.9 * dt;
        }
      }
    } else {
      if (this.currentSpeed > 0) {
        this.currentSpeed -= accel * 0.75 * dt;
        if (this.currentSpeed < 0) this.currentSpeed = 0;
      } else if (this.currentSpeed < 0) {
        this.currentSpeed += accel * 0.75 * dt;
        if (this.currentSpeed > 0) this.currentSpeed = 0;
      }
    }

    this.currentSpeed *= this.carData.drag;

    // Lateral drift physics
    const targetVx = Math.cos(this.player.rotation) * this.currentSpeed;
    const targetVy = Math.sin(this.player.rotation) * this.currentSpeed;
    const grip = (boostActive || steerDir !== 0) ? 0.98 : 0.94;
    this.vx = Phaser.Math.Linear(this.vx, targetVx, grip);
    this.vy = Phaser.Math.Linear(this.vy, targetVy, grip);

    // Smoke on lateral slide
    const lateralSlip = Math.abs(this.vx - targetVx) + Math.abs(this.vy - targetVy);
    if (lateralSlip > 45 && Math.abs(this.currentSpeed) > 120 && steerDir !== 0) {
      this.smokeEmitter.emitting = true;
    } else if (!boostActive || !gasOn) {
      this.smokeEmitter.emitting = false;
    }

    this.player.setVelocity(this.vx, this.vy);
    updateEnginePitch(Math.abs(this.currentSpeed) / this.carData.topSpeed);

    // Checkpoints
    this.checkCheckpoints();
  }

  handleTrackLimitsViolation() {
    this.trackLimitsCount++;
    if (this.trackLimitsCount === 1) {
      this.showStewardsNotification('STEWARDS: TRACK LIMITS WARNING 1/3');
    } else if (this.trackLimitsCount === 2) {
      this.showStewardsNotification('STEWARDS: BLACK & WHITE FLAG - FINAL WARNING');
    } else {
      this.penaltyMs += 5000; // +5.0s penalty
      this.showStewardsNotification('STEWARDS: +5.0s TIME PENALTY (TRACK LIMITS)');
    }
  }

  checkCheckpoints() {
    const cps = this.trackData.checkpoints;
    const targetCP = cps[this.nextCheckpointIndex];
    if (!targetCP) return;

    if (checkCheckpointProximity(this.player.x, this.player.y, targetCP, this.roadWidth)) {
      playCheckpointSound();
      this.showNotification('CHECKPOINT ' + targetCP.id);
      this.totalCheckpointsHit++;
      this.nextCheckpointIndex = (this.nextCheckpointIndex + 1) % cps.length;

      if (this.nextCheckpointIndex === 1) {
        const lapTime = this.time.now - this.lapStartTime;
        this.lapTimes.push(lapTime);
        this.lapStartTime = this.time.now;

        if (this.currentLap < this.totalLaps) {
          this.currentLap++;
          this.showNotification('LAP ' + this.currentLap + ' / ' + this.totalLaps);
        } else {
          this.finishRace();
        }
      }
    }
  }

  finishRace() {
    this.raceFinished = true;
    this.player.setVelocity(0, 0);
    stopEngineSound();
    playFinishSound();

    // The race is over: release keyboard capture so the driver-name text input
    // can receive characters that double as in-game controls (W/A/S/D/Space/etc).
    if (this.input && this.input.keyboard) {
      this.input.keyboard.enabled = false;
      this.input.keyboard.clearCaptures();
    }

    const bestLapMs = this.lapTimes.length > 0 ? Math.min(...this.lapTimes) : this.elapsedMs;
    const finalTime = this.elapsedMs + this.penaltyMs;

    window.dispatchEvent(new CustomEvent('pixel-prix:finish', {
      detail: {
        rawTimeMs: this.elapsedMs,
        penaltyMs: this.penaltyMs,
        totalTimeMs: finalTime,
        bestLapMs: bestLapMs,
        carId: this.carData.id,
        trackId: this.trackData.id
      }
    }));
  }

  showNotification(msg) {
    const el = document.getElementById('hud-notification');
    if (!el) return;
    el.innerText = msg;
    el.classList.remove('hidden', 'stewards-warning');
    clearTimeout(this._notifTimeout);
    this._notifTimeout = setTimeout(() => el.classList.add('hidden'), 1500);
  }

  showStewardsNotification(msg) {
    const el = document.getElementById('hud-notification');
    if (!el) return;
    el.innerText = msg;
    el.classList.remove('hidden');
    el.classList.add('stewards-warning');
    clearTimeout(this._notifTimeout);
    this._notifTimeout = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  emitHUDUpdate() {
    window.dispatchEvent(new CustomEvent('pixel-prix:hud', {
      detail: {
        speed: Math.round(Math.abs(this.currentSpeed) * 0.8),
        isReverse: this.currentSpeed < -5,
        lap: this.currentLap,
        totalLaps: this.totalLaps,
        timeMs: this.elapsedMs,
        penaltyMs: this.penaltyMs,
        boostEnergy: this.boostEnergy
      }
    }));
  }

  // Touch control setters (called from main.js)
  setAccelerate(v) { this.isAccelerating = v; }
  setSteerLeft(v) { this.isSteeringLeft = v; }
  setSteerRight(v) { this.isSteeringRight = v; }
  setBrake(v) { this.isBraking = v; }
  setBoost(v) { this.isBoosting = v; }

  cleanup() {
    stopEngineSound();
    clearTimeout(this._notifTimeout);
    this.scale.off('resize', this.frameCamera, this);
    if (this._preventScrollHandler) {
      window.removeEventListener('keydown', this._preventScrollHandler);
      this._preventScrollHandler = null;
    }
    if (this._kbHandler) {
      window.removeEventListener('keydown', this._kbHandler);
      window.removeEventListener('keyup', this._kbHandler);
      this._kbHandler = null;
    }
  }
}
