import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const soundsDir = path.join(__dirname, '..', 'public', 'sounds');
if (!fs.existsSync(soundsDir)) {
  fs.mkdirSync(soundsDir, { recursive: true });
}

const sampleRate = 44100;
const duration = 2.0;
const numSamples = Math.floor(sampleRate * duration);

// Deep 70 Hz low-frequency V8 idle growl
const fundFreq = 70.0; 

const buffer = new Int16Array(numSamples);

for (let i = 0; i < numSamples; i++) {
  const t = i / sampleRate;
  const phase = (t * fundFreq) % 1.0;
  const angle = phase * 2 * Math.PI;

  // Rich V8 Low-Frequency Harmonics (Sub-bass emphasis, no high screeches)
  let sample = 0.60 * Math.sin(angle)                 // 70 Hz Sub-bass
    + 0.40 * Math.sin(0.5 * angle)                    // 35 Hz Sub-harmonic
    + 0.25 * Math.sin(2 * angle + 0.1)               // 140 Hz Exhaust pulse
    + 0.10 * Math.sin(3 * angle + 0.3);              // 210 Hz Warm mid-tone

  sample = Math.max(-0.95, Math.min(0.95, sample * 0.55));
  buffer[i] = Math.floor(sample * 32767);
}

// Seamless Equal-Power Crossfade Loop
const crossfadeLen = Math.floor(sampleRate * 0.1);
for (let i = 0; i < crossfadeLen; i++) {
  const alpha = i / crossfadeLen;
  const sampleStart = buffer[i] / 32767.0;
  const sampleEnd = buffer[numSamples - crossfadeLen + i] / 32767.0;
  const blended = sampleStart * Math.sin(alpha * Math.PI / 2) + sampleEnd * Math.cos(alpha * Math.PI / 2);
  buffer[i] = Math.floor(Math.max(-0.95, Math.min(0.95, blended)) * 32767);
}

// Encode 16-bit Mono WAV File
const wavHeader = Buffer.alloc(44);
const dataSize = buffer.length * 2;

wavHeader.write('RIFF', 0);
wavHeader.writeUInt32LE(36 + dataSize, 4);
wavHeader.write('WAVE', 8);
wavHeader.write('fmt ', 12);
wavHeader.writeUInt32LE(16, 16);
wavHeader.writeUInt16LE(1, 20);
wavHeader.writeUInt16LE(1, 22);
wavHeader.writeUInt32LE(sampleRate, 24);
wavHeader.writeUInt32LE(sampleRate * 2, 28);
wavHeader.writeUInt16LE(2, 32);
wavHeader.writeUInt16LE(16, 34);
wavHeader.write('data', 36);
wavHeader.writeUInt32LE(dataSize, 40);

const pcmBuffer = Buffer.from(buffer.buffer);
const finalWav = Buffer.concat([wavHeader, pcmBuffer]);

const outputPath = path.join(soundsDir, 'f1_engine.wav');
fs.writeFileSync(outputPath, finalWav);

console.log(`Successfully generated ultra-deep V8 engine audio at ${outputPath}`);
