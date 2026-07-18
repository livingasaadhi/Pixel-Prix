import Phaser from 'phaser';
import { getCarById } from '../data/cars.js';
import { getTrackById } from '../data/tracks.js';
import { renderTrackGraphics } from '../utils/trackRenderer.js';
import { isOffRoad, checkCheckpointProximity } from '../utils/trackPhysics.js';
import { startEngineSound, updateEnginePitch, stopEngineSound, setEngineActive, playBoostSound, playCheckpointSound, playFinishSound } from '../utils/audio.js';

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

    // Tunable physics parameters
    this.maxSpeed = this.carData.maxSpeed || this.carData.topSpeed || 275;
    this.boostMaxSpeed = this.carData.boostMaxSpeed || (this.maxSpeed * (this.carData.boostPower || 1.45));
    this.acceleration = this.carData.acceleration || 180;
    this.boostAcceleration = this.carData.boostAcceleration || 380;
    this.brakeForce = this.carData.brakeForce || 450;
    this.drag = this.carData.drag || 25.0;
    this.steeringSensitivity = this.carData.steeringSensitivity || this.carData.handling || 4.4;
    this.highSpeedSteeringMultiplier = this.carData.highSpeedSteeringMultiplier || 0.48;

    // Lateral drift physics
    this.vx = 0;
    this.vy = 0;

    // Cleanup refs
    this._notifTimeout = null;
    this._preventScrollHandler = null;
    this._kbHandler = null;
  }

  create() {
    // Re-enable keyboard driving: finishRace() disables the per-scene
    // KeyboardPlugin so the name-input field can receive keys. That disabled
    // state can survive scene.stop -> scene.start, so restore it here BEFORE
    // re-creating cursor/key objects.
    if (this.input && this.input.keyboard) this.input.keyboard.enabled = true;

    // Guard against any control 'active' state leaking across races.
    this.isAccelerating = this.isBraking = this.isBoosting = false;
    this.isSteeringLeft = this.isSteeringRight = false;

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
    this.cameras.main.startFollow(this.player, true, 0.18, 0.18);
    this.frameCamera();
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

  // Frame the camera around the track's real footprint with player-locked
  // vertical offset and HUD viewport isolation.
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

    // Dynamically measure reserved bottom UI height (touch controls & KERS bar)
    let bottomControlsHeight = 0;
    const driveGroup = document.getElementById('hud-drive-right-group');
    const steerGroup = document.getElementById('hud-steer-left-group');
    if (driveGroup && driveGroup.getBoundingClientRect().height > 0) {
      bottomControlsHeight = driveGroup.getBoundingClientRect().height + 24;
    } else if (steerGroup && steerGroup.getBoundingClientRect().height > 0) {
      bottomControlsHeight = steerGroup.getBoundingClientRect().height + 24;
    } else {
      bottomControlsHeight = 180;
    }

    // Physically isolate gameplay rendering to the viewport area ABOVE controls
    const gameplayHeight = Math.max(200, vh - bottomControlsHeight);
    cam.setViewport(0, 0, vw, gameplayHeight);

    // Zoom level calculation for optimal track visibility
    const cover = Math.max(vw / trackW, gameplayHeight / trackH);
    const zoom = Math.max(0.55, Math.min(cover, 0.85));
    cam.setZoom(zoom);

    // Lock car visually at 62% from top of gameplay viewport (giving maximum track visibility ahead)
    const targetCarScreenY = gameplayHeight * 0.62;
    const centerScreenY = gameplayHeight * 0.50;
    const screenOffsetY = targetCarScreenY - centerScreenY;
    const worldOffsetY = screenOffsetY / zoom;

    // Fluid player-locked tracking with track rotation
    cam.removeBounds();
    cam.setFollowOffset(0, worldOffsetY);
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

    // Smooth camera rotation so the world rotates around the player
    // and forward driving is always oriented towards the top of the screen
    const targetRotation = this.player.rotation + Math.PI / 2;
    this.cameras.main.rotation = Phaser.Math.Angle.RotateTo(
      this.cameras.main.rotation,
      targetRotation,
      4.5 * dt
    );

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

    setEngineActive(gasOn || boostActive);

    // Realistic speed-dependent steering:
    // - Steering works while coasting (currentSpeed > 1)
    // - Responsive at low speeds, stable/dampened at high speeds
    const speedRatio = Math.min(1.0, Math.abs(this.currentSpeed) / this.maxSpeed);
    const speedDamping = Math.max(this.highSpeedSteeringMultiplier, 1.0 - speedRatio * 0.55);
    const boostBonus = boostActive ? 1.15 : 1.0;
    if (Math.abs(this.currentSpeed) > 1.0) {
      this.player.rotation += steerDir * this.steeringSensitivity * speedDamping * boostBonus * dt;
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

    // Speed physics with momentum
    let targetMaxSpeed = boostActive ? this.boostMaxSpeed : this.maxSpeed;
    let currentAccel = boostActive ? this.boostAcceleration : this.acceleration;

    if (boostActive) {
      this.boostEnergy = Math.max(0, this.boostEnergy - 35 * dt);
      this.smokeEmitter.emitting = true;
      if (Math.random() < 0.1) playBoostSound();
    } else {
      this.boostEnergy = Math.min(100, this.boostEnergy + 12 * dt);
    }

    if (this.onGrass) {
      targetMaxSpeed *= 0.55;
      currentAccel *= 0.6;
    }

    if (gasOn) {
      if (this.currentSpeed < 0) {
        this.currentSpeed += this.brakeForce * dt;
        if (this.currentSpeed > 0) this.currentSpeed = 0;
      } else if (this.currentSpeed < targetMaxSpeed) {
        const ratio = Math.max(0, this.currentSpeed / targetMaxSpeed);
        const launchAccel = currentAccel * (1.75 - 0.95 * Math.pow(ratio, 1.3));
        this.currentSpeed += launchAccel * dt;
        if (this.currentSpeed > targetMaxSpeed) {
          this.currentSpeed = targetMaxSpeed;
        }
      } else if (this.currentSpeed > targetMaxSpeed) {
        // Exiting boost or going onto grass: coast down smoothly to targetMaxSpeed via drag
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
        this.currentSpeed -= this.brakeForce * dt;
        if (this.currentSpeed < 0) this.currentSpeed = 0;
      } else {
        if (this.currentSpeed > -85) {
          this.currentSpeed -= this.acceleration * 0.8 * dt;
        }
      }
    } else {
      // Natural momentum coasting under rolling drag
      const currentDrag = this.onGrass ? (this.drag * 3.5) : this.drag;
      if (this.currentSpeed > targetMaxSpeed) {
        this.currentSpeed -= currentDrag * dt;
        if (this.currentSpeed < targetMaxSpeed) this.currentSpeed = targetMaxSpeed;
      } else if (this.currentSpeed > 0) {
        this.currentSpeed -= currentDrag * dt;
        if (this.currentSpeed < 0) this.currentSpeed = 0;
      } else if (this.currentSpeed < 0) {
        this.currentSpeed += currentDrag * dt;
        if (this.currentSpeed > 0) this.currentSpeed = 0;
      }
    }

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
    updateEnginePitch(Math.abs(this.currentSpeed) / this.maxSpeed);

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
