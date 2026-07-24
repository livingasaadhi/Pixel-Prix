/**
 * Real Sampled Ultra-Deep V8 Sound Engine (Web Audio API).
 * Provides deep, smooth, throaty V8 exhaust rumble, warm dynamic filters,
 * tire squeals, boost whooshes, and checkpoint audio.
 */

const ENGINE_IDLE_GAIN = 0.12;
const ENGINE_MAX_GAIN = 0.26;

let audioCtx = null;
let isMuted = false;

// Audio Buffer & Source Nodes for Real Sampled F1 Engine
let f1EngineBuffer = null;
let engineSourceNode = null;
let engineGainNode = null;
let engineFilterNode = null;
let isLoadingBuffer = false;

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

/**
 * Loads and decodes the sampled deep V8 engine WAV recording
 */
async function loadEngineSample() {
  if (f1EngineBuffer || isLoadingBuffer) return;
  isLoadingBuffer = true;

  try {
    const res = await fetch('/sounds/f1_engine.wav');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    f1EngineBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } catch (err) {
    console.warn('Failed to load /sounds/f1_engine.wav, using procedural buffer:', err);
    createProceduralEngineBuffer();
  } finally {
    isLoadingBuffer = false;
  }
}

function createProceduralEngineBuffer() {
  if (!audioCtx || f1EngineBuffer) return;
  const sampleRate = audioCtx.sampleRate || 44100;
  const duration = 1.5;
  const numSamples = Math.floor(sampleRate * duration);
  const buffer = audioCtx.createBuffer(1, numSamples, sampleRate);
  const data = buffer.getChannelData(0);

  const fundFreq = 70.0;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const phase = (t * fundFreq) % 1.0;
    const angle = phase * 2 * Math.PI;

    let sample = 0.6 * Math.sin(angle)
      + 0.4 * Math.sin(0.5 * angle)
      + 0.25 * Math.sin(2 * angle + 0.1);

    data[i] = Math.max(-0.95, Math.min(0.95, sample * 0.5));
  }
  f1EngineBuffer = buffer;
}

/**
 * Calculates Deep Throaty V8 Playback Rate (Pitch Multiplier).
 * Tightly bounded between 0.92 (idle growl) and 1.08 (full speed power).
 */
function calculateSampledPlaybackRate(speedRatio) {
  const s = Math.max(0, Math.min(1.0, speedRatio));
  return 0.92 + s * 0.16; // Smooth 0.92x -> 1.08x range (never high pitched!)
}

export function startEngineSound() {
  initAudio();
  if (!audioCtx || isMuted) return;

  loadEngineSample().then(() => {
    if (!f1EngineBuffer || engineSourceNode) return;

    try {
      const now = audioCtx.currentTime;

      // 1. AudioBufferSourceNode for sampled deep V8 engine recording
      engineSourceNode = audioCtx.createBufferSource();
      engineSourceNode.buffer = f1EngineBuffer;
      engineSourceNode.loop = true;
      engineSourceNode.playbackRate.setValueAtTime(0.92, now);

      // 2. Warm Lowpass Exhaust Filter (capped at 1,200 Hz max to eliminate all squeaks)
      engineFilterNode = audioCtx.createBiquadFilter();
      engineFilterNode.type = 'lowpass';
      engineFilterNode.frequency.setValueAtTime(600, now);

      // 3. Master Engine Gain Node
      engineGainNode = audioCtx.createGain();
      engineGainNode.gain.setValueAtTime(ENGINE_IDLE_GAIN, now);

      // Pipeline Connection
      engineSourceNode.connect(engineFilterNode);
      engineFilterNode.connect(engineGainNode);
      engineGainNode.connect(audioCtx.destination);

      engineSourceNode.start(now);
    } catch (e) {
      console.warn('Start sampled engine sound failed:', e);
    }
  });
}

export function updateEnginePitch(speedRatio, isThrottle = true) {
  if (!audioCtx || !engineSourceNode || isMuted) return;

  const now = audioCtx.currentTime;
  const targetRate = calculateSampledPlaybackRate(speedRatio);

  // Modulate sampled audio playback pitch smoothly within tight deep bounds
  engineSourceNode.playbackRate.setTargetAtTime(targetRate, now, 0.05);

  // Warm lowpass filter (600 Hz idle -> 1,200 Hz top speed max)
  const filterFreq = 600 + speedRatio * 600;
  engineFilterNode.frequency.setTargetAtTime(filterFreq, now, 0.06);

  // Volume scaling
  const targetGain = isThrottle
    ? ENGINE_IDLE_GAIN + (speedRatio * (ENGINE_MAX_GAIN - ENGINE_IDLE_GAIN))
    : ENGINE_IDLE_GAIN * 0.5;

  engineGainNode.gain.setTargetAtTime(targetGain, now, 0.06);
}

export function setEngineActive(active) {
  if (!audioCtx || !engineGainNode) return;
  const now = audioCtx.currentTime;
  const target = active ? ENGINE_IDLE_GAIN : 0.001;
  engineGainNode.gain.cancelScheduledValues(now);
  engineGainNode.gain.setTargetAtTime(target, now, 0.05);
}

export function stopEngineSound() {
  if (engineSourceNode) {
    try {
      engineSourceNode.stop();
      engineSourceNode.disconnect();
    } catch (e) {}
    engineSourceNode = null;
  }
}

export function playBoostSound() {
  initAudio();
  if (!audioCtx || isMuted) return;

  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1000, audioCtx.currentTime + 0.35);

    gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.35);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.35);
  } catch (e) {}
}

export function playCheckpointSound() {
  initAudio();
  if (!audioCtx || isMuted) return;

  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(523.25, audioCtx.currentTime);
    osc.frequency.setValueAtTime(659.25, audioCtx.currentTime + 0.08);
    osc.frequency.setValueAtTime(783.99, audioCtx.currentTime + 0.16);

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
