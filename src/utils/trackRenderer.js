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
  
  // Close the loop perfectly by linking back to the first point coordinate
  curvePoints.push({ x: curvePoints[0].x, y: curvePoints[0].y });
  return curvePoints;
}

/**
 * Procedurally draws the track onto Phaser Graphics objects or HTML5 Canvas.
 * Styled in high-contrast monochrome vector-grid F1 aesthetic.
 */
export function renderTrackGraphics(scene, track) {
  const graphics = scene.add.graphics();
  
  // 1. Draw stylized background vector grid lines (Retro-Futuristic Mesh)
  graphics.lineStyle(1.5, 0x1f1f1f, 0.4);
  const gridSize = 80;
  for (let x = 0; x < track.worldWidth; x += gridSize) {
    graphics.lineBetween(x, 0, x, track.worldHeight);
  }
  for (let y = 0; y < track.worldHeight; y += gridSize) {
    graphics.lineBetween(0, y, track.worldWidth, y);
  }

  // Generate 240 high-density points along a perfectly closed spline
  const curvePoints = getClosedSplinePoints(track.points, 240);
  const roadWidth = track.roadWidth;

  // Function to draw smooth thick path from point array
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

  // 2. Draw Track Border / High-contrast Black & White Hazard Stripes
  drawPath(graphics, roadWidth + 14, 0x404040, 1);
  drawPath(graphics, roadWidth + 8, 0x171717, 1);

  // Draw checkered/dashed hash border markings along track edges
  graphics.lineStyle(4, 0x8a8a8a, 0.7);
  for (let i = 0; i < curvePoints.length - 1; i += 3) {
    // Draw perpendicular edge ticks representing sport curbs
    const pt = curvePoints[i];
    const nextPt = curvePoints[i + 1];
    const angle = Math.atan2(nextPt.y - pt.y, nextPt.x - pt.x) + Math.PI / 2;
    const dist = (roadWidth / 2) + 5;

    graphics.lineBetween(
      pt.x + Math.cos(angle) * dist, pt.y + Math.sin(angle) * dist,
      pt.x + Math.cos(angle) * (dist + 4), pt.y + Math.sin(angle) * (dist + 4)
    );
    graphics.lineBetween(
      pt.x - Math.cos(angle) * dist, pt.y - Math.sin(angle) * dist,
      pt.x - Math.cos(angle) * (dist + 4), pt.y - Math.sin(angle) * (dist + 4)
    );
  }

  // 3. Draw Main Dark Asphalt Road Corridor
  drawPath(graphics, roadWidth, 0x0c0c0c, 1);

  // 4. Draw Center Dashed Line (Perfect, equally spaced dashes along the spline)
  const centerDashes = getClosedSplinePoints(track.points, 130);
  graphics.lineStyle(3, 0x737373, 0.6);
  for (let i = 0; i < centerDashes.length - 1; i += 2) {
    graphics.lineBetween(
      centerDashes[i].x, centerDashes[i].y,
      centerDashes[i + 1].x, centerDashes[i + 1].y
    );
  }

  // 5. Draw Start / Finish Checkered Gate Line
  const start = track.points[1] || track.points[0];
  const next = track.points[2] || track.points[1];
  const angle = Math.atan2(next.y - start.y, next.x - start.x) + Math.PI / 2;
  const halfW = roadWidth / 2;

  const sfGraphics = scene.add.graphics();
  sfGraphics.lineStyle(10, 0xffffff, 1);
  sfGraphics.lineBetween(
    start.x + Math.cos(angle) * halfW, start.y + Math.sin(angle) * halfW,
    start.x - Math.cos(angle) * halfW, start.y - Math.sin(angle) * halfW
  );
  sfGraphics.lineStyle(5, 0x050505, 1);
  sfGraphics.lineBetween(
    start.x + Math.cos(angle) * halfW, start.y + Math.sin(angle) * halfW,
    start.x - Math.cos(angle) * halfW, start.y - Math.sin(angle) * halfW
  );

  // Return a mock curve object for Phaser compatibility
  const points = track.points.map(p => new Phaser.Math.Vector2(p.x, p.y));
  const spline = new Phaser.Curves.Spline(points);

  return { curve: spline, roadWidth, curvePoints };
}

/**
 * Draws a minimap preview on an HTML5 canvas element for selection screen
 */
export function drawTrackMinimap(canvas, track) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // Calculate bounding box and scale factor
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  track.points.forEach(p => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });

  const margin = 20;
  const scaleX = (w - margin * 2) / (maxX - minX || 1);
  const scaleY = (h - margin * 2) / (maxY - minY || 1);
  const scale = Math.min(scaleX, scaleY);

  const offsetX = margin + (w - margin * 2 - (maxX - minX) * scale) / 2;
  const offsetY = margin + (h - margin * 2 - (maxY - minY) * scale) / 2;

  const mapX = (x) => offsetX + (x - minX) * scale;
  const mapY = (y) => offsetY + (y - minY) * scale;

  // Sample points for smooth closed minimap curve
  const rawPoints = track.points;
  const loopPoints = [...rawPoints, rawPoints[0]];

  ctx.beginPath();
  loopPoints.forEach((p, idx) => {
    if (idx === 0) ctx.moveTo(mapX(p.x), mapY(p.y));
    else ctx.lineTo(mapX(p.x), mapY(p.y));
  });
  ctx.closePath();

  ctx.lineWidth = track.roadWidth * scale;
  ctx.strokeStyle = '#171717';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Draw Centerline Accent
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  // Draw Start Dot
  const startP = track.points[0];
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(mapX(startP.x), mapY(startP.y), 4, 0, Math.PI * 2);
  ctx.fill();
}
