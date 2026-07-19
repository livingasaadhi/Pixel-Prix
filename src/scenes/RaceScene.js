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
    this.turnRate = 3.2;            // max rotation per second toward target heading

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

    // Lateral drift physics
    this.vx = 0;
    this.vy = 0;

    // Cleanup refs
    this._notifTimeout = null;
    this._preventScrollHandler = null;
    this._kbHandler = null;
  }

  create() {
    // Re-enable keyboard driving
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

    // Robust keyboard fallback
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
  }

  centerCameraOnPlayer() {
    if (!this.player || !this.cameras.main) return;
    const cam = this.cameras.main;
    cam.rotation = 0;
    cam.centerOn(this.player.x, this.player.y);
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
    const dt = delta / 1000;
    const cam = this.cameras.main;

    this.centerCameraOnPlayer();

    if (!this.raceStarted || this.raceFinished) return;

    this.elapsedMs = this.time.now - this.startTime;
    this.emitHUDUpdate();

    this.prevSpeed = this.currentSpeed;

    const speedRatio = Math.min(1.0, Math.abs(this.currentSpeed) / (this.maxSpeed || 275));
    const targetZoom = (this.baseZoom || 0.7) * (1.0 - speedRatio * 0.10);
    cam.zoom = Phaser.Math.Linear(cam.zoom, targetZoom, 2.5 * dt);

    this.updateSpeedVignette(speedRatio);

    // Steering
    let steerDir = 0;
    if (this.isSteeringLeft || this.cursors.left.isDown || this.wasd.left.isDown || this._kb.left) steerDir -= 1;
    if (this.isSteeringRight || this.cursors.right.isDown || this.wasd.right.isDown || this._kb.right) steerDir += 1;

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
      this._kb.space || this._kb.shift || this._kb.z || this._kb.c;

    const boostJustPressed = boostButtonPressed && !this.boostWasPressed;
    this.boostWasPressed = boostButtonPressed;

    if (boostJustPressed && !this.boostActive && this.boostEnergy >= 30) {
      this.boostActive = true;
      this.cameras.main.flash(200, 0, 210, 255, false); // Cyan flash
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

    let brakeValue = 0;
    if (this.isBraking || this.cursors.down.isDown || this.wasd.down.isDown || this._kb.down) {
      brakeValue = 1.0;
    } else if (this.touchBrake > 0) {
      brakeValue = this.touchBrake;
    }

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

    this.onGrass = isOffRoad(this.player.x, this.player.y, this.curvePoints, this.roadWidth);

    if (this.onGrass && Math.abs(this.currentSpeed) > 60) {
      this.offRoadDurationMs += delta;

      if (this.offRoadDurationMs > 1500) {
        this.handleTrackLimitsViolation();
        this.offRoadDurationMs = 0;
      }

      if (Math.abs(this.currentSpeed) > 125 * 2.4 && !this.advantageAlertActive) {
        this.advantageAlertActive = true;
        this.advantageTimerMs = 3000;
        this.showStewardsNotification('STEWARDS: SLOW DOWN BELOW 100 KM/H TO YIELD ADVANTAGE!');
      }
    } else {
      this.offRoadDurationMs = Math.max(0, this.offRoadDurationMs - delta * 2);
    }

    if (this.advantageAlertActive) {
      if (Math.abs(this.currentSpeed) / 2.4 < 100) {
        this.advantageAlertActive = false;
        this.advantageTimerMs = 0;
        this.showStewardsNotification('STEWARDS: ADVANTAGE YIELDED - WARNING CLEARED');
      } else {
        this.advantageTimerMs -= delta;
        if (this.advantageTimerMs <= 0) {
          this.penaltyMs += 10000;
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
        this.cameras.main.flash(150, 255, 77, 109, false); // Red warning flash
        window.dispatchEvent(new CustomEvent('pixel-prix:boost-state', { detail: { active: false } }));
      }
    } else {
      this.boostEnergy = Math.min(100, this.boostEnergy + 12 * dt);
      this.boostEmitter.emitting = false;
    }

    if (this.smokeEmitter.emitting) {
      const offsetDist = -14;
      const rx = this.player.x + Math.cos(this.player.rotation) * offsetDist;
      const ry = this.player.y + Math.sin(this.player.rotation) * offsetDist;
      this.smokeEmitter.setPosition(rx, ry);
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
        if (this.currentSpeed < targetMaxSpeed) this.currentSpeed = targetMaxSpeed;
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
    const grip = (boostActive || steerDir !== 0) ? 0.98 : 0.94;
    this.vx = Phaser.Math.Linear(this.vx, targetVx, grip);
    this.vy = Phaser.Math.Linear(this.vy, targetVy, grip);

    // Smoke and sparks on lateral slide
    const lateralSlip = Math.abs(this.vx - targetVx) + Math.abs(this.vy - targetVy);
    const hardBraking = brakeOn && Math.abs(this.currentSpeed) > 100 * 2.4;
    if (lateralSlip > 45 && Math.abs(this.currentSpeed) > 120 * 2.4 && steerDir !== 0) {
      this.smokeEmitter.emitting = true;
      if (Math.random() < 0.15) {
        this.sparkEmitter.emitting = true;
        setTimeout(() => { if (this.sparkEmitter) this.sparkEmitter.emitting = false; }, 80);
      }
    } else if (!boostActive) {
      this.smokeEmitter.emitting = false;
    }

    if (hardBraking && Math.abs(this.currentSpeed) > 120 * 2.4) {
      if (Math.random() < 0.2) {
        this.sparkEmitter.emitting = true;
        setTimeout(() => { if (this.sparkEmitter) this.sparkEmitter.emitting = false; }, 60);
      }
    }

    const speedLoss = this.prevSpeed - this.currentSpeed;
    if (speedLoss > 60 * 2.4 && Math.abs(this.currentSpeed) < 20 * 2.4) {
      this.cameras.main.shake(250, 0.008);
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
      this.penaltyMs += 5000;
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

    if (this.input && this.input.keyboard) {
      this.input.keyboard.enabled = false;
      this.input.keyboard.clearCaptures();
    }

    this.boostActive = false;
    if (this.smokeEmitter) this.smokeEmitter.emitting = false;
    if (this.boostEmitter) this.boostEmitter.emitting = false;
    window.dispatchEvent(new CustomEvent('pixel-prix:boost-state', { detail: { active: false } }));

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
        speed: Math.round(Math.abs(this.currentSpeed) / 2.4),
        isReverse: this.currentSpeed < -12,
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
    clearTimeout(this._notifTimeout);
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
        transition: 'opacity 0.3s ease',
        background:
          'radial-gradient(ellipse at center, transparent 40%, rgba(232,0,45,0.04) 70%, rgba(10,8,20,0.55) 100%)',
      });
      document.body.appendChild(el);
    }
    el.style.opacity = Math.max(0, ratio - 0.3) * 1.4;
  }
}
