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
  if (!isRaceActive) setRaceMode(false);
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
  if (topBar)    topBar.style.display    = enabled ? 'none' : '';
  if (bottomNav) bottomNav.style.display = enabled ? 'none' : '';

  // Orientation locking is supported by installed/PWA-capable browsers. The
  // layout remains fully usable when a browser declines the request.
  if (screen.orientation?.lock) {
    if (enabled) {
      screen.orientation.lock('landscape').catch(() => {});
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
function drawCarPreview(canvas, color, accentColor) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

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

  ctx.save();
  ctx.scale(2, 2);

  // 1. Rear suspension arms
  ctx.strokeStyle = '#525252';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(36, 4); ctx.lineTo(34, 9);
  ctx.moveTo(36, 24); ctx.lineTo(34, 19);
  ctx.stroke();

  // 2. Rear tires
  ctx.fillStyle = '#0a0a0a';
  roundRect(ctx, 32, 0, 10, 6, 1);
  roundRect(ctx, 32, 22, 10, 6, 1);
  ctx.fillStyle = '#d4d4d4';
  ctx.fillRect(36, 2, 2, 2);
  ctx.fillRect(36, 24, 2, 2);

  // 3. Front tires
  ctx.fillStyle = '#0a0a0a';
  roundRect(ctx, 8, 1, 9, 5, 1);
  roundRect(ctx, 8, 22, 9, 5, 1);
  ctx.fillStyle = '#d4d4d4';
  ctx.fillRect(12, 3, 2, 2);
  ctx.fillRect(12, 24, 2, 2);

  // 4. Front suspension arms
  ctx.strokeStyle = '#525252';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(12, 3); ctx.lineTo(18, 9);
  ctx.moveTo(12, 25); ctx.lineTo(18, 19);
  ctx.stroke();

  // 5. Front wing
  ctx.fillStyle = '#d4d4d4';
  ctx.fillRect(4, 2, 2, 24);
  ctx.fillStyle = '#171717';
  ctx.fillRect(1, 1, 5, 2);
  ctx.fillRect(1, 25, 5, 2);

  // 6. Nose cone
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(6, 14);
  ctx.lineTo(20, 9);
  ctx.lineTo(20, 19);
  ctx.closePath();
  ctx.fill();

  // 7. Chassis & sidepods
  ctx.fillStyle = color;
  roundRect(ctx, 18, 8, 20, 12, 3);
  ctx.fillStyle = '#171717';
  ctx.fillRect(20, 8, 5, 2);
  ctx.fillRect(20, 18, 5, 2);

  // 8. Cockpit & helmet
  ctx.fillStyle = '#0a0a0a';
  ctx.beginPath();
  ctx.arc(26, 14, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = accentColor;
  ctx.beginPath();
  ctx.arc(25, 14, 3, 0, Math.PI * 2);
  ctx.fill();

  // Halo
  ctx.strokeStyle = '#737373';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(26, 14, 4, 0, Math.PI * 2);
  ctx.stroke();

  // 9. Spine
  ctx.fillStyle = accentColor;
  ctx.fillRect(29, 13, 8, 2);

  // 10. Rear wing
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(38, 5, 4, 18);
  ctx.fillStyle = color;
  ctx.fillRect(36, 4, 7, 2);
  ctx.fillRect(36, 22, 7, 2);

  // Safety light
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(42, 13, 2, 2);

  ctx.restore();
}

function updateCarSelection() {
  const car = CARS[selectedCarIndex];
  document.getElementById('car-name').innerText = car.name;
  document.getElementById('car-desc').innerText = car.description;
  
  const previewCanvas = document.getElementById('car-preview-canvas');
  drawCarPreview(previewCanvas, car.color, car.accentColor);

  document.getElementById('stat-speed').style.width = `${(car.topSpeed / 340) * 100}%`;
  document.getElementById('stat-accel').style.width = `${(car.acceleration / 180) * 100}%`;
  document.getElementById('stat-handling').style.width = `${(car.handling / 5.2) * 100}%`;
  document.getElementById('stat-boost').style.width = `${(car.boostPower / 1.7) * 100}%`;

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
  document.getElementById('track-name').innerText = track.name;
  document.getElementById('track-desc').innerText = track.description;
  document.getElementById('track-difficulty').innerText = track.difficulty;
  document.getElementById('track-laps').innerText = `${track.laps} LAPS`;

  const canvas = document.getElementById('track-minimap');
  drawTrackMinimap(canvas, track);
}

function launchSelectedRace() {
  setRaceMode(true);
  showScreen('screen-hud');
  
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
    document.getElementById('hud-boost-fill').style.width = `${Math.max(0, Math.min(100, boostEnergy))}%`;
  });

  window.addEventListener('pixel-prix:finish', (e) => {
    lastRaceResult = e.detail;

    document.getElementById('go-raw-time').innerText = formatTime(lastRaceResult.rawTimeMs);
    document.getElementById('go-penalty-time').innerText = `+${(lastRaceResult.penaltyMs / 1000).toFixed(3)}s`;
    document.getElementById('go-final-time').innerText = formatTime(lastRaceResult.totalTimeMs);
    document.getElementById('go-best-lap').innerText = `Best Lap: ${formatTime(lastRaceResult.bestLapMs)}`;
    document.getElementById('submit-status').innerText = '';

    showScreen('screen-gameover');
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
    const dateStr = s.created_at ? new Date(s.created_at).toLocaleDateString('en-GB', { day:'2-digit', month:'2-digit', year:'2-digit' }).replace(/\//g, '.') : 'Today';
    const isFirst = idx === 0;
    return `
      <div class="lb-row${isFirst ? ' lb-row-first' : ''}">
        <div class="lb-row-pos">#${String(idx + 1).padStart(2, '0')}</div>
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

  // Top app bar settings (menu icon) opens settings screen
  bindClickOrTouch('btn-open-settings', openSettings);

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
  bindClickOrTouch('btn-retry-race', () => {
    launchSelectedRace();
  });

  bindClickOrTouch('btn-view-leaderboard-go', () => {
    const trackId = lastRaceResult?.trackId || TRACKS[0].id;
    renderLeaderboardTabs(trackId);
    watchLeaderboard(trackId);
    loadLeaderboard(trackId);
    showScreen('screen-leaderboard');
  });

  bindClickOrTouch('btn-gameover-menu', () => {
    if (phaserGame && phaserGame.scene.isActive('RaceScene')) {
      phaserGame.scene.stop('RaceScene');
    }
    showScreen('screen-menu');
  });

  // Score Submit Form
  const scoreForm = document.getElementById('score-form');
  if (scoreForm) {
    scoreForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('player-name-input');
      const statusMsg = document.getElementById('submit-status');
      const submitBtn = document.getElementById('btn-submit-score');

      const playerName = nameInput.value.trim();
      if (!playerName || !lastRaceResult) return;

      submitBtn.disabled = true;
      statusMsg.className = 'status-msg';
      statusMsg.innerText = 'Submitting time...';

      const result = await submitScore({
        playerName,
        carId: lastRaceResult.carId,
        trackId: lastRaceResult.trackId,
        timeMs: lastRaceResult.totalTimeMs
      });

      if (result.success) {
        statusMsg.className = 'status-msg success';
        statusMsg.innerText = 'TIME POSTED';
        setTimeout(() => {
          renderLeaderboardTabs(lastRaceResult.trackId);
          loadLeaderboard(lastRaceResult.trackId);
          showScreen('screen-leaderboard');
          submitBtn.disabled = false;
        }, 1200);
      } else {
        statusMsg.className = 'status-msg error';
        statusMsg.innerText = 'UNABLE TO POST TIME — TRY AGAIN';
        submitBtn.disabled = false;
      }
    });
  }

  // Leaderboard Refresh
  bindClickOrTouch('btn-refresh-lb', () => {
    const activeTab = document.querySelector('#lb-track-tabs .tab-btn.active');
    const trackId = activeTab ? activeTab.dataset.trackId : TRACKS[0].id;
    loadLeaderboard(trackId);
  });

  setupTouchControls();
  setupGameEventListeners();
}

// ----------------------------------------------------------------------------
// ENTRY POINT
// ----------------------------------------------------------------------------
function startApp() {
  initGame();
  initUI();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}
