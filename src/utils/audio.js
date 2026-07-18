/**
 * Web Audio API procedural sound synthesizer.
 * Provides engine acceleration sound, tire squeal, boost energy whoosh, and checkpoint chimes.
 */

const ENGINE_IDLE_GAIN = 0.04;

let audioCtx = null;
let engineOsc = null;
let engineGain = null;
let isMuted = false;

function initAudio() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      audioCtx = new AudioContext();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

export function startEngineSound() {
  initAudio();
  if (!audioCtx || engineOsc || isMuted) return;

  try {
    engineOsc = audioCtx.createOscillator();
    engineGain = audioCtx.createGain();

    engineOsc.type = 'sawtooth';
    engineOsc.frequency.setValueAtTime(60, audioCtx.currentTime);

    engineGain.gain.setValueAtTime(ENGINE_IDLE_GAIN, audioCtx.currentTime);

    engineOsc.connect(engineGain);
    engineGain.connect(audioCtx.destination);

    engineOsc.start();
  } catch (e) {
    console.warn('Engine sound init failed:', e);
  }
}

export function updateEnginePitch(speedRatio) {
  if (!audioCtx || !engineOsc || isMuted) return;
  const targetFreq = 50 + speedRatio * 220; // 50Hz idle to 270Hz top speed
  engineOsc.frequency.setTargetAtTime(targetFreq, audioCtx.currentTime, 0.05);
}

// Smoothly mute/unmute the running engine oscillator. The engine drone should
// only be audible while the car is actively accelerating; otherwise its gain
// is ramped to (near) zero so no background sound plays when coasting/braking.
export function setEngineActive(active) {
  if (!audioCtx || !engineGain) return;
  const now = audioCtx.currentTime;
  const target = active ? ENGINE_IDLE_GAIN : 0.0001;
  engineGain.gain.cancelScheduledValues(now);
  engineGain.gain.setTargetAtTime(target, now, 0.05);
}

export function stopEngineSound() {
  if (engineOsc) {
    try {
      engineOsc.stop();
      engineOsc.disconnect();
    } catch (e) {}
    engineOsc = null;
  }
}

export function playBoostSound() {
  initAudio();
  if (!audioCtx || isMuted) return;

  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(150, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(600, audioCtx.currentTime + 0.3);

    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.3);
  } catch (e) {}
}

export function playCheckpointSound() {
  initAudio();
  if (!audioCtx || isMuted) return;

  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(523.25, audioCtx.currentTime); // C5
    osc.frequency.setValueAtTime(659.25, audioCtx.currentTime + 0.08); // E5
    osc.frequency.setValueAtTime(783.99, audioCtx.currentTime + 0.16); // G5

    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.3);
  } catch (e) {}
}

export function playFinishSound() {
  initAudio();
  if (!audioCtx || isMuted) return;

  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(440, audioCtx.currentTime);
    osc.frequency.setValueAtTime(880, audioCtx.currentTime + 0.15);

    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.5);
  } catch (e) {}
}
