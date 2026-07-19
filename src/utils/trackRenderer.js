import Phaser from 'phaser';

/**
 * Generates a perfectly closed, smoothly interpolated Catmull-Rom spline points list
 * with no kinks at start/finish and no overlapping segments.
 */
function getClosedSplinePoints(rawPoints, divisions = 220) {
  const n = rawPoints.length;
  const curvePoints = [];
  
  // Standard Catmull-Rom spline interpolation equation
  const interpolate = (p0, p1, p2, p3, t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    
    const f1 = -0.5 * t3 + t2 - 0.5 * t;
    const f2 = 1.5 * t3 - 2.5 * t2 + 1.0;
    const f3 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
    const f4 = 0.5 * t3 - 0.5 * t2;
    
    return {
      x: p0.x * f1 + p1.x * f2 + p2.x * f3 + p3.x * f4,
      y: p0.y * f1 + p1.y * f2 + p2.y * f3 + p3.y * f4
    };
  };
  
  const stepsPerSegment = Math.ceil(divisions / n);
  
  for (let i = 0; i < n; i++) {
    const p0 = rawPoints[(i - 1 + n) % n];
    const p1 = rawPoints[i];
    const p2 = rawPoints[(i + 1) % n];
    const p3 = rawPoints[(i + 2) % n];
    
    for (let s = 0; s < stepsPerSegment; s++) {
      const t = s / stepsPerSegment;
      curvePoints.push(interpolate(p0, p1, p2, p3, t));
    }
  }
  
  // Close the loop perfectly
  curvePoints.push({ x: curvePoints[0].x, y: curvePoints[0].y });
  return curvePoints;
}

/**
 * Procedurally draws the AAA-quality track onto Phaser Graphics objects.
 * Features: run-off zones, gradient asphalt, colored curb stripes, 
 * glowing S/F line, and rich center markings.
 */
export function renderTrackGraphics(scene, track) {
  const graphics = scene.add.graphics();
  const roadWidth = track.roadWidth;

  // Generate high-density spline points
  const curvePoints = getClosedSplinePoints(track.points, 280);
  
  // === BACKGROUND: Stylized vector grid ===
  graphics.lineStyle(1, 0x1a1828, 0.5);
  const gridSize = 80;
  for (let x = 0; x <= track.worldWidth; x += gridSize) {
    graphics.lineBetween(x, 0, x, track.worldHeight);
  }
  for (let y = 0; y <= track.worldHeight; y += gridSize) {
    graphics.lineBetween(0, y, track.worldWidth, y);
  }

  // Helper to draw thick path
  const drawPath = (gfx, styleWidth, styleColor, styleAlpha = 1) => {
    gfx.lineStyle(styleWidth, styleColor, styleAlpha);
    gfx.beginPath();
    for (let i = 0; i < curvePoints.length; i++) {
      const pt = curvePoints[i];
      if (i === 0) gfx.moveTo(pt.x, pt.y);
      else gfx.lineTo(pt.x, pt.y);
    }
    gfx.closePath();
    gfx.strokePath();
  };

  // === RUN-OFF ZONE (green/yellow grass outside curbs) ===
  drawPath(graphics, roadWidth + 60, 0x1a2e14, 1);  // outer green band
  drawPath(graphics, roadWidth + 48, 0x152310, 1);  // deeper green

  // === OUTER HAZARD STRIPES (checker pattern edge) ===
  // Alternating wide/narrow gray bands simulate concrete boundary
  drawPath(graphics, roadWidth + 28, 0x3a3848, 1);
  drawPath(graphics, roadWidth + 22, 0x1e1c2a, 1);

  // === COLORED CURB STRIPES (red-white alternating) ===
  // Outer curb
  for (let i = 0; i < curvePoints.length - 1; i++) {
    const segmentIndex = Math.floor(i * 20 / curvePoints.length);
    const isRedStripe = segmentIndex % 2 === 0;
    const pt = curvePoints[i];
    const nextPt = curvePoints[i + 1];
    const angle = Math.atan2(nextPt.y - pt.y, nextPt.x - pt.x) + Math.PI / 2;
    const outerDist = (roadWidth / 2) + 10;
    const curbWidth = 9;

    const curbColor = isRedStripe ? 0xe8002d : 0xffffff;
    graphics.lineStyle(curbWidth, curbColor, 0.85);
    graphics.lineBetween(
      pt.x + Math.cos(angle) * outerDist, pt.y + Math.sin(angle) * outerDist,
      nextPt.x + Math.cos(angle) * outerDist, nextPt.y + Math.sin(angle) * outerDist
    );
    // Inner curb (opposite color for contrast)
    const innerCurbColor = isRedStripe ? 0xffffff : 0xe8002d;
    graphics.lineStyle(curbWidth, innerCurbColor, 0.85);
    graphics.lineBetween(
      pt.x - Math.cos(angle) * outerDist, pt.y - Math.sin(angle) * outerDist,
      nextPt.x - Math.cos(angle) * outerDist, nextPt.y - Math.sin(angle) * outerDist
    );
  }

  // === MAIN ASPHALT ROAD — dark charcoal with subtle gradient ===
  // Deep shadow layer under road
  drawPath(graphics, roadWidth + 4, 0x0a0810, 1);
  // Main asphalt surface
  drawPath(graphics, roadWidth, 0x100e1a, 1);
  // Very subtle lighter asphalt for surface texture
  drawPath(graphics, roadWidth - 8, 0x121020, 0.6);
  // Road center highlight (worn rubber line)
  drawPath(graphics, 2, 0x1e1c2e, 0.8);

  // === CENTER DASHED LINE ===
  const centerDashes = getClosedSplinePoints(track.points, 160);
  for (let i = 0; i < centerDashes.length - 1; i += 2) {
    // Colored center dashes with slight glow
    graphics.lineStyle(3, 0xffffff, 0.35);
    graphics.lineBetween(
      centerDashes[i].x, centerDashes[i].y,
      centerDashes[i + 1].x, centerDashes[i + 1].y
    );
  }

  // === TIRE MARKS (baked into asphalt at corners) ===
  const tireDivisions = getClosedSplinePoints(track.points, 180);
  for (let i = 0; i < tireDivisions.length - 1; i++) {
    if (Math.random() < 0.05) {
      const pt = tireDivisions[i];
      const nextPt = tireDivisions[i + 1];
      const angle = Math.atan2(nextPt.y - pt.y, nextPt.x - pt.x) + Math.PI / 2;
      const offset = (Math.random() - 0.5) * (roadWidth * 0.4);
      const len = 12 + Math.random() * 20;
      graphics.lineStyle(2, 0x0a080e, 0.6);
      graphics.lineBetween(
        pt.x + Math.cos(angle) * offset, pt.y + Math.sin(angle) * offset,
        pt.x + Math.cos(angle) * offset + Math.cos(angle + Math.PI / 2) * len,
        pt.y + Math.sin(angle) * offset + Math.sin(angle + Math.PI / 2) * len
      );
    }
  }

  // === START / FINISH LINE — Glowing checkered gate ===
  const sfGraphics = scene.add.graphics();
  const start = track.points[1] || track.points[0];
  const next = track.points[2] || track.points[1];
  const sfAngle = Math.atan2(next.y - start.y, next.x - start.x) + Math.PI / 2;
  const halfW = roadWidth / 2;

  // White glow halo behind line
  sfGraphics.lineStyle(roadWidth + 4, 0xffffff, 0.06);
  sfGraphics.lineBetween(
    start.x + Math.cos(sfAngle) * halfW, start.y + Math.sin(sfAngle) * halfW,
    start.x - Math.cos(sfAngle) * halfW, start.y - Math.sin(sfAngle) * halfW
  );

  // Checkered segments (black and white)
  const numChecks = 10;
  for (let c = 0; c < numChecks; c++) {
    const t0 = (c / numChecks);
    const t1 = ((c + 1) / numChecks);
    const ox0 = halfW * (t0 * 2 - 1);
    const ox1 = halfW * (t1 * 2 - 1);
    const color = c % 2 === 0 ? 0xffffff : 0x080810;
    sfGraphics.lineStyle(8, color, 1.0);
    sfGraphics.lineBetween(
      start.x + Math.cos(sfAngle) * ox0, start.y + Math.sin(sfAngle) * ox0,
      start.x + Math.cos(sfAngle) * ox1, start.y + Math.sin(sfAngle) * ox1
    );
  }

  // Red accent stripe over the S/F line
  sfGraphics.lineStyle(3, 0xe8002d, 0.9);
  sfGraphics.lineBetween(
    start.x + Math.cos(sfAngle) * halfW, start.y + Math.sin(sfAngle) * halfW,
    start.x - Math.cos(sfAngle) * halfW, start.y - Math.sin(sfAngle) * halfW
  );

  // Return a mock curve object for Phaser compatibility
  const points = track.points.map(p => new Phaser.Math.Vector2(p.x, p.y));
  const spline = new Phaser.Curves.Spline(points);

  return { curve: spline, roadWidth, curvePoints };
}

/**
 * Draws an AAA minimap preview on an HTML5 canvas element for selection screen.
 * Features: glow outline, pulsing start dot, track name watermark.
 */
export function drawTrackMinimap(canvas, track) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // Compute bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  track.points.forEach(p => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });

  const margin = 14;
  const scaleX = (w - margin * 2) / (maxX - minX || 1);
  const scaleY = (h - margin * 2) / (maxY - minY || 1);
  const scale = Math.min(scaleX, scaleY);

  const offsetX = margin + (w - margin * 2 - (maxX - minX) * scale) / 2;
  const offsetY = margin + (h - margin * 2 - (maxY - minY) * scale) / 2;

  const mapX = (x) => offsetX + (x - minX) * scale;
  const mapY = (y) => offsetY + (y - minY) * scale;

  // Build path
  const rawPoints = track.points;
  const loopPoints = [...rawPoints, rawPoints[0]];
  
  const buildPath = () => {
    ctx.beginPath();
    loopPoints.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(mapX(p.x), mapY(p.y));
      else ctx.lineTo(mapX(p.x), mapY(p.y));
    });
    ctx.closePath();
  };

  // Outer glow aura
  buildPath();
  ctx.lineWidth = track.roadWidth * scale + 6;
  ctx.strokeStyle = 'rgba(232, 0, 45, 0.12)';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Run-off zone (green)
  buildPath();
  ctx.lineWidth = track.roadWidth * scale + 2;
  ctx.strokeStyle = 'rgba(20, 40, 15, 0.9)';
  ctx.stroke();

  // Main road surface
  buildPath();
  ctx.lineWidth = track.roadWidth * scale;
  ctx.strokeStyle = '#100e1a';
  ctx.stroke();

  // Bright centerline
  buildPath();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Start/Finish line (red)
  const sfP  = track.points[1] || track.points[0];
  const sfN  = track.points[2] || track.points[1];
  const sfAng = Math.atan2(sfN.y - sfP.y, sfN.x - sfP.x) + Math.PI / 2;
  const sfHW  = (track.roadWidth / 2) * scale;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#e8002d';
  ctx.shadowColor = '#e8002d';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.moveTo(mapX(sfP.x) + Math.cos(sfAng) * sfHW, mapY(sfP.y) + Math.sin(sfAng) * sfHW);
  ctx.lineTo(mapX(sfP.x) - Math.cos(sfAng) * sfHW, mapY(sfP.y) - Math.sin(sfAng) * sfHW);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Start dot — glowing pulse (animated via JS if needed, static here)
  const startP = track.points[0];
  const grad = ctx.createRadialGradient(
    mapX(startP.x), mapY(startP.y), 0,
    mapX(startP.x), mapY(startP.y), 6
  );
  grad.addColorStop(0, 'rgba(232, 0, 45, 1)');
  grad.addColorStop(0.5, 'rgba(232, 0, 45, 0.5)');
  grad.addColorStop(1, 'rgba(232, 0, 45, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(mapX(startP.x), mapY(startP.y), 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(mapX(startP.x), mapY(startP.y), 2.5, 0, Math.PI * 2);
  ctx.fill();
}
