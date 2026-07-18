import Phaser from 'phaser';
import { CARS } from '../data/cars.js';

export class BootScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BootScene' });
  }

  create() {
    // Generate open-wheel F1 car textures with three steering states
    CARS.forEach(car => {
      this.generateCarTexture(car, 'straight', 0);
      this.generateCarTexture(car, 'left', -0.3);
      this.generateCarTexture(car, 'right', 0.3);
    });

    // Generate particle textures
    this.generateParticleTextures();

    console.log('BootScene: All textures generated.');
  }

  generateCarTexture(car, steeringState, wheelAngle) {
    const w = 48;
    const h = 28;
    const key = `car_${car.id}_${steeringState}`;
    const cx = w / 2; // 24
    const cy = h / 2; // 14

    // Use an offscreen HTML5 Canvas for full transform support
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    const bodyColor = car.color;
    const accentColor = car.accentColor;

    // -- 1. REAR TIRES (fixed, no rotation) --
    ctx.fillStyle = '#0a0a0a';
    this.roundRect(ctx, 32, 0, 10, 6, 1);  // rear-left
    this.roundRect(ctx, 32, 22, 10, 6, 1); // rear-right
    // tire rim dots
    ctx.fillStyle = '#d4d4d4';
    ctx.fillRect(36, 2, 2, 2);
    ctx.fillRect(36, 24, 2, 2);

    // -- 2. REAR SUSPENSION ARMS --
    ctx.strokeStyle = '#525252';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(36, 4); ctx.lineTo(34, 9);
    ctx.moveTo(36, 24); ctx.lineTo(34, 19);
    ctx.stroke();

    // -- 3. FRONT TIRES (rotated based on steeringState) --
    // Left front wheel
    this.drawRotatedWheel(ctx, 12, 3, 9, 5, wheelAngle);
    // Right front wheel
    this.drawRotatedWheel(ctx, 12, 22, 9, 5, wheelAngle);

    // -- 4. FRONT SUSPENSION ARMS --
    ctx.strokeStyle = '#525252';
    ctx.lineWidth = 1.5;
    const armOffset = steeringState === 'left' ? -1 : steeringState === 'right' ? 1 : 0;
    ctx.beginPath();
    ctx.moveTo(12 + armOffset, 3); ctx.lineTo(18, 9);
    ctx.moveTo(12 - armOffset, 25); ctx.lineTo(18, 19);
    ctx.stroke();

    // -- 5. FRONT WING ASSEMBLY --
    ctx.fillStyle = '#d4d4d4';
    ctx.fillRect(4, 2, 2, 24); // main wing plane
    ctx.fillStyle = '#171717';
    ctx.fillRect(1, 1, 5, 2);   // left endplate
    ctx.fillRect(1, 25, 5, 2);  // right endplate

    // -- 6. NOSE CONE (Triangle) --
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.moveTo(6, 14);
    ctx.lineTo(20, 9);
    ctx.lineTo(20, 19);
    ctx.closePath();
    ctx.fill();

    // -- 7. MAIN MONOCOQUE CHASSIS --
    ctx.fillStyle = bodyColor;
    this.roundRect(ctx, 18, 8, 20, 12, 3);

    // Radiator vents
    ctx.fillStyle = '#171717';
    ctx.fillRect(20, 8, 5, 2);
    ctx.fillRect(20, 18, 5, 2);

    // -- 8. COCKPIT, DRIVER HELMET, HALO --
    ctx.fillStyle = '#0a0a0a';
    ctx.beginPath();
    ctx.arc(26, 14, 4.5, 0, Math.PI * 2);
    ctx.fill();

    // Helmet
    ctx.fillStyle = accentColor;
    ctx.beginPath();
    ctx.arc(25, 14, 3, 0, Math.PI * 2);
    ctx.fill();

    // Halo arch
    ctx.strokeStyle = '#737373';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(26, 14, 4, 0, Math.PI * 2);
    ctx.stroke();

    // -- 9. REAR ENGINE COVER SPINE --
    ctx.fillStyle = accentColor;
    ctx.fillRect(29, 13, 8, 2);

    // -- 10. REAR WING --
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(38, 5, 4, 18); // main wing plane
    ctx.fillStyle = bodyColor;
    ctx.fillRect(36, 4, 7, 2);  // left endplate
    ctx.fillRect(36, 22, 7, 2); // right endplate

    // Safety rain light
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(42, 13, 2, 2);

    // Register as Phaser texture from the canvas
    if (this.textures.exists(key)) {
      this.textures.remove(key);
    }
    this.textures.addCanvas(key, canvas);
  }

  drawRotatedWheel(ctx, x, y, width, height, angle) {
    const cx = x + width / 2;
    const cy = y + height / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    // Wheel body
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(-width / 2, -height / 2, width, height);
    // Wheel rim dot
    ctx.fillStyle = '#d4d4d4';
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  }

  generateParticleTextures() {
    // Smoke particle
    const smokeCanvas = document.createElement('canvas');
    smokeCanvas.width = 8;
    smokeCanvas.height = 8;
    const sCtx = smokeCanvas.getContext('2d');
    sCtx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    sCtx.beginPath();
    sCtx.arc(4, 4, 4, 0, Math.PI * 2);
    sCtx.fill();
    if (this.textures.exists('smoke_particle')) this.textures.remove('smoke_particle');
    this.textures.addCanvas('smoke_particle', smokeCanvas);

    // Skid mark
    const skidCanvas = document.createElement('canvas');
    skidCanvas.width = 6;
    skidCanvas.height = 6;
    const kCtx = skidCanvas.getContext('2d');
    kCtx.fillStyle = 'rgba(23, 23, 23, 0.7)';
    kCtx.fillRect(0, 0, 6, 6);
    if (this.textures.exists('skid_mark')) this.textures.remove('skid_mark');
    this.textures.addCanvas('skid_mark', skidCanvas);
  }
}
