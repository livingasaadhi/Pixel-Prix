import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { RaceScene } from './scenes/RaceScene.js';
import { CARS } from './data/cars.js';
import { TRACKS } from './data/tracks.js';
import { drawTrackMinimap } from './utils/trackRenderer.js';
import { submitScore, fetchTopScores, subscribeToScores } from './supabase.js';

// Global App State
let selectedCarIndex = 0;
let selectedTrackIndex = 0;
let lastRaceResult = null;
let phaserGame = null;
let leaderboardUnsubscribe = null;
let leaderboardTrackId = null;
let ambientAnimId = null;      // requestAnimationFrame for menu particles
let countdownLightsTimer = null; // F1 countdown lights timeout chain

// Helper to convert milliseconds to MM:SS.mmm format
function formatTime(ms) {
  if (typeof ms !== 'number' || isNaN(ms)) return '00:00.000';
  const totalSec = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  const millis = Math.floor(ms % 1000);

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');

  return `${mm}:${ss}.${mmm}`;
}

// UI Screen Navigation
function showScreen(screenId) {
  // While the username dialog is open, never let anything navigate away from
  // the race-complete screen. Only an explicit user action (which clears
  // scoreDialogOpen first) is allowed to move off it.
  if (scoreDialogOpen && screenId !== 'screen-gameover') {
    return;
  }

  const screens = document.querySelectorAll('.ui-screen');
  screens.forEach(s => s.classList.add('hidden'));

  const target = document.getElementById(screenId);
  if (target) {
    target.classList.remove('hidden');
  }

  // Synchronize active states of bottom tabs and top desktop nav links
  updateNavTabStates(screenId);

  // Nav chrome hidden during active race (HUD or Pause)
  const isRaceActive = screenId === 'screen-hud' || screenId === 'screen-pause';
  if (!isRaceActive) {
    setRaceMode(false);
    // Clear KERS boost styles
    document.getElementById('btn-touch-boost')?.classList.remove('engaged');
    document.getElementById('hud-boost-fill')?.classList.remove('active-boost');
  }
}

function updateNavTabStates(screenId) {
  let activeTab = 'garage';
  if (screenId === 'screen-menu') activeTab = 'garage';
  else if (screenId === 'screen-select') activeTab = 'race';
  else if (screenId === 'screen-leaderboard') activeTab = 'leaderboard';

  const bottomTabs = {
    garage: document.getElementById('nav-tab-garage'),
    race: document.getElementById('nav-tab-race'),
    leaderboard: document.getElementById('nav-tab-leaderboard')
  };
  Object.entries(bottomTabs).forEach(([key, el]) => {
    if (el) el.classList.toggle('active', key === activeTab);
  });
}

function setRaceMode(enabled) {
  document.documentElement.classList.toggle('race-mode', enabled);

  // Hide / show persistent nav chrome during a race session
  const topBar = document.getElementById('top-app-bar');
  const bottomNav = document.getElementById('bottom-nav');
  if (topBar) topBar.style.display = enabled ? 'none' : '';
  if (bottomNav) bottomNav.style.display = enabled ? 'none' : '';

  // Orientation locking is supported by installed/PWA-capable browsers. The
  // layout remains fully usable when a browser declines the request.
  if (screen.orientation?.lock) {
    if (enabled) {
      screen.orientation.lock('landscape').catch(() => { });
    } else {
      screen.orientation.unlock?.();
    }
  }
}

// ----------------------------------------------------------------------------
// INITIALIZE PHASER GAME ENGINE
// ----------------------------------------------------------------------------
function initGame() {
  const config = {
    type: Phaser.AUTO,
    parent: 'game-container',
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: '#050505',
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH
    },
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { y: 0 },
        debug: false
      }
    },
    scene: [BootScene, RaceScene]
  };

  phaserGame = new Phaser.Game(config);

  // Real mobile browsers (e.g. Chrome on Android) shrink the visible area when
  // the address bar shows/hides. Keep Phaser's canvas in sync with the visual
  // viewport so the HUD and track stay aligned on real devices (DevTools
  // emulation does not reproduce this).
  const syncVisualViewport = () => phaserGame && phaserGame.scale && phaserGame.scale.refresh();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncVisualViewport);
    window.visualViewport.addEventListener('scroll', syncVisualViewport);
  }
  window.addEventListener('resize', syncVisualViewport);
}

// ----------------------------------------------------------------------------
// CAR & TRACK SELECTION CAROUSELS
// ----------------------------------------------------------------------------

/**
 * Draws the AAA-quality car preview for the selection screen.
 * Uses the same 2x-resolution offscreen canvas approach as BootScene,
 * with a per-car body color glow and matching livery.
 */
function drawCarPreview(canvas, color, accentColor) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Work at 2x scale (canvas is 192×112, logical 96×56)
  ctx.save();
  ctx.scale(2, 2);
  ctx.translate(24, 14); // Center the 48x28 car perfectly in the 96x56 space
  // Logical dimensions: 96×56

  const roundRect = (c, x, y, width, height, radius) => {
    c.beginPath();
    c.moveTo(x + radius, y);
    c.lineTo(x + width - radius, y);
    c.quadraticCurveTo(x + width, y, x + width, y + radius);
    c.lineTo(x + width, y + height - radius);
    c.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    c.lineTo(x + radius, y + height);
    c.quadraticCurveTo(x, y + height, x, y + height - radius);
    c.lineTo(x, y + radius);
    c.quadraticCurveTo(x, y, x + radius, y);
    c.closePath();
    c.fill();
  };

  // 1. Rear tires
  ctx.fillStyle = '#0d0c10';
  roundRect(ctx, 32, 0, 10, 6, 1.5);
  roundRect(ctx, 32, 22, 10, 6, 1.5);
  ctx.fillStyle = '#c8c4d4';
  roundRect(ctx, 35, 1, 5, 4, 0.5);
  roundRect(ctx, 35, 23, 5, 4, 0.5);
  ctx.fillStyle = '#ff6b00';
  ctx.fillRect(33, 2, 1.5, 2);
  ctx.fillRect(33, 24, 1.5, 2);

  // 2. Rear suspension arms
  ctx.strokeStyle = '#5a5875';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(36, 4); ctx.lineTo(34, 9);
  ctx.moveTo(36, 24); ctx.lineTo(34, 19);
  ctx.stroke();

  // 3. Front tires
  ctx.fillStyle = '#0d0c10';
  roundRect(ctx, 8, 2, 9, 5, 1.5);
  roundRect(ctx, 8, 21, 9, 5, 1.5);
  ctx.fillStyle = '#c8c4d4';
  ctx.fillRect(11, 3, 4, 3);
  ctx.fillRect(11, 22, 4, 3);
  ctx.fillStyle = '#ff6b00';
  ctx.fillRect(8, 3, 1.5, 3);
  ctx.fillRect(8, 22, 1.5, 3);

  // 4. Front suspension arms
  ctx.strokeStyle = '#5a5875';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(12, 4); ctx.lineTo(18, 9);
  ctx.moveTo(12, 24); ctx.lineTo(18, 19);
  ctx.stroke();

  // 5. Front wing
  ctx.fillStyle = '#e8e8f0';
  ctx.fillRect(3, 1, 3, 26);
  ctx.fillStyle = color;
  ctx.fillRect(4, 3, 2, 22);
  ctx.fillStyle = '#1e1c28';
  ctx.fillRect(1, 1, 4, 2);
  ctx.fillRect(1, 25, 4, 2);
  ctx.fillStyle = accentColor;
  ctx.fillRect(2, 2, 1, 2);
  ctx.fillRect(2, 24, 1, 2);

  // 6. Nose cone
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(5, 14);
  ctx.lineTo(20, 8);
  ctx.lineTo(20, 20);
  ctx.closePath();
  ctx.fill();

  // 7. Chassis
  ctx.fillStyle = color;
  roundRect(ctx, 18, 8, 20, 12, 3);
  // Sidepod vents
  ctx.fillStyle = '#0d0c10';
  roundRect(ctx, 20, 8, 6, 3, 1);
  roundRect(ctx, 20, 17, 6, 3, 1);
  // Gloss highlight
  const gloss = ctx.createLinearGradient(18, 8, 18, 20);
  gloss.addColorStop(0, 'rgba(255,255,255,0.18)');
  gloss.addColorStop(0.4, 'rgba(255,255,255,0.04)');
  gloss.addColorStop(1, 'rgba(0,0,0,0.1)');
  ctx.fillStyle = gloss;
  roundRect(ctx, 18, 8, 20, 12, 3);

  // 8. Cockpit & helmet
  ctx.fillStyle = '#0a0810';
  ctx.beginPath();
  ctx.arc(26, 14, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.arc(25, 14, 3.2, 0, Math.PI * 2);
  ctx.fill();
  // Visor shine
  const visorGloss = ctx.createLinearGradient(22, 11, 26, 14);
  visorGloss.addColorStop(0, 'rgba(255,255,255,0.35)');
  visorGloss.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = visorGloss;
  ctx.beginPath();
  ctx.arc(24, 12, 2.5, 0, Math.PI * 2);
  ctx.fill();

  // Halo
  ctx.strokeStyle = '#8a8898';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(26, 14, 4.8, Math.PI * 0.8, Math.PI * 2.2);
  ctx.stroke();

  // 9. Spine
  ctx.fillStyle = accentColor;
  ctx.fillRect(29, 12.5, 8, 3);
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.fillRect(29, 12.5, 8, 1);

  // 10. Rear wing
  ctx.fillStyle = '#0d0c10';
  ctx.fillRect(38, 4, 5, 20);
  ctx.fillStyle = color;
  ctx.fillRect(36, 3, 8, 3);
  ctx.fillRect(36, 22, 8, 3);
  ctx.fillStyle = accentColor;
  ctx.fillRect(40, 4, 2, 2);
  ctx.fillRect(40, 22, 2, 2);

  // 11. Safety light
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(42, 12, 2, 2);

  ctx.restore();
}

function updateCarSelection() {
  const car = CARS[selectedCarIndex];

  const content = document.querySelector('.car-select-card .carousel-content');
  if (content) {
    content.classList.remove('carousel-slide');
    void content.offsetWidth; // trigger reflow
    content.classList.add('carousel-slide');
  }

  document.getElementById('car-name').innerText = car.name;
  document.getElementById('car-desc').innerText = car.description;

  // Update dots
  const dots = document.querySelectorAll('#car-selection-dots .dot');
  dots.forEach((dot, idx) => {
    if (idx === selectedCarIndex) dot.classList.add('active');
    else dot.classList.remove('active');
  });

  const previewCanvas = document.getElementById('car-preview-canvas');
  drawCarPreview(previewCanvas, car.color, car.accentColor);

  document.getElementById('stat-speed').style.width = `${Math.min(100, (car.topSpeed / 340) * 100)}%`;
  document.getElementById('stat-accel').style.width = `${Math.min(100, (car.acceleration / 180) * 100)}%`;
  document.getElementById('stat-handling').style.width = `${Math.min(100, (car.handling / 5.2) * 100)}%`;
  document.getElementById('stat-boost').style.width = `${Math.min(100, (car.boostPower / 1.7) * 100)}%`;

  const speedVal = document.getElementById('stat-speed-val');
  if (speedVal) speedVal.innerText = `${car.topSpeed} KM/H`;

  const accelVal = document.getElementById('stat-accel-val');
  if (accelVal) accelVal.innerText = `0-100: ${(350 / car.acceleration).toFixed(1)}S`;

  const handlingVal = document.getElementById('stat-handling-val');
  if (handlingVal) handlingVal.innerText = `GRIP ${(car.handling / 4).toFixed(2)}G`;

  const boostVal = document.getElementById('stat-boost-val');
  if (boostVal) boostVal.innerText = `ERS ${Math.round(car.boostPower * 100)}KW`;
}

function updateTrackSelection() {
  const track = TRACKS[selectedTrackIndex];

  const content = document.querySelector('.track-select-card .track-content');
  if (content) {
    content.classList.remove('carousel-slide');
    void content.offsetWidth; // trigger reflow
    content.classList.add('carousel-slide');
  }

  document.getElementById('track-name').innerText = track.name;
  document.getElementById('track-desc').innerText = track.description;

  // Update dots
  const dots = document.querySelectorAll('#track-selection-dots .dot');
  dots.forEach((dot, idx) => {
    if (idx === selectedTrackIndex) dot.classList.add('active');
    else dot.classList.remove('active');
  });

  // Set difficulty with color coding
  const diffEl = document.getElementById('track-difficulty');
  diffEl.innerText = track.difficulty;
  diffEl.dataset.level = track.difficulty;

  document.getElementById('track-laps').innerText = `${track.laps} LAPS`;

  const lengthEl = document.getElementById('track-length');
  if (lengthEl) lengthEl.innerText = track.length || "1.2 KM";

  const canvas = document.getElementById('track-minimap');
  drawTrackMinimap(canvas, track);
}

function launchSelectedRace() {
  setRaceMode(true);
  showScreen('screen-hud');
  // Trigger F1 lights-out animation
  playCountdownLights();

  if (phaserGame) {
    phaserGame.scale.refresh();

    const selectedCarId = CARS[selectedCarIndex].id;
    const selectedTrackId = TRACKS[selectedTrackIndex].id;

    if (phaserGame.scene.isActive('RaceScene')) {
      phaserGame.scene.stop('RaceScene');
    }

    phaserGame.scene.start('RaceScene', {
      carId: selectedCarId,
      trackId: selectedTrackId
    });
  }
}

// ----------------------------------------------------------------------------
// TOUCH CONTROLS BINDINGS (HUD)
// ----------------------------------------------------------------------------
function setupTouchControls() {
  const raceScene = () => phaserGame?.scene?.getScene('RaceScene');

  const bindButton = (id, onStart, onEnd) => {
    const btn = document.getElementById(id);
    if (!btn) return;

    const start = (e) => {
      e.preventDefault();
      btn.classList.add('active');
      const sc = raceScene();
      if (sc) onStart(sc);
    };

    const end = (e) => {
      e.preventDefault();
      btn.classList.remove('active');
      const sc = raceScene();
      if (sc) onEnd(sc);
    };

    btn.addEventListener('touchstart', start, { passive: false });
    btn.addEventListener('touchend', end, { passive: false });
    btn.addEventListener('touchcancel', end, { passive: false });

    btn.addEventListener('mousedown', start);
    btn.addEventListener('mouseup', end);
    btn.addEventListener('mouseleave', end);
  };

  bindButton('btn-touch-accel', s => s.setAccelerate(true), s => s.setAccelerate(false));
  bindButton('btn-touch-left', s => s.setSteerLeft(true), s => s.setSteerLeft(false));
  bindButton('btn-touch-right', s => s.setSteerRight(true), s => s.setSteerRight(false));
  bindButton('btn-touch-brake', s => s.setBrake(true), s => s.setBrake(false));
  bindButton('btn-touch-boost', s => s.setBoost(true), s => s.setBoost(false));
  bindButton('btn-touch-boost-left', s => s.setBoost(true), s => s.setBoost(false));

  // Joystick control for mobile / touch devices (Steering)
  const joystickBaseEl = document.getElementById('hud-joystick-base');
  const joystickHandleEl = document.getElementById('hud-joystick-handle');

  if (joystickBaseEl && joystickHandleEl) {
    let isDraggingJoystick = false;
    let recenterInterval = null;
    let joystickTouchId = null; // multi-touch: track specific touch identifier
    let joystickTouchActive = false; // guard against synthesized mouse events
    const deadzone = 0.08; // 8% center deadzone

    const getJoystickTouch = (e) => {
      if (!e.touches) return null;
      if (joystickTouchId !== null) {
        return Array.from(e.touches).find(t => t.identifier === joystickTouchId) || null;
      }
      return null;
    };

    const updateJoystick = (clientX, clientY) => {
      const rect = joystickBaseEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const maxRadius = rect.width / 2;
      const limit = maxRadius * 0.7; // Limit handle to 70% of base radius

      let dx = clientX - cx;
      let dy = clientY - cy;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance > limit) {
        dx = (dx / distance) * limit;
        dy = (dy / distance) * limit;
      }

      joystickHandleEl.style.transform = `translate(${dx}px, ${dy}px)`;

      // Compute absolute heading angle from joystick direction (screen-space)
      const sc = raceScene();
      if (distance > deadzone * limit) {
        const angle = Math.atan2(dy, dx);
        if (sc) sc.setJoystickHeading(angle, true);
      } else {
        if (sc) sc.setJoystickHeading(0, false);
      }
    };

    const startDrag = (e) => {
      // Guard: ignore synthesized mouse events that follow touch events
      if (e.type === 'mousedown' && joystickTouchActive) return;
      e.preventDefault();
      isDraggingJoystick = true;
      if (recenterInterval) {
        cancelAnimationFrame(recenterInterval);
        recenterInterval = null;
      }
      // Store the touch identifier for multi-touch tracking using changedTouches
      if (e.touches && e.changedTouches && e.changedTouches[0]) {
        joystickTouchId = e.changedTouches[0].identifier;
        joystickTouchActive = true;
      }
      const touch = e.changedTouches ? e.changedTouches[0] : e;
      updateJoystick(touch.clientX, touch.clientY);
    };

    const drag = (e) => {
      if (!isDraggingJoystick) return;
      if (e.cancelable) e.preventDefault();
      let touch;
      if (e.touches && (touch = getJoystickTouch(e))) {
        updateJoystick(touch.clientX, touch.clientY);
      } else if (!e.touches) {
        // Mouse fallback (only for real mouse, not synthesized)
        updateJoystick(e.clientX, e.clientY);
      }
    };

    const endDrag = (e) => {
      // Check if the released touch matches our tracked joystick touch
      if (joystickTouchId !== null && e.changedTouches) {
        const released = Array.from(e.changedTouches).find(t => t.identifier === joystickTouchId);
        if (!released) return; // not our touch
      }
      if (!isDraggingJoystick) return;
      isDraggingJoystick = false;
      joystickTouchId = null;
      joystickTouchActive = false;

      // Immediately clear ALL joystick state in the game scene
      const scImmediate = raceScene();
      if (scImmediate) {
        scImmediate.setJoystickHeading(0, false);
        scImmediate.setSteeringValue(0);
      }

      // Smoothly ease joystick handle back to center (VISUAL ONLY — no game input)
      let rect = joystickBaseEl.getBoundingClientRect();
      let maxRadius = rect.width / 2;
      let limit = maxRadius * 0.7;

      const style = window.getComputedStyle(joystickHandleEl);
      const matrix = new DOMMatrix(style.transform);
      let curDx = matrix.m41;
      let curDy = matrix.m42;

      const step = () => {
        if (isDraggingJoystick) {
          recenterInterval = null;
          return;
        }

        curDx *= 0.8; // Easing decay rate
        curDy *= 0.8;

        if (Math.abs(curDx) < 0.1 && Math.abs(curDy) < 0.1) {
          curDx = 0;
          curDy = 0;
        }

        joystickHandleEl.style.transform = `translate(${curDx}px, ${curDy}px)`;

        if (curDx !== 0 || curDy !== 0) {
          recenterInterval = requestAnimationFrame(step);
        } else {
          recenterInterval = null;
        }
      };

      recenterInterval = requestAnimationFrame(step);
    };

    joystickBaseEl.addEventListener('touchstart', startDrag, { passive: false });
    window.addEventListener('touchmove', drag, { passive: false });
    window.addEventListener('touchend', endDrag);
    window.addEventListener('touchcancel', endDrag);

    joystickBaseEl.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove', drag);
    window.addEventListener('mouseup', endDrag);
  }

  // Combined Pedals Vertical Slider (Accelerator/Brake/Reverse)
  const pedalSliderEl = document.getElementById('hud-pedal-slider');
  const pedalHandleEl = document.getElementById('pedal-slider-handle');

  if (pedalSliderEl && pedalHandleEl) {
    let isDraggingPedal = false;
    let recenterInterval = null;
    let pedalTouchId = null; // multi-touch: track specific touch identifier
    const maxLimit = 55; // Max vertical travel from center in pixels
    const deadzone = 0.08; // 8% center deadzone
    const PROGRESSIVE_EXP = 1.8; // exponent for progressive pedal curve (>1 = progressive near center, aggressive at edge)

    const getPedalTouch = (e) => {
      if (!e.touches) return null;
      if (pedalTouchId !== null) {
        return Array.from(e.touches).find(t => t.identifier === pedalTouchId) || null;
      }
      return null;
    };

    const computePedalValue = (raw) => {
      // Progressive curve: small movements near center give less power,
      // movements toward the edge give exponentially more
      return Math.sign(raw) * Math.pow(Math.abs(raw), PROGRESSIVE_EXP);
    };

    const updateSlider = (clientY) => {
      const rect = pedalSliderEl.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;

      let offsetY = clientY - centerY;
      offsetY = Math.max(-maxLimit, Math.min(maxLimit, offsetY));

      pedalHandleEl.style.transform = `translateY(${offsetY}px)`;

      // Map to normalized input: -1.0 (Brake/Reverse bottom) to 1.0 (Gas top)
      const val = -offsetY / maxLimit;

      let gas = 0;
      let brake = 0;

      if (val > deadzone) {
        let normalized = (val - deadzone) / (1.0 - deadzone);
        gas = computePedalValue(normalized);
      } else if (val < -deadzone) {
        let normalized = (-val - deadzone) / (1.0 - deadzone);
        brake = computePedalValue(normalized);
      }

      const sc = raceScene();
      if (sc) {
        sc.setTouchGas(gas);
        sc.setTouchBrake(brake);
      }
    };

    const startDrag = (e) => {
      // Guard: ignore synthesized mouse events that follow touch events
      if (e.type === 'mousedown' && pedalTouchId !== null) return;
      e.preventDefault();
      isDraggingPedal = true;
      if (recenterInterval) {
        cancelAnimationFrame(recenterInterval);
        recenterInterval = null;
      }
      // Store the touch identifier for multi-touch tracking using changedTouches
      if (e.touches && e.changedTouches && e.changedTouches[0]) {
        pedalTouchId = e.changedTouches[0].identifier;
      }
      const touch = e.changedTouches ? e.changedTouches[0] : e;
      updateSlider(touch.clientY);
    };

    const drag = (e) => {
      if (!isDraggingPedal) return;
      if (e.cancelable) e.preventDefault();
      let touch;
      if (e.touches && (touch = getPedalTouch(e))) {
        updateSlider(touch.clientY);
      } else if (!e.touches) {
        // Mouse fallback (only for real mouse, not synthesized)
        updateSlider(e.clientY);
      }
    };

    const endDrag = (e) => {
      // Check if the released touch matches our tracked pedal touch
      if (pedalTouchId !== null && e.changedTouches) {
        const released = Array.from(e.changedTouches).find(t => t.identifier === pedalTouchId);
        if (!released) return; // not our touch
      }
      if (!isDraggingPedal) return;
      isDraggingPedal = false;
      pedalTouchId = null;

      // Immediately reset ALL pedal state in the game scene
      const scImmediate = raceScene();
      if (scImmediate) {
        scImmediate.setTouchGas(0);
        scImmediate.setTouchBrake(0);
      }

      // Smoothly ease pedal handle back to center (VISUAL ONLY — no game input)
      const style = window.getComputedStyle(pedalHandleEl);
      const matrix = new DOMMatrix(style.transform);
      let curOffsetY = matrix.m42;

      const step = () => {
        if (isDraggingPedal) {
          recenterInterval = null;
          return;
        }

        curOffsetY *= 0.8; // Smooth auto-recenter decay

        if (Math.abs(curOffsetY) < 0.1) {
          curOffsetY = 0;
        }

        pedalHandleEl.style.transform = `translateY(${curOffsetY}px)`;

        if (curOffsetY !== 0) {
          recenterInterval = requestAnimationFrame(step);
        } else {
          recenterInterval = null;
        }
      };

      recenterInterval = requestAnimationFrame(step);
    };

    pedalSliderEl.addEventListener('touchstart', startDrag, { passive: false });
    window.addEventListener('touchmove', drag, { passive: false });
    window.addEventListener('touchend', endDrag);
    window.addEventListener('touchcancel', endDrag);

    pedalSliderEl.addEventListener('mousedown', startDrag);
    window.addEventListener('mousemove', drag);
  }
}

// ----------------------------------------------------------------------------
// LISTEN TO PHASER CUSTOM EVENTS (HUD & RACE FINISH)
// ----------------------------------------------------------------------------
function setupGameEventListeners() {
  window.addEventListener('pixel-prix:hud', (e) => {
    const { speed, isReverse, lap, totalLaps, timeMs, penaltyMs, boostEnergy } = e.detail;

    // Speed: number only (KM/H is the label)
    document.getElementById('hud-speed-text').innerText = `${speed}`;
    // Lap: number + sub-text /N
    document.getElementById('hud-lap-text').innerHTML = `${lap}<span class="hud-chip-sub">/${totalLaps}</span>`;
    document.getElementById('hud-timer-text').innerText = formatTime(timeMs);
    // Warning bar penalty
    const penaltyVal = (penaltyMs / 1000).toFixed(1);
    document.getElementById('hud-penalty-text').innerText = penaltyMs > 0 ? `+${penaltyVal}s PENALTY` : 'STEWARD INVESTIGATION';

    // Update both boost meter fills (desktop and mobile)
    const fillPercent = `${Math.max(0, Math.min(100, boostEnergy))}%`;
    const fillRight = document.getElementById('hud-boost-fill');
    if (fillRight) fillRight.style.width = fillPercent;
    const fillLeft = document.getElementById('hud-boost-fill-left');
    if (fillLeft) fillLeft.style.width = fillPercent;

    // Boost button conditional visibility (mobile only)
    const boostBtnLeft = document.getElementById('btn-touch-boost-left');
    if (boostBtnLeft) {
      const sc = raceScene();
      const isBoostActive = sc ? sc.boostActive : false;
      if (isBoostActive || boostEnergy >= 99.9) {
        boostBtnLeft.classList.add('visible-boost');
      } else {
        boostBtnLeft.classList.remove('visible-boost');
      }
    }
  });

  window.addEventListener('pixel-prix:finish', (e) => {
    lastRaceResult = e.detail;

    document.getElementById('go-raw-time').innerText = formatTime(lastRaceResult.rawTimeMs);
    document.getElementById('go-penalty-time').innerText = `+${(lastRaceResult.penaltyMs / 1000).toFixed(3)}s`;
    document.getElementById('go-final-time').innerText = formatTime(lastRaceResult.totalTimeMs);
    document.getElementById('go-best-lap').innerText = `Best Lap: ${formatTime(lastRaceResult.bestLapMs)}`;

    // Stop the race scene
    if (phaserGame && phaserGame.scene.isActive('RaceScene')) {
      phaserGame.scene.stop('RaceScene');
    }

    // Trigger finish celebration
    fireCelebrationEffect();
    openScoreDialog();
    showScreen('screen-gameover');
  });

  window.addEventListener('pixel-prix:boost-state', (e) => {
    const active = e.detail.active;

    // Desktop boost btn
    const btnRight = document.getElementById('btn-touch-boost');
    if (btnRight) {
      if (active) btnRight.classList.add('engaged');
      else btnRight.classList.remove('engaged');
    }

    // Mobile boost btn
    const btnLeft = document.getElementById('btn-touch-boost-left');
    if (btnLeft) {
      if (active) btnLeft.classList.add('engaged');
      else btnLeft.classList.remove('engaged');
    }

    // Fills
    const fillRight = document.getElementById('hud-boost-fill');
    if (fillRight) {
      if (active) fillRight.classList.add('active-boost');
      else fillRight.classList.remove('active-boost');
    }
    const fillLeft = document.getElementById('hud-boost-fill-left');
    if (fillLeft) {
      if (active) fillLeft.classList.add('active-boost');
      else fillLeft.classList.remove('active-boost');
    }
  });
}

// ----------------------------------------------------------------------------
// PERSISTENT USERNAME DIALOG (post-race leaderboard save)
//
// The dialog MUST stay open until the user explicitly acts:
//   - a successful leaderboard submission, or
//   - an explicit cancel/close (SKIP / MENU / LEADERBOARD / RETRY).
// It is NEVER auto-dismissed by timers, screen transitions, focus changes,
// or game-state updates. While it is open, navigation is paused so nothing
// can dismiss it unexpectedly.
// ----------------------------------------------------------------------------
let scoreDialogOpen = false;

function validateDriverName(raw) {
  const name = String(raw || '').trim();
  if (!name) return { ok: false, error: 'ENTER A DRIVER NAME TO SAVE YOUR TIME.' };
  if (name.length < 3) return { ok: false, error: 'NAME MUST BE AT LEAST 3 CHARACTERS.' };
  if (name.length > 16) return { ok: false, error: 'NAME MUST BE 16 CHARACTERS OR FEWER.' };
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(name)) {
    return { ok: false, error: 'USE LETTERS, NUMBERS, SPACES OR . - _ ONLY.' };
  }
  return { ok: true, name };
}

function setScoreDialogState(state) {
  const form = document.getElementById('score-form');
  const submitBtn = document.getElementById('btn-submit-score');
  const statusMsg = document.getElementById('submit-status');
  const hint = document.getElementById('submit-hint');
  if (!form || !submitBtn) return;

  form.classList.remove('is-loading', 'is-success', 'is-error');
  submitBtn.classList.remove('is-loading');

  if (state === 'loading') {
    form.classList.add('is-loading');
    submitBtn.classList.add('is-loading');
    submitBtn.disabled = true;
    statusMsg.className = 'status-msg';
    statusMsg.innerText = 'POSTING TIME…';
    if (hint) hint.style.display = 'none';
  } else if (state === 'success') {
    form.classList.add('is-success');
    statusMsg.className = 'status-msg success';
    statusMsg.innerText = 'TIME POSTED ✓';
    if (hint) hint.style.display = 'none';
  } else if (state === 'error') {
    // error message is set by caller; just flag styling and re-enable input
    form.classList.add('is-error');
    submitBtn.disabled = false;
    if (hint) hint.style.display = '';
  } else {
    submitBtn.disabled = false;
    if (hint) hint.style.display = '';
  }
}

function openScoreDialog() {
  scoreDialogOpen = true;
  document.documentElement.classList.add('score-dialog-open');

  const form = document.getElementById('score-form');
  const nameInput = document.getElementById('player-name-input');
  const statusMsg = document.getElementById('submit-status');

  if (form) {
    form.reset();
    form.classList.remove('is-loading', 'is-success', 'is-error');
  }
  if (statusMsg) {
    statusMsg.className = 'status-msg';
    statusMsg.innerText = '';
  }
  if (nameInput) nameInput.disabled = false;
  setScoreDialogState('idle');

  // Auto-focus the input so the user can start typing immediately on both
  // desktop and mobile. Use a short delay so focus lands after the screen
  // transition, and retry once if the browser deferred it.
  const focusInput = () => {
    if (!scoreDialogOpen || !nameInput) return;
    try { nameInput.focus({ preventScroll: true }); } catch (_) { nameInput.focus(); }
  };
  setTimeout(focusInput, 60);
  setTimeout(focusInput, 350);
}

function closeScoreDialog() {
  scoreDialogOpen = false;
  document.documentElement.classList.remove('score-dialog-open');
}

function submitScoreFromDialog() {
  if (!scoreDialogOpen) return;

  const nameInput = document.getElementById('player-name-input');
  const statusMsg = document.getElementById('submit-status');
  const submitBtn = document.getElementById('btn-submit-score');

  const check = validateDriverName(nameInput?.value);
  if (!check.ok) {
    setScoreDialogState('error');
    statusMsg.className = 'status-msg error';
    statusMsg.innerText = check.error;
    nameInput?.focus();
    return;
  }

  setScoreDialogState('loading');

  submitScore({
    playerName: check.name,
    carId: lastRaceResult.carId,
    trackId: lastRaceResult.trackId,
    timeMs: lastRaceResult.totalTimeMs
  }).then((result) => {
    // The dialog may have been explicitly closed while the request was in
    // flight; only update UI if it is still open.
    if (!scoreDialogOpen) return;

    if (result.success) {
      setScoreDialogState('success');
      setTimeout(() => {
        if (!scoreDialogOpen) return;
        closeScoreDialog();
        const trackId = lastRaceResult.trackId;
        renderLeaderboardTabs(trackId);
        watchLeaderboard(trackId);
        loadLeaderboard(trackId);
        showScreen('screen-leaderboard');
      }, 1200);
    } else {
      setScoreDialogState('error');
      statusMsg.className = 'status-msg error';
      statusMsg.innerText = (result.error && /unavailable/i.test(result.error))
        ? 'LEADERBOARD UNAVAILABLE — CHECK CONNECTION AND RETRY.'
        : 'UNABLE TO POST TIME — TRY AGAIN.';
      nameInput?.focus();
    }
  }).catch(() => {
    if (!scoreDialogOpen) return;
    setScoreDialogState('error');
    statusMsg.className = 'status-msg error';
    statusMsg.innerText = 'UNABLE TO POST TIME — TRY AGAIN.';
    nameInput?.focus();
  });
}

// ----------------------------------------------------------------------------
// LEADERBOARD SCREEN MANAGEMENT
// ----------------------------------------------------------------------------
async function loadLeaderboard(trackId) {
  const container = document.getElementById('lb-table-body');
  container.innerHTML = '<p class="loading-cell">Loading circuit times...</p>';

  const { scores, error } = await fetchTopScores(trackId);

  if (error) {
    container.innerHTML = '<p class="loading-cell">Unable to load global times. Please try again.</p>';
    return;
  }

  if (!scores || scores.length === 0) {
    container.innerHTML = '<p class="loading-cell">No times recorded for this track yet. Be the first!</p>';
    return;
  }

  container.innerHTML = scores.map((s, idx) => {
    const carName = CARS.find(c => c.id === s.car_id)?.name || s.car_id;
    const dateStr = s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }).replace(/\//g, '.') : 'Today';
    const isFirst = idx === 0;
    const isSecond = idx === 1;
    const isThird = idx === 2;
    const podiumClass = isFirst ? ' lb-row-first' : isSecond ? ' lb-row-second' : isThird ? ' lb-row-third' : '';
    const posStr = `#${String(idx + 1).padStart(2, '0')}`;
    return `
      <div class="lb-row${podiumClass}">
        <div class="lb-row-pos">${posStr}</div>
        <div class="lb-row-pilot">
          <p class="lb-row-name">${escapeHtml(s.player_name)}</p>
          <p class="lb-row-constructor">${escapeHtml(carName)}</p>
        </div>
        <div class="lb-row-time-col">
          <p class="lb-row-time">${formatTime(s.time_ms)}</p>
          <p class="lb-row-date">${dateStr}</p>
        </div>
      </div>
    `;
  }).join('');
}

function watchLeaderboard(trackId) {
  if (leaderboardTrackId === trackId) return;
  leaderboardUnsubscribe?.();
  leaderboardTrackId = trackId;
  leaderboardUnsubscribe = subscribeToScores(trackId, () => loadLeaderboard(trackId));
}

function stopWatchingLeaderboard() {
  leaderboardUnsubscribe?.();
  leaderboardUnsubscribe = null;
  leaderboardTrackId = null;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[m]);
}

function renderLeaderboardTabs(activeTrackId = TRACKS[selectedTrackIndex].id) {
  const container = document.getElementById('lb-track-tabs');
  container.innerHTML = TRACKS.map((t) => `
    <button class="lb-tab-btn ${t.id === activeTrackId ? 'active' : ''}" data-track-id="${t.id}">
      <span class="lb-tab-label">${t.name}</span>
      <span class="lb-tab-line"></span>
    </button>
  `).join('');

  container.querySelectorAll('.lb-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const clickedBtn = e.currentTarget;
      container.querySelectorAll('.lb-tab-btn').forEach(b => b.classList.remove('active'));
      clickedBtn.classList.add('active');
      watchLeaderboard(clickedBtn.dataset.trackId);
      loadLeaderboard(clickedBtn.dataset.trackId);
    });
  });
}

// Helper to robustly handle both touch and click events without delay or drop
function bindClickOrTouch(idOrEl, handler) {
  const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
  if (!el) return;

  let handled = false;
  const trigger = (e) => {
    if (handled) return;
    handled = true;
    setTimeout(() => { handled = false; }, 250);
    handler(e);
  };

  el.addEventListener('click', (e) => {
    trigger(e);
  });

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      trigger(e);
    }
  });
}

// ----------------------------------------------------------------------------
// DOM EVENT LISTENERS ATTACHMENT
// ----------------------------------------------------------------------------
function initUI() {
  // Navigation Buttons
  bindClickOrTouch('btn-start-game', () => {
    updateCarSelection();
    updateTrackSelection();
    showScreen('screen-select');
  });

  const openLeaderboard = () => {
    const trackId = TRACKS[selectedTrackIndex].id;
    renderLeaderboardTabs(trackId);
    watchLeaderboard(trackId);
    loadLeaderboard(trackId);
    showScreen('screen-leaderboard');
  };

  const openSettings = () => showScreen('screen-settings');

  bindClickOrTouch('btn-open-leaderboard', openLeaderboard);

  // Top-right settings icon
  bindClickOrTouch('top-settings-icon', openSettings);

  // Menu screen's "Controls & Info" button
  bindClickOrTouch('btn-open-settings-menu', openSettings);

  // Bottom & Top nav tab wiring
  const openRaceSelect = () => {
    updateCarSelection();
    updateTrackSelection();
    showScreen('screen-select');
  };

  bindClickOrTouch('nav-tab-leaderboard', openLeaderboard);
  bindClickOrTouch('top-nav-leaderboard', openLeaderboard);

  bindClickOrTouch('nav-tab-race', openRaceSelect);
  bindClickOrTouch('top-nav-race', openRaceSelect);

  bindClickOrTouch('nav-tab-garage', () => showScreen('screen-menu'));
  bindClickOrTouch('top-nav-garage', () => showScreen('screen-menu'));

  bindClickOrTouch('nav-tab-profile', openSettings);

  bindClickOrTouch('btn-close-settings', () => {
    showScreen('screen-menu');
  });

  bindClickOrTouch('btn-close-leaderboard', () => {
    stopWatchingLeaderboard();
    showScreen('screen-menu');
  });

  bindClickOrTouch('btn-select-back', () => {
    showScreen('screen-menu');
  });

  // Pause menu
  bindClickOrTouch('btn-touch-pause', () => {
    showScreen('screen-pause');
  });

  bindClickOrTouch('btn-hud-back', () => {
    if (phaserGame && phaserGame.scene.isActive('RaceScene')) {
      phaserGame.scene.stop('RaceScene');
    }
    showScreen('screen-menu');
  });

  bindClickOrTouch('btn-resume-race', () => {
    showScreen('screen-hud');
  });

  bindClickOrTouch('btn-restart-race', () => {
    launchSelectedRace();
  });

  bindClickOrTouch('btn-exit-to-menu', () => {
    if (phaserGame && phaserGame.scene.isActive('RaceScene')) {
      phaserGame.scene.stop('RaceScene');
    }
    showScreen('screen-menu');
  });

  // Carousel Controls
  bindClickOrTouch('car-prev', () => {
    selectedCarIndex = (selectedCarIndex - 1 + CARS.length) % CARS.length;
    updateCarSelection();
  });
  bindClickOrTouch('car-next', () => {
    selectedCarIndex = (selectedCarIndex + 1) % CARS.length;
    updateCarSelection();
  });

  bindClickOrTouch('track-prev', () => {
    selectedTrackIndex = (selectedTrackIndex - 1 + TRACKS.length) % TRACKS.length;
    updateTrackSelection();
  });
  bindClickOrTouch('track-next', () => {
    selectedTrackIndex = (selectedTrackIndex + 1) % TRACKS.length;
    updateTrackSelection();
  });

  bindClickOrTouch('btn-launch-race', () => {
    launchSelectedRace();
  });

  // Game Over Actions
  // These actions are explicit user intents that dismiss the username dialog.
  bindClickOrTouch('btn-retry-race', () => {
    closeScoreDialog();
    launchSelectedRace();
  });

  bindClickOrTouch('btn-view-leaderboard-go', () => {
    closeScoreDialog();
    const trackId = lastRaceResult?.trackId || TRACKS[0].id;
    renderLeaderboardTabs(trackId);
    watchLeaderboard(trackId);
    loadLeaderboard(trackId);
    showScreen('screen-leaderboard');
  });

  bindClickOrTouch('btn-gameover-menu', () => {
    closeScoreDialog();
    if (phaserGame && phaserGame.scene.isActive('RaceScene')) {
      phaserGame.scene.stop('RaceScene');
    }
    showScreen('screen-menu');
  });

  // Explicit cancel/skip: dismiss the dialog without saving.
  bindClickOrTouch('btn-close-score', () => {
    closeScoreDialog();
    const trackId = lastRaceResult?.trackId || TRACKS[0].id;
    renderLeaderboardTabs(trackId);
    watchLeaderboard(trackId);
    loadLeaderboard(trackId);
    showScreen('screen-leaderboard');
  });

  // Score Submit Form
  const scoreForm = document.getElementById('score-form');
  if (scoreForm) {
    scoreForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitScoreFromDialog();
    });

    // Keep focus inside the dialog: pressing Enter submits, Escape cancels.
    const nameInput = document.getElementById('player-name-input');
    if (nameInput) {
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          document.getElementById('btn-close-score')?.click();
        }
      });
    }
  }

  // Leaderboard Refresh
  bindClickOrTouch('btn-refresh-lb', () => {
    const activeTab = document.querySelector('#lb-track-tabs .lb-tab-btn.active');
    const trackId = activeTab ? activeTab.dataset.trackId : TRACKS[0].id;
    loadLeaderboard(trackId);
  });

  setupTouchControls();
  setupGameEventListeners();
}

// ----------------------------------------------------------------------------
// AMBIENT PARTICLE SYSTEM (Main Menu background effect)
// ----------------------------------------------------------------------------
function startAmbientParticles() {
  const canvas = document.getElementById('ambient-canvas');
  if (!canvas) return;

  const resize = () => {
    canvas.width = canvas.offsetWidth || window.innerWidth;
    canvas.height = canvas.offsetHeight || window.innerHeight;
  };
  resize();
  window.addEventListener('resize', resize);

  const ctx = canvas.getContext('2d');
  const particles = [];
  const NUM = 45;

  for (let i = 0; i < NUM; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.35,
      vy: -0.2 - Math.random() * 0.55,
      size: 1 + Math.random() * 2.5,
      alpha: 0.1 + Math.random() * 0.5,
      hue: Math.random() < 0.15 ? 350 : (Math.random() < 0.3 ? 190 : 0),  // red, cyan, or white
      life: Math.random(),
      decay: 0.002 + Math.random() * 0.004
    });
  }

  function tick() {
    ambientAnimId = requestAnimationFrame(tick);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;

      if (p.life <= 0 || p.y < -5 || p.x < -5 || p.x > canvas.width + 5) {
        p.x = Math.random() * canvas.width;
        p.y = canvas.height + 5;
        p.vx = (Math.random() - 0.5) * 0.35;
        p.vy = -0.2 - Math.random() * 0.55;
        p.life = 0.6 + Math.random() * 0.4;
        p.alpha = 0.1 + Math.random() * 0.5;
        p.hue = Math.random() < 0.15 ? 350 : (Math.random() < 0.3 ? 190 : 0);
      }

      const a = p.life * p.alpha;
      const color = p.hue === 350
        ? `rgba(232, 0, 45, ${a})`
        : p.hue === 190
          ? `rgba(0, 210, 255, ${a})`
          : `rgba(255, 255, 255, ${a})`;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
  tick();
}

function stopAmbientParticles() {
  if (ambientAnimId) {
    cancelAnimationFrame(ambientAnimId);
    ambientAnimId = null;
  }
}

// ----------------------------------------------------------------------------
// F1 COUNTDOWN LIGHTS ANIMATION
// ----------------------------------------------------------------------------
function playCountdownLights() {
  const overlay = document.getElementById('countdown-overlay');
  const lights = [1, 2, 3, 4, 5].map(i => document.getElementById(`cl-${i}`));
  if (!overlay || lights.some(l => !l)) return;

  // Reset
  lights.forEach(l => l.className = 'countdown-light');
  overlay.classList.add('visible');

  let i = 0;
  const step = () => {
    if (i < lights.length) {
      lights[i].classList.add('red');
      i++;
      countdownLightsTimer = setTimeout(step, 650);
    } else {
      // All red — go!
      countdownLightsTimer = setTimeout(() => {
        lights.forEach(l => { l.classList.remove('red'); l.classList.add('green'); });
        countdownLightsTimer = setTimeout(() => {
          lights.forEach(l => l.className = 'countdown-light');
          overlay.classList.remove('visible');
        }, 700);
      }, 900);
    }
  };
  step();
}

// ----------------------------------------------------------------------------
// CELEBRATION EFFECT (game over — spark burst)
// ----------------------------------------------------------------------------
function fireCelebrationEffect() {
  const el = document.getElementById('screen-gameover');
  if (!el) return;

  // Create a quick flash overlay
  const flash = document.createElement('div');
  flash.setAttribute('aria-hidden', 'true');
  Object.assign(flash.style, {
    position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '999',
    background: 'radial-gradient(ellipse at 50% 40%, rgba(232,0,45,0.25) 0%, transparent 60%)',
    opacity: '0', transition: 'opacity 0.3s ease'
  });
  document.body.appendChild(flash);
  requestAnimationFrame(() => { flash.style.opacity = '1'; });
  setTimeout(() => { flash.style.opacity = '0'; }, 400);
  setTimeout(() => { if (flash.parentNode) flash.parentNode.removeChild(flash); }, 800);
}

// ----------------------------------------------------------------------------
// ENTRY POINT
// ----------------------------------------------------------------------------
function startApp() {
  initGame();
  initUI();

  // Detect touch support and add corresponding CSS helper class
  const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (hasTouch) {
    document.documentElement.classList.add('touch-device');
  } else {
    document.documentElement.classList.add('desktop-device');
  }

  startAmbientParticles();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}
