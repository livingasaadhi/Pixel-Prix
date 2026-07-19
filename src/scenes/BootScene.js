import Phaser from 'phaser';
import { CARS } from '../data/cars.js';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  create() {
    // Generate open-wheel F1 car textures at 2x resolution with three steering states
    CARS.forEach(car => {
      this.generateCarTexture(car, 'straight', 0);
      this.generateCarTexture(car, 'left', -0.32);
      this.generateCarTexture(car, 'right', 0.32);
    });

    // Generate enriched particle textures
    this.generateParticleTextures();

    console.log('BootScene: All AAA textures generated.');
  }

  /**
   * Generates a detailed 2x-resolution open-wheel F1 car texture.
   * Each car has a unique livery paint scheme with glossy highlights.
   */
  generateCarTexture(car, steeringState, wheelAngle) {
    // 2x resolution for crispness
    const w = 96;
    const h = 56;
    const key = `car_${car.id}_${steeringState}`;

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    // Work at 2x scale for pixel-perfect rendering
    ctx.save();
    ctx.scale(2, 2);
    // After scale, working in 48×28 units (original car dimensions)
    const W = 48, H = 28;
    const cx = W / 2, cy = H / 2;

    const bodyColor  = car.color;
    const accentColor = car.accentColor;

    // Helper: rounded rect fill
    const roundRect = (x, y, rw, rh, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + rw - r, y);
      ctx.quadraticCurveTo(x + rw, y, x + rw, y + r);
      ctx.lineTo(x + rw, y + rh - r);
      ctx.quadraticCurveTo(x + rw, y + rh, x + rw - r, y + rh);
      ctx.lineTo(x + r, y + rh);
      ctx.quadraticCurveTo(x, y + rh, x, y + rh - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
      ctx.fill();
    };

    // ── 1. REAR TIRES ────────────────────────────────────────────────
    // Outer tire rubber
    ctx.fillStyle = '#0d0c10';
    roundRect(32, 0, 10, 6, 1.5);
    roundRect(32, 22, 10, 6, 1.5);
    // Tire wall grooves
    ctx.strokeStyle = '#1e1c28';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(33, 3); ctx.lineTo(41, 3);
    ctx.moveTo(33, 25); ctx.lineTo(41, 25);
    ctx.stroke();
    // Tire rim (metallic silver)
    ctx.fillStyle = '#c8c4d4';
    roundRect(35, 1, 5, 4, 0.5);
    roundRect(35, 23, 5, 4, 0.5);
    ctx.fillStyle = '#5a5875';
    ctx.fillRect(36, 2, 3, 2);
    ctx.fillRect(36, 24, 3, 2);
    // Tire brand line
    ctx.fillStyle = '#ff6b00';
    ctx.fillRect(33, 2, 1, 2);
    ctx.fillRect(33, 24, 1, 2);

    // ── 2. REAR SUSPENSION ARMS ────────────────────────────────────
    ctx.strokeStyle = '#5a5875';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(36, 4); ctx.lineTo(34, 9);
    ctx.moveTo(36, 24); ctx.lineTo(34, 19);
    ctx.stroke();

    // ── 3. FRONT TIRES (rotated by steering state) ─────────────────
    this.drawRotatedWheel(ctx, 8, 2, 9, 5, wheelAngle, accentColor);
    this.drawRotatedWheel(ctx, 8, 21, 9, 5, wheelAngle, accentColor);

    // ── 4. FRONT SUSPENSION ARMS ────────────────────────────────────
    ctx.strokeStyle = '#5a5875';
    ctx.lineWidth = 1.5;
    const armOffset = steeringState === 'left' ? -1 : steeringState === 'right' ? 1 : 0;
    ctx.beginPath();
    ctx.moveTo(12 + armOffset, 4); ctx.lineTo(18, 9);
    ctx.moveTo(12 - armOffset, 24); ctx.lineTo(18, 19);
    ctx.stroke();

    // ── 5. FRONT WING ASSEMBLY (multi-element) ──────────────────────
    // Endplates
    ctx.fillStyle = '#e8e8f0';
    ctx.fillRect(3, 1, 3, 26);
    // Main plane
    ctx.fillStyle = bodyColor;
    ctx.fillRect(4, 3, 2, 22);
    // DRS upper flap
    ctx.fillStyle = this.lighten(bodyColor, 0.3);
    ctx.fillRect(3, 4, 2, 3);
    ctx.fillRect(3, 21, 2, 3);
    // Endplate details
    ctx.fillStyle = '#1e1c28';
    ctx.fillRect(1, 1, 4, 2);
    ctx.fillRect(1, 25, 4, 2);
    // Livery stripe on wing
    ctx.fillStyle = accentColor;
    ctx.fillRect(2, 2, 1, 2);
    ctx.fillRect(2, 24, 1, 2);

    // ── 6. NOSE CONE ────────────────────────────────────────────────
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.moveTo(5, 14);
    ctx.lineTo(20, 8);
    ctx.lineTo(20, 20);
    ctx.closePath();
    ctx.fill();
    // Nose tip highlight
    const noseTipGrad = ctx.createLinearGradient(5, 10, 5, 18);
    noseTipGrad.addColorStop(0, 'rgba(255,255,255,0.22)');
    noseTipGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = noseTipGrad;
    ctx.beginPath();
    ctx.moveTo(5, 14);
    ctx.lineTo(18, 9);
    ctx.lineTo(18, 14);
    ctx.closePath();
    ctx.fill();

    // ── 7. MAIN MONOCOQUE CHASSIS ───────────────────────────────────
    ctx.fillStyle = bodyColor;
    roundRect(18, 8, 20, 12, 3);

    // Radiator side inlets / side pod vents
    ctx.fillStyle = '#0d0c10';
    roundRect(20, 8, 6, 3, 1);
    roundRect(20, 17, 6, 3, 1);

    // Livery paint scheme — per-car sidepod stripes
    this.drawLivery(ctx, car, 22, 9, 14, 10);

    // Glossy top highlight (fresnel effect)
    const chassisGloss = ctx.createLinearGradient(18, 8, 18, 20);
    chassisGloss.addColorStop(0, 'rgba(255,255,255,0.18)');
    chassisGloss.addColorStop(0.4, 'rgba(255,255,255,0.04)');
    chassisGloss.addColorStop(1, 'rgba(0,0,0,0.1)');
    ctx.fillStyle = chassisGloss;
    roundRect(18, 8, 20, 12, 3);

    // Chassis edge shadow
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(18, 20); ctx.lineTo(38, 20);
    ctx.stroke();

    // ── 8. COCKPIT / DRIVER HELMET / HALO ────────────────────────────
    // Cockpit opening
    ctx.fillStyle = '#0a0810';
    ctx.beginPath();
    ctx.arc(26, 14, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // Halo roll structure
    ctx.strokeStyle = '#8a8898';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(26, 14, 4.8, Math.PI * 0.8, Math.PI * 2.2);
    ctx.stroke();
    // Halo pillar
    ctx.strokeStyle = '#9898a8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(26, 14); ctx.lineTo(28, 10.5);
    ctx.stroke();

    // Helmet visor (metallic)
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.arc(25, 14, 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Visor reflective strip
    const visorGloss = ctx.createLinearGradient(22, 11, 26, 14);
    visorGloss.addColorStop(0, 'rgba(255,255,255,0.35)');
    visorGloss.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = visorGloss;
    ctx.beginPath();
    ctx.arc(24, 12, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // ── 9. REAR ENGINE COVER SPINE ───────────────────────────────────
    ctx.fillStyle = accentColor;
    ctx.fillRect(29, 12.5, 8, 3);
    // Spine highlight
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(29, 12.5, 8, 1);

    // ── 10. REAR WING ────────────────────────────────────────────────
    // Main plane (dark carbon)
    ctx.fillStyle = '#0d0c10';
    ctx.fillRect(38, 4, 5, 20);
    // Upper flap (colored)
    ctx.fillStyle = bodyColor;
    ctx.fillRect(36, 3, 8, 3);
    ctx.fillRect(36, 22, 8, 3);
    // Endplates with livery
    ctx.fillStyle = accentColor;
    ctx.fillRect(40, 4, 2, 2);
    ctx.fillRect(40, 22, 2, 2);
    // DRS actuator
    ctx.fillStyle = '#5a5875';
    ctx.fillRect(40, 10, 1, 8);

    // ── 11. SAFETY RAIN LIGHT ───────────────────────────────────────
    // Animated-style tri-LED
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(42, 12, 2, 2);
    ctx.fillStyle = 'rgba(255,100,0,0.6)';
    ctx.fillRect(43, 11, 1, 4);

    ctx.restore(); // end 2x scale

    // Register as Phaser texture
    if (this.textures.exists(key)) this.textures.remove(key);
    this.textures.addCanvas(key, canvas);
  }

  /**
   * Draws per-car livery paint scheme in the sidepod area.
   * Each car team has unique stripe patterns.
   */
  drawLivery(ctx, car, x, y, w, h) {
    const id = car.id;
    const accent = car.accentColor;

    if (id === 'scuderia-furiosa') {
      // Scuderia — yellow chevrons on red
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(x, y + h * 0.3);
      ctx.lineTo(x + w * 0.4, y);
      ctx.lineTo(x + w * 0.6, y);
      ctx.lineTo(x + w * 0.2, y + h * 0.3);
      ctx.closePath();
      ctx.fill();
    } else if (id === 'blue-bull') {
      // Blue Bull — red diagonal bars
      ctx.fillStyle = accent;
      ctx.fillRect(x + w * 0.5, y, w * 0.08, h);
      ctx.fillRect(x + w * 0.7, y, w * 0.08, h);
    } else if (id === 'silver-arrows') {
      // Silver Arrows — cyan teal stripe
      ctx.fillStyle = accent;
      ctx.fillRect(x, y + h * 0.4, w, h * 0.18);
    } else if (id === 'papaya-express') {
      // Papaya — blue diagonal corner
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.6, y);
      ctx.lineTo(x + w, y);
      ctx.lineTo(x + w, y + h * 0.5);
      ctx.closePath();
      ctx.fill();
    } else if (id === 'green-emerald') {
      // Green Emerald — neon lime edge stripe
      ctx.fillStyle = accent;
      ctx.fillRect(x, y, w, h * 0.12);
      ctx.fillRect(x, y + h * 0.88, w, h * 0.12);
    } else if (id === 'alpen-glow') {
      // Alpen Glow — cyan split diagonal
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w * 0.45, y);
      ctx.lineTo(x + w * 0.25, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      ctx.fill();
    }
  }

  /**
   * Lightens a hex color string by a factor (0-1).
   */
  lighten(hex, factor) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, ((num >> 16) & 0xff) + Math.round(255 * factor));
    const g = Math.min(255, ((num >> 8)  & 0xff) + Math.round(255 * factor));
    const b = Math.min(255, ( num        & 0xff) + Math.round(255 * factor));
    return `rgb(${r},${g},${b})`;
  }

  /**
   * Draws a rotated wheel with tire detail and branded sidewall stripe.
   */
  drawRotatedWheel(ctx, x, y, width, height, angle, accentColor) {
    const cx = x + width / 2;
    const cy = y + height / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // Tire rubber body
    ctx.fillStyle = '#0d0c10';
    const r = Math.min(width, height) / 2;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-width/2, -height/2, width, height, 1.5) : ctx.rect(-width/2, -height/2, width, height);
    ctx.fill();

    // Tire brand orange stripe
    ctx.fillStyle = '#ff6b00';
    ctx.fillRect(-width/2, -height/2, 1.5, height);

    // Metallic rim
    ctx.fillStyle = '#c8c4d4';
    ctx.fillRect(-2, -2, 4, 4);
    ctx.fillStyle = '#5a5875';
    ctx.fillRect(-1, -1, 2, 2);

    ctx.restore();
  }

  /**
   * Generates enriched particle textures for smoke, sparks, and boost exhaust.
   */
  generateParticleTextures() {
    // ── Smoke particle ──
    const smokeCanvas = document.createElement('canvas');
    smokeCanvas.width = 16;
    smokeCanvas.height = 16;
    const sCtx = smokeCanvas.getContext('2d');
    const smokeGrad = sCtx.createRadialGradient(8, 8, 0, 8, 8, 8);
    smokeGrad.addColorStop(0, 'rgba(200, 195, 220, 0.9)');
    smokeGrad.addColorStop(0.5, 'rgba(140, 135, 160, 0.5)');
    smokeGrad.addColorStop(1, 'rgba(80, 75, 100, 0)');
    sCtx.fillStyle = smokeGrad;
    sCtx.beginPath();
    sCtx.arc(8, 8, 8, 0, Math.PI * 2);
    sCtx.fill();
    if (this.textures.exists('smoke_particle')) this.textures.remove('smoke_particle');
    this.textures.addCanvas('smoke_particle', smokeCanvas);

    // ── Spark particle (orange/white cross burst) ──
    const sparkCanvas = document.createElement('canvas');
    sparkCanvas.width = 12;
    sparkCanvas.height = 12;
    const spCtx = sparkCanvas.getContext('2d');
    // Center glow
    const sparkGrad = spCtx.createRadialGradient(6, 6, 0, 6, 6, 6);
    sparkGrad.addColorStop(0, 'rgba(255, 255, 200, 1)');
    sparkGrad.addColorStop(0.3, 'rgba(255, 140, 0, 0.9)');
    sparkGrad.addColorStop(1, 'rgba(255, 60, 0, 0)');
    spCtx.fillStyle = sparkGrad;
    spCtx.beginPath();
    spCtx.arc(6, 6, 6, 0, Math.PI * 2);
    spCtx.fill();
    if (this.textures.exists('spark_particle')) this.textures.remove('spark_particle');
    this.textures.addCanvas('spark_particle', sparkCanvas);

    // ── Boost exhaust streak (cyan/blue) ──
    const boostCanvas = document.createElement('canvas');
    boostCanvas.width = 20;
    boostCanvas.height = 8;
    const bCtx = boostCanvas.getContext('2d');
    const boostGrad = bCtx.createLinearGradient(0, 4, 20, 4);
    boostGrad.addColorStop(0, 'rgba(0, 210, 255, 0)');
    boostGrad.addColorStop(0.3, 'rgba(0, 210, 255, 0.8)');
    boostGrad.addColorStop(0.7, 'rgba(80, 240, 255, 0.9)');
    boostGrad.addColorStop(1, 'rgba(255, 255, 255, 1)');
    bCtx.fillStyle = boostGrad;
    bCtx.fillRect(0, 2, 20, 4);
    if (this.textures.exists('boost_particle')) this.textures.remove('boost_particle');
    this.textures.addCanvas('boost_particle', boostCanvas);

    // ── Skid mark ──
    const skidCanvas = document.createElement('canvas');
    skidCanvas.width = 6;
    skidCanvas.height = 6;
    const kCtx = skidCanvas.getContext('2d');
    kCtx.fillStyle = 'rgba(20, 18, 30, 0.75)';
    kCtx.fillRect(0, 0, 6, 6);
    if (this.textures.exists('skid_mark')) this.textures.remove('skid_mark');
    this.textures.addCanvas('skid_mark', skidCanvas);
  }
}
