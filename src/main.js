import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { RaceScene } from './scenes/RaceScene.js';
import { CARS } from './data/cars.js';
import { TRACKS } from './data/tracks.js';
import { drawTrackMinimap } from './utils/trackRenderer.js';
import { submitScore, fetchTopScores, subscribeToScores, syncLocalScoresToSupabase } from './supabase.js';
import { mpState, createMultiplayerRoom, joinMultiplayerRoom, leaveMultiplayerRoom, broadcastRaceStart } from './utils/multiplayer.js';

// Global App State
let selectedCarIndex = 0;
let selectedTrackIndex = 0;
let lastRaceResult = null;
let phaserGame = null;
let leaderboardUnsubscribe = null;
let leaderboardTrackId = null;
let ambientAnimId = null;      // requestAnimationFrame for menu particles
let countdownLightsTimer = null; // F1 countdown lights timeout chain
let sessionBestSectors = {};     // session best S1, S2, S3 per trackId

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
  if (screenId === 'screen-select' || screenId === 'screen-menu' || screenId === 'screen-hud') {
    scoreDialogOpen = false;
  }
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
  else if (screenId === 'screen-mp-lobby') activeTab = 'race';
  else if (screenId === 'screen-leaderboard') activeTab = 'leaderboard';
  else if (screenId === 'screen-settings') activeTab = 'settings';

  const topTabs = {
    garage: document.getElementById('top-nav-garage'),
    race: document.getElementById('top-nav-race'),
    leaderboard: document.getElementById('top-nav-leaderboard'),
    settings: document.getElementById('top-nav-settings')
  };
  Object.entries(topTabs).forEach(([key, el]) => {
    if (el) el.classList.toggle('active', key === activeTab);
  });
}

function setRaceMode(enabled) {
  document.documentElement.classList.toggle('race-mode', enabled);

  // Hide / show persistent nav chrome during a race session
  const topBar = document.getElementById('top-app-bar');
  const accentBar = document.getElementById('f1-red-accent-bar');
  const bottomNav = document.getElementById('bottom-nav');
  if (topBar) topBar.style.display = enabled ? 'none' : '';
  if (accentBar) accentBar.style.display = enabled ? 'none' : '';
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
    roundPixels: true,
    fps: {
      min: 10,
      target: 120,
      forceSetTimeOut: false,
      smoothStep: true
    },
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH
    },
    physics: {
      default: 'arcade',
      arcade: {
        gravity: { y: 0 },
        debug: false,
        fixedStep: false
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

  const speedPct = Math.min(100, (car.topSpeed / 340) * 100);
  const accelPct = Math.min(100, (car.acceleration / 180) * 100);
  const handlingPct = Math.min(100, (car.handling / 5.2) * 100);
  const boostPct = Math.min(100, (car.boostPower / 1.7) * 100);

  document.getElementById('stat-speed').style.width = `${speedPct}%`;
  document.getElementById('stat-accel').style.width = `${accelPct}%`;
  document.getElementById('stat-handling').style.width = `${handlingPct}%`;
  document.getElementById('stat-boost').style.width = `${boostPct}%`;

  const speedVal = document.getElementById('stat-speed-val');
  if (speedVal) speedVal.innerText = `${car.topSpeed} KM/H`;

  const accelVal = document.getElementById('stat-accel-val');
  if (accelVal) accelVal.innerText = `0-100: ${(350 / car.acceleration).toFixed(1)}S`;

  const handlingVal = document.getElementById('stat-handling-val');
  if (handlingVal) handlingVal.innerText = `GRIP ${(car.handling / 4).toFixed(2)}G`;

  const boostVal = document.getElementById('stat-boost-val');
  if (boostVal) boostVal.innerText = `ERS ${Math.round(car.boostPower * 100)}KW`;

  // Dynamic stat benchmark readouts
  const bmSpeed = document.getElementById('bm-speed');
  if (bmSpeed) bmSpeed.innerText = speedPct > 90 ? '+15% vs Track Avg (Straight Line)' : '+5% vs Track Avg';

  const bmAccel = document.getElementById('bm-accel');
  if (bmAccel) bmAccel.innerText = accelPct > 85 ? 'Sub 2.0s 0-100 Launch' : 'Optimal Apex Launch';

  const bmHandling = document.getElementById('bm-handling');
  if (bmHandling) bmHandling.innerText = handlingPct > 90 ? 'Maximum High-Speed Downforce' : 'Balanced Downforce';

  const bmBoost = document.getElementById('bm-boost');
  if (bmBoost) bmBoost.innerText = boostPct > 90 ? 'Overboost Energy Recovery' : 'Kinetic ERS Active';
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
  if (diffEl) {
    diffEl.innerText = track.difficulty;
    diffEl.dataset.level = track.difficulty;
  }

  const lapsEl = document.getElementById('track-laps');
  if (lapsEl) lapsEl.innerText = `${track.laps} LAPS`;

  const lengthEl = document.getElementById('track-length');
  if (lengthEl) lengthEl.innerText = track.length || "1.2 KM";

  // Circuit telemetry widget details
  const ctLapRecord = document.getElementById('ct-lap-record');
  if (ctLapRecord) ctLapRecord.innerText = track.difficulty === 'EASY' ? '00:18.117' : track.difficulty === 'MEDIUM' ? '00:24.450' : '00:29.890';

  const ctCorners = document.getElementById('ct-corners');
  if (ctCorners) ctCorners.innerText = `${track.points ? track.points.length : 12} TURNS`;

  const ctDrs = document.getElementById('ct-drs');
  if (ctDrs) ctDrs.innerText = `${track.difficulty === 'HARD' ? '3' : '2'} ZONES`;

  const ctWeather = document.getElementById('ct-weather');
  if (ctWeather) ctWeather.innerText = 'DRY · 38°C';

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

  bindButton('btn-touch-reverse', s => s.setBrake(true), s => s.setBrake(false));
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

      // Compute absolute heading angle from joystick direction (screen-space).
      // The joystick also drives acceleration: push amount (magnitude) maps to
      // progressive throttle so the car accelerates harder the further it is pushed,
      // toward the direction it is pointing.
      const sc = raceScene();
      const mag = Math.min(1, distance / limit);
      if (sc) {
        if (mag > deadzone) {
          const angle = Math.atan2(dy, dx);
          sc.setJoystickHeading(angle, true);
          // Progressive (eased) curve: small pushes = gentle, full push = full gas.
          sc.setTouchGas(Math.pow(mag, 1.6));
        } else {
          sc.setJoystickHeading(0, false);
          sc.setTouchGas(0);
        }
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
        scImmediate.setTouchGas(0);
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
    window.addEventListener('mouseleave', endDrag);
    window.addEventListener('blur', endDrag);
  }

}

// ----------------------------------------------------------------------------
function showStewardToast(text, type = 'amber') {
  const container = document.getElementById('hud-steward-toasts');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `steward-toast ${type}`;
  const icon = type === 'red' ? 'gavel' : 'warning';
  const iconEl = document.createElement('span');
  iconEl.className = 'material-symbols-outlined';
  iconEl.textContent = icon;
  const labelEl = document.createElement('span');
  labelEl.textContent = text;
  toast.append(iconEl, labelEl);
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-30px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// LISTEN TO PHASER CUSTOM EVENTS (HUD & RACE FINISH)
// ----------------------------------------------------------------------------
function setupGameEventListeners() {
  window.addEventListener('pixel-prix:hud', (e) => {
    const { speed, isReverse, lap, totalLaps, timeMs, penaltyMs, stewardInvestigation, boostEnergy, boostActive, speedRatio } = e.detail;

    // Speedometer & Gear calculation
    const speedEl = document.getElementById('hud-speed-text');
    if (speedEl) {
      speedEl.innerText = `${speed}`;
      speedEl.classList.toggle('boosting', boostActive === true);
      speedEl.classList.toggle('top-speed', speedRatio > 0.95);
    }

    const gearEl = document.getElementById('hud-gear-val');
    if (gearEl) {
      if (isReverse) {
        gearEl.innerText = 'R';
      } else if (speed === 0) {
        gearEl.innerText = 'N';
      } else {
        const gear = Math.min(6, Math.max(1, Math.ceil(speed / 45)));
        gearEl.innerText = `${gear}`;
      }
    }

    // RPM LED Shift Lights
    const leds = document.querySelectorAll('.f1-rpm-bar .rpm-led');
    if (leds.length > 0) {
      const activeCount = Math.floor(speedRatio * leds.length);
      leds.forEach((led, idx) => {
        if (idx < activeCount) led.classList.add('active');
        else led.classList.remove('active');
      });
    }

    // Lap & Timer
    const lapEl = document.getElementById('hud-lap-text');
    if (lapEl) lapEl.innerHTML = `${lap}/${totalLaps}`;
    const timerEl = document.getElementById('hud-timer-text');
    if (timerEl) timerEl.innerText = formatTime(timeMs);

    // Integrated Bottom Telemetry Ticker (Only update if no active sector split override)
    if (!window._sectorTickerActive) {
      const penaltyVal = (penaltyMs / 1000).toFixed(1);
      const penaltyChip = document.getElementById('hud-penalty-chip');
      const penaltyTextEl = document.getElementById('hud-penalty-text');
      const tickerLabelEl = document.getElementById('hud-ticker-label');
      const tickerIconEl = document.getElementById('hud-ticker-icon');

      if (tickerLabelEl) tickerLabelEl.innerText = 'TRACK LIMITS';
      if (tickerIconEl) tickerIconEl.innerText = 'shield';

      if (penaltyTextEl) {
        if (penaltyMs > 0) {
          penaltyTextEl.innerText = `+${penaltyVal}s PENALTY`;
        } else if (stewardInvestigation) {
          penaltyTextEl.innerText = 'STEWARD INVESTIGATION';
        } else {
          penaltyTextEl.innerText = 'CLEAN';
        }
      }
      if (penaltyChip) {
        penaltyChip.className = 'hud-warning-bar';
        if (penaltyMs > 0) penaltyChip.classList.add('penalty');
        else if (stewardInvestigation) penaltyChip.classList.add('investigating');
        else penaltyChip.classList.add('clean');
      }
    }

    // ERS Battery gauge fill
    const fillPercent = `${Math.max(0, Math.min(100, boostEnergy))}%`;
    const fillRight = document.getElementById('hud-boost-fill');
    if (fillRight) fillRight.style.width = fillPercent;

    // Boost button visibility
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

  // Steward & Race Notifications (Ignore redundant lap notifications)
  window.addEventListener('pixel-prix:notify', (e) => {
    const { text, type } = e.detail;
    // Suppress redundant LAP popups since LAP counter is integrated into core HUD
    if (text && text.toUpperCase().startsWith('LAP')) return;

    // Route critical notifications into the integrated HUD ticker strip
    const penaltyChip = document.getElementById('hud-penalty-chip');
    const penaltyTextEl = document.getElementById('hud-penalty-text');
    const tickerLabelEl = document.getElementById('hud-ticker-label');
    const tickerIconEl = document.getElementById('hud-ticker-icon');

    if (tickerLabelEl) tickerLabelEl.innerText = 'STEWARD ALERT';
    if (tickerIconEl) tickerIconEl.innerText = type === 'penalty' ? 'gavel' : 'warning';
    if (penaltyTextEl) penaltyTextEl.innerText = text;

    if (penaltyChip) {
      penaltyChip.className = `hud-warning-bar ${type === 'penalty' ? 'penalty' : 'investigating'}`;
    }

    window._sectorTickerActive = true;
    if (window._sectorTickerTimeout) clearTimeout(window._sectorTickerTimeout);
    window._sectorTickerTimeout = setTimeout(() => {
      window._sectorTickerActive = false;
    }, 3000);
  });

  // Integrated Sector Split Telemetry (Renders directly inside Top HUD Ticker Strip)
  window.addEventListener('pixel-prix:sector-complete', (e) => {
    const { sector, timeMs, isBest } = e.detail;
    const trackId = TRACKS[selectedTrackIndex].id;

    if (!sessionBestSectors[trackId]) {
      sessionBestSectors[trackId] = [null, null, null];
    }

    let colorClass = 'sector-yellow';
    let deltaStr = '';

    const overallBest = sessionBestSectors[trackId][sector - 1];
    if (overallBest === null || timeMs < overallBest) {
      sessionBestSectors[trackId][sector - 1] = timeMs;
      colorClass = 'sector-purple';
      deltaStr = 'NEW SESSION BEST';
    } else if (isBest) {
      colorClass = 'sector-green';
      const diff = (timeMs - overallBest) / 1000;
      deltaStr = `${diff <= 0 ? '' : '+'}${diff.toFixed(3)}s`;
    } else {
      const diff = (timeMs - overallBest) / 1000;
      deltaStr = `+${diff.toFixed(3)}s`;
    }

    const penaltyChip = document.getElementById('hud-penalty-chip');
    const penaltyTextEl = document.getElementById('hud-penalty-text');
    const tickerLabelEl = document.getElementById('hud-ticker-label');
    const tickerIconEl = document.getElementById('hud-ticker-icon');

    if (tickerLabelEl) tickerLabelEl.innerText = `SECTOR ${sector} SPLIT`;
    if (tickerIconEl) tickerIconEl.innerText = 'timer';
    if (penaltyTextEl) penaltyTextEl.innerText = `${(timeMs / 1000).toFixed(3)}s · ${deltaStr}`;

    if (penaltyChip) {
      penaltyChip.className = `hud-warning-bar ${colorClass}`;
    }

    window._sectorTickerActive = true;
    if (window._sectorTickerTimeout) clearTimeout(window._sectorTickerTimeout);
    window._sectorTickerTimeout = setTimeout(() => {
      window._sectorTickerActive = false;
    }, 3500);
  });

  window.addEventListener('pixel-prix:finish', (e) => {
    lastRaceResult = e.detail;

    // Multiplayer finishes are presented through the live classification.
    // Do not open the solo score dialog afterward, which could otherwise
    // cover or redirect away from the classification just rendered.
    if (mpState.isMultiplayer) {
      if (phaserGame && phaserGame.scene.isActive('RaceScene')) {
        phaserGame.scene.stop('RaceScene');
      }
      return;
    }

    document.getElementById('go-raw-time').innerText = formatTime(lastRaceResult.rawTimeMs);
    document.getElementById('go-penalty-time').innerText = `+${(lastRaceResult.penaltyMs / 1000).toFixed(3)}s`;
    document.getElementById('go-final-time').innerText = formatTime(lastRaceResult.totalTimeMs);
    document.getElementById('go-best-lap').innerText = `Best Lap: ${formatTime(lastRaceResult.bestLapMs)}`;

    // Render detailed sector breakdown inside the Game Over screen
    const breakdownEl = document.getElementById('go-sector-breakdown');
    if (breakdownEl) {
      const laps = lastRaceResult.lapSectors || [];
      const bestSectors = lastRaceResult.bestSectors || [null, null, null];
      const bestLapMs = lastRaceResult.bestLapMs;

      let html = `
        <div class="go-sectors-table">
          <div class="go-sector-header">
            <span>LAP</span>
            <span>SECTOR 1</span>
            <span>SECTOR 2</span>
            <span>SECTOR 3</span>
            <span>LAP TIME</span>
          </div>
      `;

      laps.forEach((lap, idx) => {
        const lapSum = lap.reduce((a, b) => a + b, 0);
        const isBestLap = Math.abs(lapSum - bestLapMs) < 10;
        const bestLapClass = isBestLap ? ' class="best-lap-row"' : '';

        // Highlight personal fastest sectors
        const s1Class = lap[0] === bestSectors[0] ? 'class="pb-sector"' : '';
        const s2Class = lap[1] === bestSectors[1] ? 'class="pb-sector"' : '';
        const s3Class = lap[2] === bestSectors[2] ? 'class="pb-sector"' : '';

        html += `
          <div class="go-sector-row"${bestLapClass}>
            <span class="row-lap-num">L${idx + 1}</span>
            <span ${s1Class}>${(lap[0] / 1000).toFixed(3)}s</span>
            <span ${s2Class}>${(lap[1] / 1000).toFixed(3)}s</span>
            <span ${s3Class}>${(lap[2] / 1000).toFixed(3)}s</span>
            <span class="row-lap-total">${formatTime(lapSum)}</span>
          </div>
        `;
      });

      // Best sectors row
      html += `
          <div class="go-sector-row best-sectors-row">
            <span class="row-lap-num">BEST</span>
            <span class="session-best-s1">${bestSectors[0] ? (bestSectors[0] / 1000).toFixed(3) + 's' : 'N/A'}</span>
            <span class="session-best-s2">${bestSectors[1] ? (bestSectors[1] / 1000).toFixed(3) + 's' : 'N/A'}</span>
            <span class="session-best-s3">${bestSectors[2] ? (bestSectors[2] / 1000).toFixed(3) + 's' : 'N/A'}</span>
            <span class="row-lap-total">${formatTime(bestLapMs)}</span>
          </div>
        </div>
      `;

      breakdownEl.innerHTML = html;
    }

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

  const form = document.getElementById('score-form');
  if (form && (form.classList.contains('is-loading') || form.classList.contains('is-success'))) {
    return;
  }

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

  // Extract sectors of the best lap
  const bestLapMs = lastRaceResult.bestLapMs;
  const rawLaps = lastRaceResult.lapSectors || [];
  let bestLapIndex = 0;
  let minDiff = Infinity;
  rawLaps.forEach((lap, idx) => {
    const sum = lap.reduce((a, b) => a + b, 0);
    const diff = Math.abs(sum - bestLapMs);
    if (diff < minDiff) {
      minDiff = diff;
      bestLapIndex = idx;
    }
  });
  const bestLapSectors = rawLaps[bestLapIndex] || [null, null, null];

  const metadata = {
    best_lap_ms: lastRaceResult.bestLapMs,
    s1_ms: bestLapSectors[0],
    s2_ms: bestLapSectors[1],
    s3_ms: bestLapSectors[2],
    fastest_s1_ms: lastRaceResult.bestSectors ? lastRaceResult.bestSectors[0] : null,
    fastest_s2_ms: lastRaceResult.bestSectors ? lastRaceResult.bestSectors[1] : null,
    fastest_s3_ms: lastRaceResult.bestSectors ? lastRaceResult.bestSectors[2] : null
  };

  submitScore({
    playerName: check.name,
    carId: lastRaceResult.carId,
    trackId: lastRaceResult.trackId,
    timeMs: lastRaceResult.totalTimeMs,
    metadata: metadata
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
  container.innerHTML = `
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
  `;

  const { scores, error } = await fetchTopScores(trackId);

  if (error) {
    container.innerHTML = '<p class="loading-cell">Unable to load global times. Please try again.</p>';
    return;
  }

  if (!scores || scores.length === 0) {
    container.innerHTML = '<p class="loading-cell">No times recorded for this track yet. Be the first!</p>';
    return;
  }

  // Pre-fill session best sectors based on all leaderboard records
  if (!sessionBestSectors[trackId]) {
    sessionBestSectors[trackId] = [null, null, null];
  }
  scores.forEach(s => {
    let meta = null;
    if (s.metadata) {
      try {
        meta = typeof s.metadata === 'string' ? JSON.parse(s.metadata) : s.metadata;
      } catch (_) {}
    }
    if (meta) {
      if (meta.fastest_s1_ms && (sessionBestSectors[trackId][0] === null || meta.fastest_s1_ms < sessionBestSectors[trackId][0])) {
        sessionBestSectors[trackId][0] = meta.fastest_s1_ms;
      }
      if (meta.fastest_s2_ms && (sessionBestSectors[trackId][1] === null || meta.fastest_s2_ms < sessionBestSectors[trackId][1])) {
        sessionBestSectors[trackId][1] = meta.fastest_s2_ms;
      }
      if (meta.fastest_s3_ms && (sessionBestSectors[trackId][2] === null || meta.fastest_s3_ms < sessionBestSectors[trackId][2])) {
        sessionBestSectors[trackId][2] = meta.fastest_s3_ms;
      }
    }
  });

  const leaderTimeMs = scores[0]?.time_ms || 0;
  const compounds = ['soft', 'medium', 'hard'];

  container.innerHTML = scores.map((s, idx) => {
    const carName = CARS.find(c => c.id === s.car_id)?.name || s.car_id;
    const isFirst = idx === 0;
    const isSecond = idx === 1;
    const isThird = idx === 2;
    const podiumClass = isFirst ? ' lb-row-first' : isSecond ? ' lb-row-second' : isThird ? ' lb-row-third' : '';
    const posStr = `P${idx + 1}`;

    const compound = compounds[idx % 3];
    const tireSymbol = compound === 'soft' ? 'S' : compound === 'medium' ? 'M' : 'H';
    const rankDelta = idx % 2 === 0 ? '<span class="rank-indicator up">▲ 1</span>' : idx % 3 === 0 ? '<span class="rank-indicator down">▼ 1</span>' : '<span class="rank-indicator same">-</span>';

    const gapMs = s.time_ms - leaderTimeMs;
    const gapStr = isFirst ? 'LEADER' : `+${(gapMs / 1000).toFixed(3)}s`;

    let meta = null;
    if (s.metadata) {
      try {
        meta = typeof s.metadata === 'string' ? JSON.parse(s.metadata) : s.metadata;
      } catch (_) {}
    }

    const sessionBests = sessionBestSectors[trackId] || [null, null, null];
    const s1Val = meta?.s1_ms ? `${(meta.s1_ms / 1000).toFixed(3)}s` : '--';
    const s2Val = meta?.s2_ms ? `${(meta.s2_ms / 1000).toFixed(3)}s` : '--';
    const s3Val = meta?.s3_ms ? `${(meta.s3_ms / 1000).toFixed(3)}s` : '--';

    const s1Class = meta?.s1_ms && meta.s1_ms === sessionBests[0] ? 'purple' : '';
    const s2Class = meta?.s2_ms && meta.s2_ms === sessionBests[1] ? 'purple' : '';
    const s3Class = meta?.s3_ms && meta.s3_ms === sessionBests[2] ? 'purple' : '';

    return `
      <div class="lb-row-group">
        <div class="lb-row${podiumClass}" onclick="this.parentElement.classList.toggle('expanded')">
          <div class="lb-col-pos">${posStr}</div>
          <div class="lb-col-rank">${rankDelta}</div>
          <div class="lb-col-tire"><span class="tire-badge ${compound}">${tireSymbol}</span></div>
          <div class="lb-col-pilot">
            <p class="lb-row-name">${escapeHtml(s.player_name)}</p>
            <p class="lb-row-constructor">${escapeHtml(carName)}</p>
          </div>
          <div class="sector-col-val ${s1Class}">${s1Val}</div>
          <div class="sector-col-val ${s2Class}">${s2Val}</div>
          <div class="sector-col-val ${s3Class}">${s3Val}</div>
          <div class="lb-col-time">
            <p class="lb-row-time">${formatTime(s.time_ms)}</p>
          </div>
          <div class="gap-col-val">${gapStr}</div>
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

  bindClickOrTouch('top-nav-leaderboard', openLeaderboard);
  bindClickOrTouch('top-nav-race', openRaceSelect);
  bindClickOrTouch('top-nav-garage', () => showScreen('screen-menu'));
  bindClickOrTouch('top-nav-settings', openSettings);

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
    mpState.isMultiplayer = false;
    launchSelectedRace();
  });

  // -------------------------------------------------------------------------
  // MULTIPLAYER ROOM LOBBY & EVENTS
  // -------------------------------------------------------------------------
  const selectedCarId = () => CARS[selectedCarIndex].id;
  const selectedTrackId = () => TRACKS[selectedTrackIndex].id;
  const getPlayerNameInput = () => {
    const input = document.getElementById('player-name-input');
    return (input && input.value.trim()) ? input.value.trim().toUpperCase() : (localStorage.getItem('pixel-prix:player-name') || 'DRIVER 1');
  };

  // Create Room as Host
  bindClickOrTouch('btn-create-room', async () => {
    try {
      const pName = getPlayerNameInput();
      const cId = selectedCarId();
      const tId = selectedTrackId();

      showStewardToast('CREATING ONLINE LOBBY…', 'amber');
      const { roomCode } = await createMultiplayerRoom(tId, cId, pName);

      document.getElementById('mp-room-code-val').innerText = roomCode;
      showScreen('screen-mp-lobby');
      showStewardToast(`ONLINE LOBBY ${roomCode} READY`, 'amber');
    } catch (err) {
      console.error('Unable to create online lobby:', err);
      showStewardToast('UNABLE TO CREATE LOBBY — CHECK YOUR CONNECTION', 'red');
    }
  });

  // Open Join Room Modal
  bindClickOrTouch('btn-join-room-modal', () => {
    const modal = document.getElementById('modal-join-room');
    const input = document.getElementById('input-room-code');
    const errorEl = document.getElementById('join-room-error');
    if (input) input.value = '';
    if (errorEl) errorEl.classList.add('hidden');
    if (modal) modal.classList.remove('hidden');
  });

  // Cancel Join Modal
  bindClickOrTouch('btn-cancel-join', () => {
    document.getElementById('modal-join-room')?.classList.add('hidden');
  });

  // Confirm Join Room Code
  bindClickOrTouch('btn-confirm-join', async () => {
    const input = document.getElementById('input-room-code');
    const errorEl = document.getElementById('join-room-error');
    const code = (input ? input.value : '').trim().toUpperCase();

    if (!code || code.length < 4) {
      if (errorEl) {
        errorEl.innerText = 'PLEASE ENTER A VALID 4-CHAR ROOM CODE';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    try {
      const pName = getPlayerNameInput();
      const cId = selectedCarId();
      const tId = selectedTrackId();

      const { roomCode } = await joinMultiplayerRoom(code, tId, cId, pName);
      document.getElementById('modal-join-room')?.classList.add('hidden');
      document.getElementById('mp-room-code-val').innerText = roomCode;
      showScreen('screen-mp-lobby');
      showStewardToast(`JOINED ONLINE LOBBY ${roomCode}`, 'amber');
    } catch (err) {
      if (errorEl) {
        errorEl.innerText = err.message || 'FAILED TO JOIN ONLINE RACE';
        errorEl.classList.remove('hidden');
      }
    }
  });

  // Leave Lobby
  bindClickOrTouch('btn-mp-leave-lobby', () => {
    leaveMultiplayerRoom();
    showScreen('screen-select');
  });

  // Copy Room Code
  bindClickOrTouch('btn-copy-room-code', () => {
    if (!mpState.roomCode) return;
    navigator.clipboard?.writeText(mpState.roomCode).then(() => {
      showStewardToast(`COPIED ROOM CODE: ${mpState.roomCode}`, 'amber');
    }).catch(() => {
      showStewardToast(`ROOM CODE: ${mpState.roomCode}`, 'amber');
    });
  });

  // Host Start Multiplayer Race
  bindClickOrTouch('btn-mp-start-race', () => {
    if (!mpState.isHost) return;
    broadcastRaceStart();
  });

  // Exit Classification Results Modal
  const closeMpResults = () => {
    closeScoreDialog();
    document.getElementById('modal-mp-results')?.classList.add('hidden');
    document.getElementById('mp-results-rows')?.replaceChildren();
    leaveMultiplayerRoom();
    if (phaserGame && phaserGame.scene.isActive('RaceScene')) {
      phaserGame.scene.stop('RaceScene');
    }
    showScreen('screen-select');
  };

  bindClickOrTouch('btn-mp-results-exit', closeMpResults);
  bindClickOrTouch('btn-close-mp-results-x', closeMpResults);

  const modalMpResults = document.getElementById('modal-mp-results');
  if (modalMpResults) {
    modalMpResults.addEventListener('click', (e) => {
      if (e.target === modalMpResults) {
        closeMpResults();
      }
    });
  }

  // -------------------------------------------------------------------------
  // MULTIPLAYER REALTIME EVENTS LISTENERS
  // -------------------------------------------------------------------------
  window.addEventListener('pixel-prix:mp-lobby-update', (e) => {
    const { players, isHost, roomCode } = e.detail;

    document.getElementById('mp-room-code-val').innerText = roomCode || '----';
    document.getElementById('mp-driver-count').innerText = players.length;

    const listEl = document.getElementById('mp-drivers-list');
    if (listEl) {
      listEl.innerHTML = players.map((p, idx) => {
        const isLocal = p.id === mpState.localPlayer.id;
        const carMatch = CARS.find(c => c.id === p.carId) || CARS[0];
        const gridLabel = idx === 0 ? 'POLE' : `P${idx + 1}`;

        return `
          <div class="mp-driver-card ${isLocal ? 'is-local' : ''} ${p.isHost ? 'is-host' : ''}">
            <div class="mp-driver-left">
              <span class="mp-grid-pos">${gridLabel}</span>
              <div class="mp-driver-info">
                <div class="mp-driver-name">${escapeHtml(p.name)} ${isLocal ? '(YOU)' : ''}</div>
                <div class="mp-car-name">${escapeHtml(carMatch.name)}</div>
              </div>
            </div>
            ${p.isHost ? '<span class="mp-badge-host">HOST</span>' : ''}
          </div>
        `;
      }).join('');
    }

    const startBtn = document.getElementById('btn-mp-start-race');
    const nonHostMsg = document.getElementById('mp-non-host-msg');

    if (isHost) {
      if (startBtn) {
        startBtn.classList.remove('hidden');
        startBtn.disabled = players.length < 2;
      }
      if (nonHostMsg) nonHostMsg.classList.add('hidden');
    } else {
      if (startBtn) startBtn.classList.add('hidden');
      if (nonHostMsg) nonHostMsg.classList.remove('hidden');
    }
  });

  // Handle Race Start Event
  window.addEventListener('pixel-prix:mp-race-start', (e) => {
    showScreen('screen-hud');
    playCountdownLights();

    if (phaserGame) {
      phaserGame.scale.refresh();
      const selectedCarId = mpState.localPlayer.carId || CARS[selectedCarIndex].id;
      const selectedTrackId = mpState.trackId || TRACKS[selectedTrackIndex].id;

      if (phaserGame.scene.isActive('RaceScene')) {
        phaserGame.scene.stop('RaceScene');
      }

      phaserGame.scene.start('RaceScene', {
        carId: selectedCarId,
        trackId: selectedTrackId
      });
    }
  });

  // Handle Finish Classification Event
  window.addEventListener('pixel-prix:mp-race-finish-update', (e) => {
    const finishedPlayers = Array.isArray(e.detail?.finishedPlayers) ? e.detail.finishedPlayers : [];
    const rowsEl = document.getElementById('mp-results-rows');
    const modal = document.getElementById('modal-mp-results');
    const localPlayerHasFinished = finishedPlayers.some((player) => player.id === mpState.localPlayer.id);

    // A remote driver finishing must not interrupt racers who are still on
    // track. Once this driver has finished, later realtime updates refresh
    // the same classification in place.
    if (rowsEl && localPlayerHasFinished) {
      const leaderTime = finishedPlayers[0].timeMs;
      rowsEl.innerHTML = finishedPlayers.map((p, idx) => {
        const carMatch = CARS.find(c => c.id === p.carId) || CARS[0];
        const gapStr = idx === 0 ? 'WINNER' : `+${((p.timeMs - leaderTime) / 1000).toFixed(3)}s`;

        return `
          <tr>
            <td>P${idx + 1}</td>
            <td><strong>${escapeHtml(p.name)}</strong></td>
            <td>${escapeHtml(carMatch.name)}</td>
            <td>${formatTime(p.timeMs)}</td>
            <td>${gapStr}</td>
          </tr>
        `;
      }).join('');

      if (modal) modal.classList.remove('hidden');
    }
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
    syncLocalScoresToSupabase().finally(() => {
      loadLeaderboard(trackId);
    });
  });

  setupTouchControls();
  setupGameEventListeners();

  // Desktop: ESC toggles the pause menu during a race
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const hud = document.getElementById('screen-hud');
    const pause = document.getElementById('screen-pause');
    if (!hud || !pause) return;
    const onHud = !hud.classList.contains('hidden');
    const onPause = !pause.classList.contains('hidden');
    if (onHud && !onPause) {
      e.preventDefault();
      showScreen('screen-pause');
    } else if (onPause && !onHud) {
      e.preventDefault();
      showScreen('screen-hud');
    }
  });

  // Desktop: keyboard shortcuts for menu/overlay buttons (context-aware)
  if (document.documentElement.classList.contains('desktop-device')) {
    const isActive = (id) => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    };
    const click = (id) => document.getElementById(id)?.click();
    const inField = () => {
      const a = document.activeElement;
      return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
    };

    window.addEventListener('keydown', (e) => {
      if (inField()) return;
      const k = e.key;
      // Global back/close on overlays
      if (k === 'Escape') {
        if (isActive('screen-settings')) { e.preventDefault(); click('btn-close-settings'); return; }
        if (isActive('screen-leaderboard')) { e.preventDefault(); click('btn-close-leaderboard'); return; }
        if (isActive('screen-select')) { e.preventDefault(); click('btn-select-back'); return; }
      }

      if (isActive('screen-menu')) {
        if (k === 'Enter') { e.preventDefault(); click('btn-start-game'); }
        return;
      }

      if (isActive('screen-select')) {
        if (k === 'Enter') { e.preventDefault(); click('btn-launch-race'); }
        else if (k === 'ArrowLeft') { e.preventDefault(); click('car-prev'); }
        else if (k === 'ArrowRight') { e.preventDefault(); click('car-next'); }
        else if (k === 'ArrowUp') { e.preventDefault(); click('track-prev'); }
        else if (k === 'ArrowDown') { e.preventDefault(); click('track-next'); }
        return;
      }

      if (isActive('screen-pause')) {
        if (k === 'Enter') { e.preventDefault(); click('btn-resume-race'); }
        else if (k === 'r' || k === 'R') { e.preventDefault(); click('btn-restart-race'); }
        else if (k === 'm' || k === 'M') { e.preventDefault(); click('btn-exit-to-menu'); }
        return;
      }

      if (isActive('screen-gameover')) {
        if (k === 'Enter') { e.preventDefault(); click('btn-retry-race'); }
        else if (k === 'l' || k === 'L') { e.preventDefault(); click('btn-view-leaderboard-go'); }
        else if (k === 'm' || k === 'M') { e.preventDefault(); click('btn-gameover-menu'); }
        return;
      }
    });
  }
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
  const NUM = 55;

  for (let i = 0; i < NUM; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: (Math.random() - 0.5) * 0.4,
      vy: -0.3 - Math.random() * 0.6,
      size: 1 + Math.random() * 2.5,
      alpha: 0.15 + Math.random() * 0.5,
      color: Math.random() < 0.25 ? '#FF1801' : (Math.random() < 0.5 ? '#00F0FF' : '#ffffff'),
      life: Math.random(),
      decay: 0.002 + Math.random() * 0.004
    });
  }

  // 3D F1 Chassis Wireframe Vertices (x, y, z)
  const wireframeVertices = [
    // Nose & Cockpit
    { x: 0, y: 15, z: 120 }, { x: -15, y: -5, z: 60 }, { x: 15, y: -5, z: 60 },
    { x: -22, y: -10, z: 0 }, { x: 22, y: -10, z: 0 },
    // Sidepods & Airbox
    { x: -35, y: -12, z: -40 }, { x: 35, y: -12, z: -40 },
    { x: -30, y: -15, z: -100 }, { x: 30, y: -15, z: -100 },
    { x: 0, y: 35, z: -20 }, // Airbox scoop
    // Front Wing
    { x: -65, y: 5, z: 110 }, { x: 65, y: 5, z: 110 },
    { x: -65, y: -5, z: 125 }, { x: 65, y: -5, z: 125 },
    // Rear Wing Assembly
    { x: -40, y: 25, z: -120 }, { x: 40, y: 25, z: -120 },
    { x: -40, y: 38, z: -120 }, { x: 40, y: 38, z: -120 }
  ];

  const wireframeEdges = [
    [0, 1], [0, 2], [1, 2], [1, 3], [2, 4], [3, 4],
    [3, 5], [4, 6], [5, 6], [5, 7], [6, 8], [7, 8],
    [1, 9], [2, 9], [7, 9], [8, 9],
    [0, 10], [0, 11], [10, 12], [11, 13],
    [7, 14], [8, 15], [14, 15], [14, 16], [15, 17], [16, 17]
  ];

  let rotationAngle = 0;

  function tick() {
    ambientAnimId = requestAnimationFrame(tick);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Render Ambient Particles
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;

      if (p.life <= 0 || p.y < -5 || p.x < -5 || p.x > canvas.width + 5) {
        p.x = Math.random() * canvas.width;
        p.y = canvas.height + 5;
        p.vx = (Math.random() - 0.5) * 0.4;
        p.vy = -0.3 - Math.random() * 0.6;
        p.life = 0.6 + Math.random() * 0.4;
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.life * p.alpha;
      ctx.fill();
    }
    ctx.globalAlpha = 1.0;

    // Render 3D Rotating F1 Carbon Chassis Wireframe behind glass containers
    rotationAngle += 0.008;
    const cx = canvas.width * 0.5;
    const cy = canvas.height * 0.45;
    const scale = Math.min(canvas.width, canvas.height) * 0.0022;

    const radY = rotationAngle;
    const radX = Math.sin(rotationAngle * 0.5) * 0.15 + 0.2;

    const projected = wireframeVertices.map(v => {
      // Y-axis rotation
      let x1 = v.x * Math.cos(radY) + v.z * Math.sin(radY);
      let z1 = -v.x * Math.sin(radY) + v.z * Math.cos(radY);

      // X-axis rotation
      let y2 = v.y * Math.cos(radX) - z1 * Math.sin(radX);
      let z2 = v.y * Math.sin(radX) + z1 * Math.cos(radX);

      const fov = 400;
      const perspective = fov / (fov + z2 + 180);

      return {
        x: cx + x1 * scale * perspective,
        y: cy - y2 * scale * perspective,
        z: z2
      };
    });

    // Draw edge lines
    ctx.lineWidth = 1.2;
    wireframeEdges.forEach(([i, j]) => {
      const p1 = projected[i];
      const p2 = projected[j];

      const grad = ctx.createLinearGradient(p1.x, p1.y, p2.x, p2.y);
      grad.addColorStop(0, 'rgba(0, 240, 255, 0.35)');
      grad.addColorStop(1, 'rgba(255, 24, 1, 0.35)');

      ctx.strokeStyle = grad;
      ctx.shadowColor = '#00F0FF';
      ctx.shadowBlur = 6;

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      ctx.shadowBlur = 0;
    });
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

  if (countdownLightsTimer) {
    clearTimeout(countdownLightsTimer);
    countdownLightsTimer = null;
  }

  // Reset
  lights.forEach(l => l.className = 'countdown-light');
  overlay.classList.add('visible');

  let i = 0;
  const step = () => {
    if (i < lights.length) {
      lights[i].classList.add('red');
      i++;
      countdownLightsTimer = setTimeout(step, 550);
    } else {
      // All 5 red lights lit — pause then GO (green lights)
      countdownLightsTimer = setTimeout(() => {
        lights.forEach(l => { l.classList.remove('red'); l.classList.add('green'); });
        window.dispatchEvent(new CustomEvent('pixel-prix:lights-green'));

        countdownLightsTimer = setTimeout(() => {
          lights.forEach(l => l.className = 'countdown-light');
          overlay.classList.remove('visible');
        }, 800);
      }, 800);
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
  // Detect touch support and add the corresponding CSS helper class BEFORE
  // wiring up UI listeners — desktop-only keyboard shortcuts are gated on the
  // 'desktop-device' class, so it must exist when initUI() runs.
  const hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (hasTouch) {
    document.documentElement.classList.add('touch-device');
  } else {
    document.documentElement.classList.add('desktop-device');
  }

  // The UI must remain available even when a browser cannot initialise the
  // Phaser renderer (for example after a GPU/WebGL reset).  Initialising the
  // game first made that failure look like a blank application because none
  // of the menu handlers or the visible-screen state had been established.
  initUI();
  setRaceMode(false);
  showScreen('screen-menu');
  startAmbientParticles();

  try {
    initGame();
  } catch (error) {
    // Keep the garage and non-race screens usable; a later reload can retry
    // renderer initialisation without trapping the player on a black screen.
    console.error('Game renderer failed to initialise:', error);
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}
