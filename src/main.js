import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene.js';
import { RaceScene } from './scenes/RaceScene.js';
import { CARS } from './data/cars.js';
import { TRACKS } from './data/tracks.js';
import { drawTrackMinimap } from './utils/trackRenderer.js';
import { submitScore, fetchTopScores, subscribeToScores, syncLocalScoresToSupabase } from './supabase.js';
import { mpState, createMultiplayerRoom, joinMultiplayerRoom, leaveMultiplayerRoom, broadcastRaceStart, broadcastLobbyTrackChange, resetMultiplayerRaceState } from './utils/multiplayer.js';
import { getDailyFeaturedTrackId, getDriverName, loadDriverProfile, recordSoloRace, saveDriverName } from './utils/progression.js';
import { resolveWeatherCondition } from './utils/grandPrix.js';

// Global App State
let selectedCarIndex = 0;
let selectedTrackIndex = 0;
let lastRaceResult = null;
let phaserGame = null;
let leaderboardUnsubscribe = null;
let leaderboardTrackId = null;
let ambientAnimId = null;      // requestAnimationFrame for menu particles
let countdownLightsTimers = [];  // F1 countdown timer handles
let countdownLightsFrame = null; // pending requestAnimationFrame handle
let countdownLightsGeneration = 0; // invalidates stale countdown callbacks
let sessionBestSectors = {};     // session best S1, S2, S3 per trackId
let dailyFeaturedTrackId = null;
let raceSelectionMode = 'time-trial';
let selectedWeatherId = 'auto';
let selectedSetupId = 'balanced';
let selectedGridSize = 6;
let lastSessionConfig = null;

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

function refreshDriverProfileUI() {
  const profile = loadDriverProfile();
  const name = getDriverName();
  const nameEl = document.getElementById('top-driver-name');
  const xpEl = document.getElementById('top-driver-pts');
  const levelEl = document.getElementById('top-driver-level');
  const dailyEl = document.getElementById('daily-featured-chip');

  if (nameEl) nameEl.textContent = name;
  if (xpEl) xpEl.textContent = `${profile.xp.toLocaleString()} XP`;
  if (levelEl) levelEl.textContent = `LEVEL ${profile.level}`;

  const dailyTrack = TRACKS.find((track) => track.id === dailyFeaturedTrackId);
  if (dailyEl && dailyTrack) {
    dailyEl.textContent = `DAILY FEATURE: ${dailyTrack.name.toUpperCase()}`;
  }
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
  if (topBar) topBar.style.display = enabled ? 'none' : '';
  if (accentBar) accentBar.style.display = enabled ? 'none' : '';

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

function setRaceSelectionMode(mode = 'time-trial') {
  raceSelectionMode = ['coop', 'grand-prix'].includes(mode) ? mode : 'time-trial';
  const selectScreen = document.getElementById('screen-select');
  const title = document.getElementById('select-screen-title');
  const launchLabel = document.querySelector('#btn-launch-race .start-btn-content > span:first-child');

  if (selectScreen) selectScreen.dataset.mode = raceSelectionMode;
  if (title) {
    title.textContent = raceSelectionMode === 'coop'
      ? 'CO-OP RACE'
      : raceSelectionMode === 'grand-prix'
        ? 'GRAND PRIX'
        : 'TIME TRIAL';
  }
  if (launchLabel) {
    launchLabel.textContent = raceSelectionMode === 'grand-prix'
      ? 'START GRAND PRIX'
      : 'START TIME TRIAL';
  }
  updateSessionConfig();
}

function updateSessionConfig() {
  const track = TRACKS[selectedTrackIndex] || TRACKS[0];
  const weatherInput = selectedWeatherId === 'auto' ? track?.weather : selectedWeatherId;
  const weather = resolveWeatherCondition(weatherInput);
  const setupLabel = selectedSetupId === 'rain' ? 'RAIN SETUP' : `${selectedSetupId.toUpperCase()} SETUP`;

  document.querySelectorAll('[data-weather-choice]').forEach((button) => {
    button.classList.toggle('active', button.dataset.weatherChoice === selectedWeatherId);
  });
  document.querySelectorAll('[data-setup-choice]').forEach((button) => {
    button.classList.toggle('active', button.dataset.setupChoice === selectedSetupId);
  });
  document.querySelectorAll('[data-grid-choice]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.gridChoice) === selectedGridSize);
  });

  const copy = document.getElementById('session-config-copy');
  if (copy) {
    copy.textContent = raceSelectionMode === 'grand-prix'
      ? `GRAND PRIX · ${selectedGridSize + 1}-CAR GRID · ${weather.label.toUpperCase()} · ${setupLabel}`
      : `TIME TRIAL · ${weather.label.toUpperCase()} · ${setupLabel} · PERSONAL GHOST ENABLED`;
  }

  const weatherEl = document.getElementById('ct-weather');
  if (weatherEl && track) {
    weatherEl.textContent = selectedWeatherId === 'auto'
      ? `${track.weather} · TRACK CALL`
      : `${weather.label.toUpperCase()} · SELECTED`;
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
function drawCarPreview(canvas, car) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // The garage renders the exact same authored texture as the race scene so
  // a selected vehicle never turns into a simpler, unrelated thumbnail.
  const textureKey = car ? `car_${car.id}_straight` : '';
  const texture = textureKey && phaserGame?.textures?.exists(textureKey)
    ? phaserGame.textures.get(textureKey).getSourceImage()
    : null;
  if (texture) {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    ctx.beginPath();
    ctx.ellipse(w / 2, h * 0.76, w * 0.31, h * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.imageSmoothingEnabled = false;
    const modelHeight = h * 0.78;
    const modelWidth = modelHeight * (texture.width / texture.height);
    ctx.drawImage(texture, (w - modelWidth) / 2, (h - modelHeight) / 2 - 2, modelWidth, modelHeight);
    ctx.restore();
    return;
  }

  const color = car?.color || '#ff1801';
  const accentColor = car?.accentColor || '#ffeb00';

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

  const driveStyle = document.getElementById('car-drive-style');
  if (driveStyle) driveStyle.textContent = getCarDriveStyle(car);

  updateSelectionDots('car-selection-dots', CARS.length, selectedCarIndex);
  const carCount = document.getElementById('car-selection-count');
  if (carCount) carCount.textContent = `${String(selectedCarIndex + 1).padStart(2, '0')} / ${String(CARS.length).padStart(2, '0')}`;

  const previewCanvas = document.getElementById('car-preview-canvas');
  drawCarPreview(previewCanvas, car);

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

function getCarDriveStyle(car) {
  if (car.driveStyle) return car.driveStyle;
  if (car.topSpeed >= 310) return 'STRAIGHT-LINE ATTACK';
  if (car.acceleration >= 205) return 'LAUNCH & EXIT';
  if (car.handling >= 4.8) return 'PRECISION GRIP';
  if (car.boostPower >= 1.55) return 'ERS QUALIFYING MODE';
  return 'BALANCED RACE PACE';
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

  updateSelectionDots('track-selection-dots', TRACKS.length, selectedTrackIndex);
  const trackCount = document.getElementById('track-selection-count');
  if (trackCount) trackCount.textContent = `${String(selectedTrackIndex + 1).padStart(2, '0')} / ${String(TRACKS.length).padStart(2, '0')}`;

  const regionEl = document.getElementById('track-region');
  if (regionEl) regionEl.textContent = track.region || 'PIXEL PRIX / GRAND PRIX';

  const characterEl = document.getElementById('track-character');
  if (characterEl) characterEl.textContent = track.character || 'RACE READY';

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
  if (ctLapRecord) ctLapRecord.innerText = track.record || '01:18.117';

  const ctCorners = document.getElementById('ct-corners');
  if (ctCorners) ctCorners.innerText = `${track.points ? track.points.length : 12} TURNS`;

  const ctDrs = document.getElementById('ct-drs');
  if (ctDrs) ctDrs.innerText = `${track.drsZones ?? 2} ZONES`;

  const ctWeather = document.getElementById('ct-weather');
  if (ctWeather) ctWeather.innerText = track.weather || 'DRY · 28°C';

  const canvas = document.getElementById('track-minimap');
  drawTrackMinimap(canvas, track);
  if (canvas) canvas.setAttribute('aria-label', `${track.name} circuit map`);
  updateSessionConfig();
}

function updateSelectionDots(containerId, itemCount, activeIndex) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // The garage is expected to grow. Build the indicators from the data rather
  // than letting a hard-coded dot count silently fall out of sync.
  container.replaceChildren(...Array.from({ length: itemCount }, (_, index) => {
    const dot = document.createElement('span');
    dot.className = `dot${index === activeIndex ? ' active' : ''}`;
    dot.setAttribute('aria-hidden', 'true');
    return dot;
  }));
}

function launchSelectedRace(restartConfig = null) {
  const selectedTrack = TRACKS[selectedTrackIndex] || TRACKS[0];
  const selectedCar = CARS[selectedCarIndex] || CARS[0];
  const sessionConfig = restartConfig || {
    carId: selectedCar.id,
    trackId: selectedTrack.id,
    raceMode: raceSelectionMode === 'grand-prix' ? 'grand-prix' : 'time-trial',
    weatherId: selectedWeatherId,
    setupId: selectedSetupId,
    gridSize: selectedGridSize,
    driverName: getDriverName()
  };
  lastSessionConfig = { ...sessionConfig };

  setRaceMode(true);
  showScreen('screen-hud');

  if (phaserGame) {
    phaserGame.scale.refresh();

    if (phaserGame.scene.isActive('RaceScene') || phaserGame.scene.isPaused('RaceScene')) {
      phaserGame.scene.stop('RaceScene');
    }

    phaserGame.scene.start('RaceScene', sessionConfig);
  }

  // Wait until RaceScene has attached its lights-out listener before starting
  // the presentation countdown. The scene also owns a safe fallback if a
  // renderer cannot schedule this frame.
  queueCountdownLights();
}

// ----------------------------------------------------------------------------
// TOUCH CONTROLS BINDINGS (HUD)
// ----------------------------------------------------------------------------
function setupTouchControls() {
  const raceScene = () => phaserGame?.scene?.getScene('RaceScene');

  const bindButton = (id, onStart, onEnd) => {
    const btn = document.getElementById(id);
    if (!btn) return;

    let isPressed = false;
    let activePointerId = null;

    const start = (e) => {
      // Ignore right-clicks and a second finger/mouse button while this
      // control is already held. Pointer capture keeps a held pedal active
      // even when the finger drifts just outside its visual bounds.
      if (typeof e?.button === 'number' && e.button !== 0) return;
      if (typeof e?.pointerId === 'number') {
        if (activePointerId !== null && activePointerId !== e.pointerId) return;
        activePointerId = e.pointerId;
        try { btn.setPointerCapture?.(e.pointerId); } catch (_) { /* capture is best-effort */ }
      }
      if (isPressed) return;
      if (e?.cancelable) e.preventDefault();
      isPressed = true;
      btn.classList.add('active');
      const sc = raceScene();
      if (sc) onStart(sc);
    };

    const end = (e) => {
      if (!isPressed) return;
      if (typeof e?.pointerId === 'number' && activePointerId !== null && e.pointerId !== activePointerId) return;
      if (e?.cancelable) e.preventDefault();
      isPressed = false;
      activePointerId = null;
      btn.classList.remove('active');
      const sc = raceScene();
      if (sc) onEnd(sc);
    };

    // Pointer events give every modern browser the same hold/release path
    // for mouse, touch, pen, and multi-touch. The legacy fallback remains
    // for older mobile browsers that do not expose PointerEvent.
    if ('PointerEvent' in window) {
      btn.addEventListener('pointerdown', start);
      btn.addEventListener('pointerup', end);
      btn.addEventListener('pointercancel', end);
      btn.addEventListener('lostpointercapture', end);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      window.addEventListener('blur', end);
    } else {
      btn.addEventListener('touchstart', start, { passive: false });
      btn.addEventListener('touchend', end, { passive: false });
      btn.addEventListener('touchcancel', end, { passive: false });
      btn.addEventListener('mousedown', start);
      btn.addEventListener('mouseup', end);
      btn.addEventListener('mouseleave', end);
    }

    // Keyboard activation is a held control too. This gives the visible HUD
    // pedals a reliable accessible fallback without stealing race hotkeys.
    btn.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.stopPropagation();
        start(e);
      }
    });
    btn.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.stopPropagation();
        end(e);
      }
    });
  };

  bindButton('btn-touch-accel', s => s.setAccelerate(true), s => s.setAccelerate(false));
  bindButton('btn-touch-reverse', s => s.setBrake(true), s => s.setBrake(false));
  bindButton('btn-touch-left', s => s.setSteerLeft(true), s => s.setSteerLeft(false));
  bindButton('btn-touch-right', s => s.setSteerRight(true), s => s.setSteerRight(false));
  bindButton('btn-touch-brake', s => s.setBrake(true), s => s.setBrake(false));
  bindButton('btn-touch-boost', s => s.setBoost(true), s => s.setBoost(false));
  bindButton('btn-touch-boost-left', s => s.setBoost(true), s => s.setBoost(false));

  // Touch steering is intentionally separate from throttle. A mobile racer
  // gets an explicit GAS pedal rather than a hidden "push the stick forward"
  // rule, so steering remains predictable while braking or boosting.
  const joystickBaseEl = document.getElementById('hud-joystick-base');
  const joystickHandleEl = document.getElementById('hud-joystick-handle');

  if (joystickBaseEl && joystickHandleEl) {
    let isDraggingJoystick = false;
    let recenterInterval = null;
    let activePointerId = null;
    const deadzone = 0.08; // 8% center deadzone

    const updateJoystick = (clientX) => {
      const rect = joystickBaseEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const maxRadius = rect.width / 2;
      const limit = maxRadius * 0.7; // Limit handle to 70% of base radius

      const dx = Phaser.Math.Clamp(clientX - cx, -limit, limit);

      joystickHandleEl.style.transform = `translate(${dx}px, 0px)`;

      const sc = raceScene();
      if (sc) {
        const steering = Math.abs(dx / limit) > deadzone ? dx / limit : 0;
        sc.setJoystickHeading(0, false);
        sc.setSteeringValue(steering);
      }
    };

    const startDrag = (e) => {
      if (typeof e?.button === 'number' && e.button !== 0) return;
      if (typeof e?.pointerId === 'number') {
        if (activePointerId !== null && activePointerId !== e.pointerId) return;
        activePointerId = e.pointerId;
        try { joystickBaseEl.setPointerCapture?.(e.pointerId); } catch (_) { /* best-effort */ }
      }
      if (e?.cancelable) e.preventDefault();
      isDraggingJoystick = true;
      if (recenterInterval) {
        cancelAnimationFrame(recenterInterval);
        recenterInterval = null;
      }
      updateJoystick(e.clientX);
    };

    const drag = (e) => {
      if (!isDraggingJoystick) return;
      if (typeof e?.pointerId === 'number' && activePointerId !== null && e.pointerId !== activePointerId) return;
      if (e.cancelable) e.preventDefault();
      updateJoystick(e.clientX);
    };

    const endDrag = (e) => {
      if (!isDraggingJoystick) return;
      if (typeof e?.pointerId === 'number' && activePointerId !== null && e.pointerId !== activePointerId) return;
      isDraggingJoystick = false;
      activePointerId = null;

      // Immediately clear steering state in the game scene.
      const scImmediate = raceScene();
      if (scImmediate) {
        scImmediate.setJoystickHeading(0, false);
        scImmediate.setSteeringValue(0);
      }

      // Smoothly ease the visual handle back to centre.
      const style = window.getComputedStyle(joystickHandleEl);
      const matrix = new DOMMatrix(style.transform);
      let curDx = matrix.m41;

      const step = () => {
        if (isDraggingJoystick) {
          recenterInterval = null;
          return;
        }

        curDx *= 0.8; // Easing decay rate

        if (Math.abs(curDx) < 0.1) {
          curDx = 0;
        }

        joystickHandleEl.style.transform = `translate(${curDx}px, 0px)`;

        if (curDx !== 0) {
          recenterInterval = requestAnimationFrame(step);
        } else {
          recenterInterval = null;
        }
      };

      recenterInterval = requestAnimationFrame(step);
    };

    if ('PointerEvent' in window) {
      joystickBaseEl.addEventListener('pointerdown', startDrag);
      joystickBaseEl.addEventListener('pointermove', drag);
      joystickBaseEl.addEventListener('pointerup', endDrag);
      joystickBaseEl.addEventListener('pointercancel', endDrag);
      joystickBaseEl.addEventListener('lostpointercapture', endDrag);
      window.addEventListener('pointerup', endDrag);
      window.addEventListener('pointercancel', endDrag);
      window.addEventListener('blur', endDrag);
    } else {
      const legacyPoint = (event) => {
        const touch = event.changedTouches?.[0] || event.touches?.[0];
        return touch ? {
          clientX: touch.clientX,
          cancelable: event.cancelable,
          preventDefault: () => event.preventDefault()
        } : event;
      };
      joystickBaseEl.addEventListener('touchstart', (event) => startDrag(legacyPoint(event)), { passive: false });
      joystickBaseEl.addEventListener('touchmove', (event) => drag(legacyPoint(event)), { passive: false });
      joystickBaseEl.addEventListener('touchend', (event) => endDrag(legacyPoint(event)));
      joystickBaseEl.addEventListener('touchcancel', (event) => endDrag(legacyPoint(event)));
      joystickBaseEl.addEventListener('mousedown', startDrag);
      window.addEventListener('mousemove', drag);
      window.addEventListener('mouseup', endDrag);
      window.addEventListener('blur', endDrag);
    }
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

function renderGrandPrixSummary(result) {
  const summary = document.getElementById('go-grand-prix-summary');
  const banner = document.getElementById('go-finish-banner');
  const positionEl = document.getElementById('go-grand-prix-position');
  const conditionEl = document.getElementById('go-grand-prix-condition');
  const rowsEl = document.getElementById('go-grand-prix-rows');
  const isGrandPrix = result?.raceMode === 'grand-prix';

  if (!isGrandPrix || !Array.isArray(result?.classification)) {
    summary?.classList.add('hidden');
    if (banner) banner.textContent = 'RACE FINISHED';
    rowsEl?.replaceChildren();
    return;
  }

  const classification = result.classification.slice(0, 12);
  const player = classification.find((entry) => entry.isPlayer) || classification.find((entry) => entry.id === 'player');
  const position = Math.max(1, Number(player?.position) || Number(result.position) || 1);
  const leader = classification[0];
  const leaderTime = Number(leader?.finishTimeMs ?? leader?.raceTimeMs);

  if (banner) banner.textContent = position === 1 ? 'GRAND PRIX WIN' : 'GRAND PRIX FINISHED';
  if (positionEl) positionEl.textContent = `P${position}`;
  if (conditionEl) {
    const weather = String(result.weatherLabel || 'TRACK CALL').toUpperCase();
    const setup = String(result.setupId || 'balanced').toUpperCase();
    conditionEl.textContent = `${weather} · ${setup} SETUP`;
  }

  if (rowsEl) {
    rowsEl.replaceChildren(...classification.map((entry) => {
      const row = document.createElement('div');
      row.className = `go-grand-prix-row${entry.isPlayer ? ' is-player' : ''}`;

      const place = document.createElement('span');
      place.textContent = `P${entry.position || '—'}`;
      const name = document.createElement('span');
      name.textContent = entry.isPlayer ? `${entry.name || 'DRIVER'} (YOU)` : (entry.name || 'AI DRIVER');
      const status = document.createElement('span');
      status.className = 'gp-gap';
      const entryTime = Number(entry.finishTimeMs ?? entry.raceTimeMs);
      if (entry.position === 1) status.textContent = 'WINNER';
      else if (Number.isFinite(entryTime) && Number.isFinite(leaderTime) && entry.finished) {
        status.textContent = `+${((entryTime - leaderTime) / 1000).toFixed(3)}s`;
      } else {
        status.textContent = entry.finished ? 'FINISHED' : `LAP ${entry.lap || 1}`;
      }
      row.append(place, name, status);
      return row;
    }));
  }
  summary?.classList.remove('hidden');
}

// RACE CONTROL ALERT PRESENTER
// One visible, priority-aware channel keeps timing, penalties, and steward calls
// readable without competing with primary telemetry.
// ----------------------------------------------------------------------------
const HUD_ALERT_PRIORITY = Object.freeze({ neutral: 1, sector: 2, review: 3, penalty: 4 });
let activeHudAlert = null;
let hudAlertTimeout = null;

function clearHudAlert(expectedKind) {
  if (expectedKind && activeHudAlert?.kind !== expectedKind) return;
  if (hudAlertTimeout) clearTimeout(hudAlertTimeout);
  hudAlertTimeout = null;
  activeHudAlert = null;
  const chip = document.getElementById('hud-penalty-chip');
  if (chip) {
    chip.className = 'hud-warning-bar hidden';
    chip.setAttribute('aria-hidden', 'true');
  }
}

function presentHudAlert({ kind, label, message, icon, duration = 0, persistent = false }) {
  const priority = HUD_ALERT_PRIORITY[kind] ?? HUD_ALERT_PRIORITY.neutral;
  if (activeHudAlert && activeHudAlert.priority > priority) return false;
  if (activeHudAlert?.persistent && activeHudAlert.priority === priority && !persistent) return false;

  if (hudAlertTimeout) clearTimeout(hudAlertTimeout);
  activeHudAlert = { kind, priority, persistent };

  const chip = document.getElementById('hud-penalty-chip');
  const labelEl = document.getElementById('hud-ticker-label');
  const messageEl = document.getElementById('hud-penalty-text');
  const iconEl = document.getElementById('hud-ticker-icon');
  if (!chip || !labelEl || !messageEl || !iconEl) return false;

  labelEl.textContent = label;
  messageEl.textContent = message;
  iconEl.textContent = icon;
  chip.className = `hud-warning-bar alert-${kind}`;
  chip.removeAttribute('aria-hidden');

  if (!persistent && duration > 0) {
    hudAlertTimeout = setTimeout(() => clearHudAlert(kind), duration);
  }
  return true;
}

function syncRaceControlAlert(penaltyMs, stewardInvestigation) {
  if (penaltyMs > 0) {
    presentHudAlert({
      kind: 'penalty', label: 'PENALTY', message: `+${(penaltyMs / 1000).toFixed(1)}s`,
      icon: 'gavel', persistent: true
    });
    return;
  }
  if (stewardInvestigation) {
    presentHudAlert({
      kind: 'review', label: 'TRACK LIMITS', message: 'UNDER REVIEW',
      icon: 'policy', persistent: true
    });
    return;
  }
  if (activeHudAlert?.persistent) clearHudAlert();
}

// LISTEN TO PHASER CUSTOM EVENTS (HUD & RACE FINISH)
// ----------------------------------------------------------------------------
function setupGameEventListeners() {
  window.addEventListener('pixel-prix:hud', (e) => {
    const {
      speed, isReverse, lap, totalLaps, timeMs, penaltyMs, stewardInvestigation,
      boostEnergy, boostActive, speedRatio, raceMode, racePosition, fieldSize,
      weatherLabel, ghostDeltaMs, ghostActive
    } = e.detail;

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
        // Shorter shift intervals keep the digital gearbox responsive as the
        // car reaches its speed bands sooner.
        const gear = Math.min(6, Math.max(1, Math.ceil(speed / 34)));
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

    const raceStatus = document.getElementById('hud-race-status');
    const raceStatusLabel = document.getElementById('hud-race-status-label');
    const raceStatusText = document.getElementById('hud-race-status-text');
    if (raceMode === 'grand-prix') {
      raceStatus?.classList.remove('hidden');
      if (raceStatusLabel) raceStatusLabel.textContent = weatherLabel ? weatherLabel.toUpperCase() : 'RACE';
      if (raceStatusText) raceStatusText.textContent = `P${racePosition || 1}/${fieldSize || 1}`;
    } else if (Number.isFinite(ghostDeltaMs) || ghostActive) {
      raceStatus?.classList.remove('hidden');
      if (raceStatusLabel) raceStatusLabel.textContent = 'GHOST';
      if (raceStatusText) {
        if (Number.isFinite(ghostDeltaMs)) {
          const prefix = ghostDeltaMs <= 0 ? '−' : '+';
          raceStatusText.textContent = `${prefix}${Math.abs(ghostDeltaMs / 1000).toFixed(2)}s`;
        } else {
          raceStatusText.textContent = 'LIVE';
        }
      }
    } else {
      raceStatus?.classList.add('hidden');
    }

    // Clean running is deliberately quiet. Only actionable race-control states interrupt.
    syncRaceControlAlert(penaltyMs, stewardInvestigation);

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

  // Steward & race notifications, presented in the separate lower-third alert channel.
  window.addEventListener('pixel-prix:notify', (e) => {
    const { text, type } = e.detail;
    // Suppress redundant LAP popups since LAP counter is integrated into core HUD
    if (text && text.toUpperCase().startsWith('LAP')) return;

    const isPenalty = type === 'penalty' || /\bPENALTY\b/i.test(text || '');
    const isStewardCall = type === 'stewards' || type === 'review' || /\bSTEWARDS?\b|TRACK LIMITS/i.test(text || '');
    if (isPenalty) {
      const amount = text?.match(/\+\d+(?:\.\d+)?s/i)?.[0]?.toUpperCase() || 'TIME ADDED';
      presentHudAlert({ kind: 'penalty', label: 'PENALTY', message: amount, icon: 'gavel', duration: 4200 });
    } else if (isStewardCall) {
      const warning = text?.match(/(?:FINAL )?WARNING\s*\d*\/?\d*/i)?.[0]?.toUpperCase();
      presentHudAlert({
        kind: 'review', label: 'TRACK LIMITS', message: warning || 'UNDER REVIEW',
        icon: 'policy', duration: 3600
      });
    } else {
      presentHudAlert({ kind: 'neutral', label: 'RACE CONTROL', message: text, icon: 'flag', duration: 2200 });
    }
  });

  // Sector splits remain explicit: their colour is decoration, never the only meaning.
  window.addEventListener('pixel-prix:sector-complete', (e) => {
    const { sector, timeMs, isBest } = e.detail;
    const trackId = TRACKS[selectedTrackIndex].id;

    if (!sessionBestSectors[trackId]) {
      sessionBestSectors[trackId] = [null, null, null];
    }

    let outcome = ' +0.000s';
    let icon = 'timer';

    const overallBest = sessionBestSectors[trackId][sector - 1];
    if (overallBest === null || timeMs < overallBest) {
      sessionBestSectors[trackId][sector - 1] = timeMs;
      outcome = 'SESSION BEST';
      icon = 'workspace_premium';
    } else if (isBest) {
      const diff = (timeMs - overallBest) / 1000;
      outcome = `PERSONAL BEST${diff > 0 ? ` · +${diff.toFixed(3)}s` : ''}`;
      icon = 'trending_up';
    } else {
      const diff = (timeMs - overallBest) / 1000;
      outcome = `+${diff.toFixed(3)}s`;
      icon = 'schedule';
    }
    presentHudAlert({
      kind: 'sector', label: `SECTOR ${sector}`, message: `${(timeMs / 1000).toFixed(3)}s · ${outcome}`,
      icon, duration: 3400
    });
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

    const isGrandPrix = lastRaceResult.raceMode === 'grand-prix';
    const progressionTrackId = lastRaceResult.leaderboardEligible === true
      ? lastRaceResult.trackId
      : `${lastRaceResult.trackId}:${lastRaceResult.raceMode}:${lastRaceResult.weatherId}:${lastRaceResult.setupId}`;
    const progression = recordSoloRace({
      trackId: progressionTrackId,
      totalTimeMs: lastRaceResult.totalTimeMs,
      penaltyMs: lastRaceResult.penaltyMs,
      grandPrixPosition: isGrandPrix ? lastRaceResult.position : null,
      grandPrixFieldSize: isGrandPrix ? lastRaceResult.fieldSize : 0
    });
    refreshDriverProfileUI();
    const raceReward = isGrandPrix
      ? `${lastRaceResult.position === 1 ? 'GRAND PRIX WIN' : `P${lastRaceResult.position} FINISH`} · +${progression.grandPrixPoints} PTS · +${progression.earnedXp} XP`
      : progression.personalBest
        ? `NEW PERSONAL BEST · +${progression.earnedXp} XP`
        : progression.cleanRace
          ? `CLEAN RACE · +${progression.earnedXp} XP`
          : `RACE COMPLETE · +${progression.earnedXp} XP`;
    showStewardToast(raceReward, 'amber');

    document.getElementById('go-raw-time').innerText = formatTime(lastRaceResult.rawTimeMs);
    document.getElementById('go-penalty-time').innerText = `+${(lastRaceResult.penaltyMs / 1000).toFixed(3)}s`;
    document.getElementById('go-final-time').innerText = formatTime(lastRaceResult.totalTimeMs);
    document.getElementById('go-best-lap').innerText = `Best Lap: ${formatTime(lastRaceResult.bestLapMs)}`;
    renderGrandPrixSummary(lastRaceResult);

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
        const bestLapClass = isBestLap ? ' class="fastest-lap-row"' : '';

        // These are this driver's best sectors for the completed run. They
        // deliberately use the personal-best color; purple is reserved for a
        // true session/leaderboard fastest sector in the live HUD.
        const s1Class = lap[0] === bestSectors[0] ? 'class="personal-best-sector"' : '';
        const s2Class = lap[1] === bestSectors[1] ? 'class="personal-best-sector"' : '';
        const s3Class = lap[2] === bestSectors[2] ? 'class="personal-best-sector"' : '';

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
            <span class="row-lap-num">BEST SECTORS</span>
            <span class="personal-best-summary">${bestSectors[0] ? (bestSectors[0] / 1000).toFixed(3) + 's' : 'N/A'}</span>
            <span class="personal-best-summary">${bestSectors[1] ? (bestSectors[1] / 1000).toFixed(3) + 's' : 'N/A'}</span>
            <span class="personal-best-summary">${bestSectors[2] ? (bestSectors[2] / 1000).toFixed(3) + 's' : 'N/A'}</span>
            <span class="row-lap-total">${formatTime(bestLapMs)}</span>
          </div>
        </div>
      `;

      breakdownEl.innerHTML = html;
    }

    const leaderboardEligible = lastRaceResult.leaderboardEligible === true;
    const scoreForm = document.getElementById('score-form');
    const sessionNote = document.getElementById('go-session-note');
    const skipScore = document.getElementById('btn-close-score');
    scoreForm?.classList.toggle('hidden', !leaderboardEligible);
    sessionNote?.classList.toggle('hidden', leaderboardEligible);
    skipScore?.classList.toggle('hidden', !leaderboardEligible);

    // Stop the race scene
    if (phaserGame && (phaserGame.scene.isActive('RaceScene') || phaserGame.scene.isPaused('RaceScene'))) {
      phaserGame.scene.stop('RaceScene');
    }

    // Trigger finish celebration
    fireCelebrationEffect();
    if (leaderboardEligible) openScoreDialog();
    else closeScoreDialog();
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
  if (nameInput) nameInput.value = getDriverName();
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
  saveDriverName(check.name);
  refreshDriverProfileUI();

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
  container.innerHTML = TRACKS.map((t, index) => `
    <button class="lb-tab-btn ${t.id === activeTrackId ? 'active' : ''}" data-track-id="${t.id}" aria-label="Show live timing for ${escapeHtml(t.name)}" title="${escapeHtml(t.name)}">
      <span class="lb-tab-index">${String(index + 1).padStart(2, '0')}</span>
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
  const leaveLobbyForNavigation = () => {
    // A create/join request opens its Realtime channel before the lobby is
    // visible. Navigation must cancel that pending session too.
    if (mpState.channel || mpState.isMultiplayer) {
      leaveMultiplayerRoom();
    }
  };

  // Navigation Buttons
  const openRaceSelect = (mode = 'time-trial') => {
    leaveLobbyForNavigation();
    setRaceSelectionMode(mode);
    updateCarSelection();
    updateTrackSelection();
    updateSessionConfig();
    showScreen('screen-select');
  };

  bindClickOrTouch('btn-start-game', () => openRaceSelect('time-trial'));
  bindClickOrTouch('btn-open-grand-prix', () => openRaceSelect('grand-prix'));
  bindClickOrTouch('btn-open-coop', () => openRaceSelect('coop'));

  const openLeaderboard = () => {
    leaveLobbyForNavigation();
    const trackId = TRACKS[selectedTrackIndex].id;
    renderLeaderboardTabs(trackId);
    watchLeaderboard(trackId);
    loadLeaderboard(trackId);
    showScreen('screen-leaderboard');
  };

  const openSettings = () => {
    leaveLobbyForNavigation();
    showScreen('screen-settings');
  };

  bindClickOrTouch('btn-open-leaderboard', openLeaderboard);

  // Top-right settings icon
  bindClickOrTouch('top-settings-icon', openSettings);

  // Bottom & Top nav tab wiring
  bindClickOrTouch('top-nav-leaderboard', openLeaderboard);
  bindClickOrTouch('top-nav-race', () => openRaceSelect('time-trial'));
  bindClickOrTouch('top-nav-garage', () => {
    leaveLobbyForNavigation();
    showScreen('screen-menu');
  });
  bindClickOrTouch('top-nav-settings', openSettings);

  bindClickOrTouch('btn-close-settings', () => {
    showScreen('screen-menu');
  });

  bindClickOrTouch('btn-close-leaderboard', () => {
    stopWatchingLeaderboard();
    showScreen('screen-menu');
  });

  bindClickOrTouch('btn-select-back', () => {
    leaveLobbyForNavigation();
    showScreen('screen-menu');
  });

  // Pause menu and explicit race exit. Online races remain live for other
  // drivers, so they do not present a misleading local "paused" state.
  const exitActiveRace = ({ leaveOnline = true } = {}) => {
    cancelCountdownLights();
    if (phaserGame && (phaserGame.scene.isActive('RaceScene') || phaserGame.scene.isPaused('RaceScene'))) {
      phaserGame.scene.stop('RaceScene');
    }
    if (leaveOnline && mpState.isMultiplayer) {
      leaveMultiplayerRoom();
      showStewardToast('LEFT ONLINE SESSION', 'amber');
    }
  };

  const pauseSoloRace = () => {
    if (mpState.isMultiplayer) {
      showStewardToast('ONLINE RACES STAY LIVE — USE EXIT TO LEAVE', 'amber');
      return false;
    }
    if (phaserGame?.scene?.isActive('RaceScene')) {
      phaserGame.scene.pause('RaceScene');
    }
    showScreen('screen-pause');
    return true;
  };

  bindClickOrTouch('btn-touch-pause', pauseSoloRace);

  bindClickOrTouch('btn-hud-back', () => {
    exitActiveRace();
    showScreen('screen-menu');
  });

  bindClickOrTouch('btn-resume-race', () => {
    if (phaserGame?.scene?.isPaused('RaceScene')) {
      phaserGame.scene.resume('RaceScene');
    }
    showScreen('screen-hud');
  });

  bindClickOrTouch('btn-restart-race', () => {
    launchSelectedRace(lastSessionConfig);
  });

  bindClickOrTouch('btn-exit-to-menu', () => {
    exitActiveRace();
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

  document.querySelectorAll('[data-weather-choice]').forEach((button) => {
    bindClickOrTouch(button, () => {
      selectedWeatherId = button.dataset.weatherChoice || 'auto';
      updateSessionConfig();
    });
  });

  document.querySelectorAll('[data-setup-choice]').forEach((button) => {
    bindClickOrTouch(button, () => {
      selectedSetupId = button.dataset.setupChoice || 'balanced';
      updateSessionConfig();
    });
  });

  document.querySelectorAll('[data-grid-choice]').forEach((button) => {
    bindClickOrTouch(button, () => {
      const gridSize = Number(button.dataset.gridChoice);
      if (Number.isFinite(gridSize) && gridSize >= 2 && gridSize <= Math.min(12, CARS.length)) {
        selectedGridSize = Math.round(gridSize);
        updateSessionConfig();
      }
    });
  });

  bindClickOrTouch('btn-launch-race', () => {
    // A lobby can be left through navigation before returning to this CTA.
    // Tear down its Realtime channel before a solo race so a late room event
    // cannot start a second scene over the local session.
    if (mpState.channel || mpState.isMultiplayer) leaveMultiplayerRoom();
    launchSelectedRace();
  });

  // -------------------------------------------------------------------------
  // MULTIPLAYER ROOM LOBBY & EVENTS
  // -------------------------------------------------------------------------
  const selectedCarId = () => CARS[selectedCarIndex].id;
  const selectedTrackId = () => TRACKS[selectedTrackIndex].id;
  const getPlayerNameInput = () => {
    const input = document.getElementById('player-name-input');
    return (input && input.value.trim()) ? input.value.trim().toUpperCase() : getDriverName();
  };

  // Create Room as Host
  bindClickOrTouch('btn-create-room', async () => {
    try {
      const pName = getPlayerNameInput();
      const cId = selectedCarId();
      const tId = selectedTrackId();

      showStewardToast('CREATING ONLINE LOBBY…', 'amber');
      const { roomCode, sessionEpoch } = await createMultiplayerRoom(tId, cId, pName);
      if (mpState.sessionEpoch !== sessionEpoch || !mpState.isMultiplayer || !mpState.channel) return;

      document.getElementById('mp-room-code-val').innerText = roomCode;
      showScreen('screen-mp-lobby');
      showStewardToast(`ONLINE LOBBY ${roomCode} READY`, 'amber');
    } catch (err) {
      if (err?.code === 'ROOM_SESSION_SUPERSEDED') return;
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
    if (mpState.channel || mpState.isMultiplayer) leaveMultiplayerRoom();
    document.getElementById('modal-join-room')?.classList.add('hidden');
  });

  // Confirm Join Room Code
  bindClickOrTouch('btn-confirm-join', async () => {
    const input = document.getElementById('input-room-code');
    const errorEl = document.getElementById('join-room-error');
    const code = (input ? input.value : '').trim().toUpperCase();

    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) {
      if (errorEl) {
        errorEl.innerText = 'PLEASE ENTER A VALID 6-CHAR ROOM CODE';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    try {
      const pName = getPlayerNameInput();
      const cId = selectedCarId();
      const tId = selectedTrackId();

      const { roomCode, assignedCarId, carChanged, assignedTrackId, sessionEpoch } = await joinMultiplayerRoom(code, tId, cId, pName);
      if (mpState.sessionEpoch !== sessionEpoch || !mpState.isMultiplayer || !mpState.channel) return;
      const assignedTrackIndex = TRACKS.findIndex((track) => track.id === assignedTrackId);
      if (assignedTrackIndex >= 0) {
        selectedTrackIndex = assignedTrackIndex;
        updateTrackSelection();
      }
      if (carChanged && assignedCarId) {
        const assignedIndex = CARS.findIndex((car) => car.id === assignedCarId);
        if (assignedIndex >= 0) {
          selectedCarIndex = assignedIndex;
          updateCarSelection();
        }
        showStewardToast(`CAR ALREADY CLAIMED — ASSIGNED ${CARS[assignedIndex]?.name?.toUpperCase() || 'AVAILABLE CAR'}`, 'amber');
      }
      document.getElementById('modal-join-room')?.classList.add('hidden');
      document.getElementById('mp-room-code-val').innerText = roomCode;
      showScreen('screen-mp-lobby');
      showStewardToast(`JOINED ONLINE LOBBY ${roomCode}`, 'amber');
    } catch (err) {
      if (err?.code === 'ROOM_SESSION_SUPERSEDED') return;
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
    resetMultiplayerRaceState();
    if (mpState.channel) {
      mpState.localPlayer = { ...mpState.localPlayer, racePhase: 'lobby', raceId: null };
      mpState.channel.track(mpState.localPlayer).catch(() => {});
    }
    if (phaserGame && phaserGame.scene.isActive('RaceScene')) {
      phaserGame.scene.stop('RaceScene');
    }
    showScreen('screen-mp-lobby');
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
    const hasUniqueCars = new Set(players.map((player) => player.carId)).size === players.length;
    const selectedTrack = TRACKS.find((track) => track.id === mpState.trackId);

    document.getElementById('mp-room-code-val').innerText = roomCode || '----';
    document.getElementById('mp-driver-count').innerText = players.length;
    document.getElementById('mp-session-track').innerText = selectedTrack?.name?.toUpperCase() || 'UNKNOWN CIRCUIT';
    const gridStatus = document.getElementById('mp-grid-status');
    if (gridStatus) {
      gridStatus.textContent = players.length < 2
        ? 'WAITING FOR ONE MORE DRIVER'
        : (hasUniqueCars ? 'GRID READY' : 'ASSIGNING UNIQUE CARS');
    }
    ['btn-mp-track-prev', 'btn-mp-track-next'].forEach((id) => {
      const control = document.getElementById(id);
      if (!control) return;
      control.classList.toggle('hidden', !isHost);
      control.disabled = !isHost;
    });

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
        startBtn.disabled = players.length < 2 || !hasUniqueCars;
        startBtn.title = hasUniqueCars ? '' : 'Waiting for unique car assignments';
      }
      if (nonHostMsg) {
        nonHostMsg.textContent = 'ASSIGNING UNIQUE CARS…';
        nonHostMsg.classList.toggle('hidden', hasUniqueCars);
      }
    } else {
      if (startBtn) startBtn.classList.add('hidden');
      if (nonHostMsg) {
        nonHostMsg.textContent = 'WAITING FOR HOST TO START RACE…';
        nonHostMsg.classList.remove('hidden');
      }
    }
  });

  window.addEventListener('pixel-prix:mp-car-reassigned', (e) => {
    const assignedIndex = CARS.findIndex((car) => car.id === e.detail?.carId);
    if (assignedIndex < 0) return;
    selectedCarIndex = assignedIndex;
    updateCarSelection();
    showStewardToast(`CAR ALREADY CLAIMED — ASSIGNED ${CARS[assignedIndex].name.toUpperCase()}`, 'amber');
  });

  window.addEventListener('pixel-prix:mp-track-update', (e) => {
    const trackIndex = TRACKS.findIndex((track) => track.id === e.detail?.trackId);
    if (trackIndex < 0) return;
    selectedTrackIndex = trackIndex;
    updateTrackSelection();
    const trackName = document.getElementById('mp-session-track');
    if (trackName) trackName.textContent = TRACKS[trackIndex].name.toUpperCase();
  });

  window.addEventListener('pixel-prix:mp-room-locked', () => {
    document.getElementById('modal-join-room')?.classList.add('hidden');
    showScreen('screen-select');
    showStewardToast('RACE ALREADY IN PROGRESS — JOIN A NEW LOBBY', 'amber');
  });

  const changeLobbyTrack = (direction) => {
    if (!mpState.isHost) return;
    selectedTrackIndex = (selectedTrackIndex + direction + TRACKS.length) % TRACKS.length;
    updateTrackSelection();
    broadcastLobbyTrackChange(TRACKS[selectedTrackIndex].id).catch(() => {
      showStewardToast('TRACK UPDATE LOST — TRY AGAIN', 'red');
    });
  };
  bindClickOrTouch('btn-mp-track-prev', () => changeLobbyTrack(-1));
  bindClickOrTouch('btn-mp-track-next', () => changeLobbyTrack(1));

  // Handle Race Start Event
  window.addEventListener('pixel-prix:mp-race-start', (e) => {
    // Ignore any delivery queued before a user deliberately left the room.
    if (
      !mpState.isMultiplayer ||
      !mpState.channel ||
      Number(e.detail?.sessionEpoch) !== mpState.sessionEpoch
    ) return;

    document.getElementById('modal-mp-results')?.classList.add('hidden');
    setRaceMode(true);
    showScreen('screen-hud');
    const startTimestamp = Number(e.detail?.startTimestamp) || (Date.now() + 4000);

    if (phaserGame) {
      phaserGame.scale.refresh();
      const selectedCarId = mpState.localPlayer.carId || CARS[selectedCarIndex].id;
      const selectedTrackId = mpState.trackId || TRACKS[selectedTrackIndex].id;

      if (phaserGame.scene.isActive('RaceScene') || phaserGame.scene.isPaused('RaceScene')) {
        phaserGame.scene.stop('RaceScene');
      }

      phaserGame.scene.start('RaceScene', {
        carId: selectedCarId,
        trackId: selectedTrackId,
        startTimestamp
      });
    }

    // The green-light time is shared by every client; the presentation can
    // join mid-sequence if the network packet arrived late without moving the
    // actual start time.
    queueCountdownLights(startTimestamp);
  });

  // Handle Finish Classification Event
  window.addEventListener('pixel-prix:mp-race-finish-update', (e) => {
    const roster = (mpState.raceRoster.length > 0 ? mpState.raceRoster : mpState.players)
      .filter((player) => !player.retired);
    const rosterIds = new Set(roster.map((player) => player.id));
    const finishedPlayers = (Array.isArray(e.detail?.finishedPlayers) ? e.detail.finishedPlayers : [])
      .filter((player) => !rosterIds.size || rosterIds.has(player.id));
    const rowsEl = document.getElementById('mp-results-rows');
    const modal = document.getElementById('modal-mp-results');
    const localPlayerHasFinished = finishedPlayers.some((player) => player.id === mpState.localPlayer.id);
    const expectedDrivers = roster.length;
    const raceComplete = expectedDrivers > 0 && finishedPlayers.length >= expectedDrivers;

    // A finisher remains in spectator mode until the frozen grid has crossed
    // the line (or a departed driver was removed by presence sync).
    if (rowsEl && localPlayerHasFinished) {
      const leaderTime = finishedPlayers[0].timeMs;
      const fastestLapMs = Math.min(...finishedPlayers
        .map((player) => player.fastestLapMs)
        .filter((timeMs) => Number.isFinite(timeMs)));
      rowsEl.innerHTML = finishedPlayers.map((p, idx) => {
        const carMatch = CARS.find(c => c.id === p.carId) || CARS[0];
        const gapStr = idx === 0 ? '—' : `+${((p.timeMs - leaderTime) / 1000).toFixed(3)}s`;
        const hasFastestLap = Number.isFinite(fastestLapMs) && p.fastestLapMs === fastestLapMs;
        const fastestLap = Number.isFinite(p.fastestLapMs) ? formatTime(p.fastestLapMs) : '—';

        return `
          <tr class="${hasFastestLap ? 'mp-fastest-lap-row' : ''}">
            <td>P${idx + 1}</td>
            <td><strong>${escapeHtml(p.name)}</strong></td>
            <td>${escapeHtml(carMatch.name)}</td>
            <td>${formatTime(p.timeMs)}</td>
            <td>${gapStr}</td>
            <td class="${hasFastestLap ? 'mp-fastest-lap' : ''}">${fastestLap}</td>
          </tr>
        `;
      }).join('');

      if (modal && raceComplete) {
        const summary = document.getElementById('mp-results-summary');
        if (summary) {
          summary.textContent = Number.isFinite(fastestLapMs)
            ? `FASTEST LAP · ${formatTime(fastestLapMs)}`
            : 'SESSION COMPLETE';
        }
        modal.classList.remove('hidden');
      }
    }
  });

  // Game Over Actions
  // These actions are explicit user intents that dismiss the username dialog.
  bindClickOrTouch('btn-retry-race', () => {
    closeScoreDialog();
    launchSelectedRace(lastSessionConfig);
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
      pauseSoloRace();
    } else if (onPause && !onHud) {
      e.preventDefault();
      if (phaserGame?.scene?.isPaused('RaceScene')) {
        phaserGame.scene.resume('RaceScene');
      }
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

    const cycleFocus = (targets, key) => {
      if (!targets.length) return false;
      const step = (key === 'ArrowLeft' || key === 'ArrowUp') ? -1 : 1;
      const activeIndex = targets.indexOf(document.activeElement);
      const nextIndex = activeIndex < 0
        ? 0
        : (activeIndex + step + targets.length) % targets.length;
      targets[nextIndex].focus({ preventScroll: true });
      return true;
    };

    window.addEventListener('keydown', (e) => {
      if (inField() || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;

      const focusedNav = document.activeElement?.closest('.top-glass-nav');
      if (focusedNav) {
        const tabs = [...focusedNav.querySelectorAll('.top-nav-link:not(:disabled)')];
        if (cycleFocus(tabs, e.key)) e.preventDefault();
        return;
      }

      if (isActive('screen-menu')) {
        const tiles = [...document.querySelectorAll('#screen-menu .garage-tile:not(:disabled)')];
        if (cycleFocus(tiles, e.key)) e.preventDefault();
        return;
      }

      if (isActive('screen-pause') || isActive('screen-gameover')) {
        const screen = isActive('screen-pause') ? '#screen-pause' : '#screen-gameover';
        const actions = [...document.querySelectorAll(`${screen} button:not(:disabled)`)]
          .filter((button) => !button.classList.contains('hidden'));
        if (cycleFocus(actions, e.key)) e.preventDefault();
      }
    });

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
        if (document.activeElement?.closest('.top-glass-nav')) return;
        if (k === 'Enter' || k === ' ') {
          e.preventDefault();
          const selectedTile = document.activeElement?.closest('#screen-menu .garage-tile:not(:disabled)');
          if (selectedTile) selectedTile.click();
          else click('btn-start-game');
        }
        return;
      }

      if (isActive('screen-select')) {
        if (k === 'Enter') {
          e.preventDefault();
          click(raceSelectionMode === 'coop' ? 'btn-create-room' : 'btn-launch-race');
        }
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
const COUNTDOWN_LIGHT_INTERVAL_MS = 550;
const COUNTDOWN_HOLD_MS = 800;
const COUNTDOWN_DURATION_MS = COUNTDOWN_LIGHT_INTERVAL_MS * 5 + COUNTDOWN_HOLD_MS;

function cancelCountdownLights() {
  countdownLightsGeneration += 1;
  if (countdownLightsFrame !== null) {
    window.cancelAnimationFrame(countdownLightsFrame);
    countdownLightsFrame = null;
  }
  countdownLightsTimers.forEach((timer) => clearTimeout(timer));
  countdownLightsTimers = [];
  document.getElementById('countdown-overlay')?.classList.remove('visible');
}

function scheduleCountdown(delay, callback) {
  const generation = countdownLightsGeneration;
  const timer = window.setTimeout(() => {
    if (generation === countdownLightsGeneration) callback();
  }, Math.max(0, delay));
  countdownLightsTimers.push(timer);
  return timer;
}

function queueCountdownLights(sharedStartTimestamp = null) {
  cancelCountdownLights();
  const generation = countdownLightsGeneration;
  countdownLightsFrame = window.requestAnimationFrame(() => {
    countdownLightsFrame = null;
    if (generation === countdownLightsGeneration) {
      playCountdownLights(sharedStartTimestamp);
    }
  });
}

function playCountdownLights(sharedStartTimestamp = null) {
  const overlay = document.getElementById('countdown-overlay');
  const lights = [1, 2, 3, 4, 5].map(i => document.getElementById(`cl-${i}`));
  if (!overlay || lights.some(l => !l)) return;

  cancelCountdownLights();

  // `sharedStartTimestamp` is the exact lights-out time in multiplayer. The
  // same schedule is used solo, where we create a target from this moment.
  const now = Date.now();
  const requestedStart = Number(sharedStartTimestamp);
  const lightsOutAt = Number.isFinite(requestedStart) && requestedStart > 0
    ? requestedStart
    : now + COUNTDOWN_DURATION_MS;
  const firstRedAt = lightsOutAt - COUNTDOWN_DURATION_MS;

  lights.forEach(l => l.className = 'countdown-light');
  overlay.classList.add('visible');

  lights.forEach((light, index) => {
    const lightAt = firstRedAt + index * COUNTDOWN_LIGHT_INTERVAL_MS;
    const illuminate = () => light.classList.add('red');
    if (now >= lightAt) illuminate();
    else scheduleCountdown(lightAt - now, illuminate);
  });

  const go = () => {
    lights.forEach((light) => {
      light.classList.remove('red');
      light.classList.add('green');
    });
    window.dispatchEvent(new CustomEvent('pixel-prix:lights-green'));
    scheduleCountdown(COUNTDOWN_HOLD_MS, () => {
      lights.forEach(light => { light.className = 'countdown-light'; });
      overlay.classList.remove('visible');
    });
  };

  if (now >= lightsOutAt) {
    go();
  } else {
    scheduleCountdown(lightsOutAt - now, go);
  }
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

  dailyFeaturedTrackId = getDailyFeaturedTrackId(TRACKS);
  const dailyTrackIndex = TRACKS.findIndex((track) => track.id === dailyFeaturedTrackId);
  if (dailyTrackIndex >= 0) selectedTrackIndex = dailyTrackIndex;

  // The UI must remain available even when a browser cannot initialise the
  // Phaser renderer (for example after a GPU/WebGL reset).  Initialising the
  // game first made that failure look like a blank application because none
  // of the menu handlers or the visible-screen state had been established.
  initUI();
  updateSessionConfig();
  refreshDriverProfileUI();
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
