import Phaser from 'phaser';

/**
 * Generates a perfectly closed cardinal spline points list. Slightly reduced
 * tangent tension keeps high-speed circuits from overshooting their intended
 * apexes while retaining a natural flowing curve between controls.
 */
function getClosedSplinePoints(rawPoints, divisions = 220) {
  const n = rawPoints.length;
  const curvePoints = [];
  
  // Cardinal spline interpolation. Catmull-Rom uses 0.5; a lower value gives
  // the expanded circuits cleaner, more believable curve transitions.
  const interpolate = (p0, p1, p2, p3, t) => {
    const t2 = t * t;
    const t3 = t2 * t;
    
    const tension = 0.42;
    const f1 = -tension * t3 + 2 * tension * t2 - tension * t;
    const f2 = (2 - tension) * t3 + (tension - 3) * t2 + 1;
    const f3 = (tension - 2) * t3 + (3 - 2 * tension) * t2 + tension * t;
    const f4 = tension * t3 - tension * t2;
    
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
  const curvePoints = getClosedSplinePoints(track.points, 420);
  
  // === BACKGROUND: Broadcast-grade circuit infield ===
  graphics.fillStyle(0x07090d, 1);
  graphics.fillRect(0, 0, track.worldWidth, track.worldHeight);
  graphics.fillStyle(0x0e1317, 0.55);
  graphics.fillTriangle(0, 0, track.worldWidth * 0.56, 0, 0, track.worldHeight * 0.55);
  graphics.fillStyle(0x12171b, 0.38);
  graphics.fillTriangle(track.worldWidth, track.worldHeight, track.worldWidth * 0.46, track.worldHeight, track.worldWidth, track.worldHeight * 0.38);

  graphics.lineStyle(1, 0x273039, 0.22);
  const gridSize = 96;
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

  // === RUN-OFF ZONE (mown grass and concrete safety apron) ===
  drawPath(graphics, roadWidth + 76, 0x142718, 1);
  drawPath(graphics, roadWidth + 62, 0x1b341d, 1);
  drawPath(graphics, roadWidth + 50, 0x283229, 1);

  // === OUTER HAZARD STRIPES (checker pattern edge) ===
  // Alternating wide/narrow gray bands simulate concrete boundary
  drawPath(graphics, roadWidth + 28, 0x3a3848, 1);
  drawPath(graphics, roadWidth + 22, 0x1e1c2a, 1);

  // === MUTED CURB STRIPES ===
  // Deliberately subdued so the player car, not the circuit paint, carries
  // the primary contrast and focal priority at race speed.
  // Outer curb
  for (let i = 0; i < curvePoints.length - 1; i++) {
    const segmentIndex = Math.floor(i * 20 / curvePoints.length);
    const isRedStripe = segmentIndex % 2 === 0;
    const pt = curvePoints[i];
    const nextPt = curvePoints[i + 1];
    const angle = Math.atan2(nextPt.y - pt.y, nextPt.x - pt.x) + Math.PI / 2;
    const outerDist = (roadWidth / 2) + 10;
    const curbWidth = 7;

    const curbColor = isRedStripe ? 0x7d3540 : 0x9ba3ad;
    graphics.lineStyle(curbWidth, curbColor, 0.46);
    graphics.lineBetween(
      pt.x + Math.cos(angle) * outerDist, pt.y + Math.sin(angle) * outerDist,
      nextPt.x + Math.cos(angle) * outerDist, nextPt.y + Math.sin(angle) * outerDist
    );
    // Inner curb keeps the alternating pattern, at the same restrained contrast.
    const innerCurbColor = isRedStripe ? 0x9ba3ad : 0x7d3540;
    graphics.lineStyle(curbWidth, innerCurbColor, 0.46);
    graphics.lineBetween(
      pt.x - Math.cos(angle) * outerDist, pt.y - Math.sin(angle) * outerDist,
      nextPt.x - Math.cos(angle) * outerDist, nextPt.y - Math.sin(angle) * outerDist
    );
  }

  // === MAIN ASPHALT ROAD — layered charcoal, rubber, and lane wear ===
  // Deep shadow layer under road
  drawPath(graphics, roadWidth + 4, 0x0a0810, 1);
  // Main asphalt surface
  drawPath(graphics, roadWidth, 0x100e1a, 1);
  // Very subtle lighter asphalt for surface texture
  drawPath(graphics, roadWidth - 8, 0x121020, 0.6);
  drawPath(graphics, roadWidth - 26, 0x171922, 0.34);
  // Worn racing line
  drawPath(graphics, 4, 0x080a0d, 0.42);

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

  // === TIRE MARKS (deterministic so a circuit keeps its visual identity) ===
  const tireDivisions = getClosedSplinePoints(track.points, 180);
  for (let i = 0; i < tireDivisions.length - 1; i++) {
    const seeded = ((i * 1103515245 + track.points.length * 12345) >>> 0) / 4294967296;
    if (seeded < 0.07) {
      const pt = tireDivisions[i];
      const nextPt = tireDivisions[i + 1];
      const angle = Math.atan2(nextPt.y - pt.y, nextPt.x - pt.x) + Math.PI / 2;
      const offset = (seeded - 0.5) * (roadWidth * 0.75);
      const len = 18 + seeded * 38;
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

  // === TRACKSIDE SET DRESSING ===
  // Compact grandstands, marshal posts, and floodlights give each circuit a
  // sense of scale while remaining light enough for mobile browsers.
  const scenery = scene.add.graphics();
  for (let i = 12; i < curvePoints.length - 1; i += 24) {
    const point = curvePoints[i];
    const nextPoint = curvePoints[i + 1];
    const tangent = Math.atan2(nextPoint.y - point.y, nextPoint.x - point.x);
    const normal = tangent + Math.PI / 2;
    const side = (Math.floor(i / 24) % 2 === 0 ? 1 : -1);
    const offset = roadWidth / 2 + 74 + ((i * 17) % 48);
    const x = point.x + Math.cos(normal) * offset * side;
    const y = point.y + Math.sin(normal) * offset * side;

    if (i % 72 === 12) {
      // Grandstand block with seating stripes.
      scenery.fillStyle(0x202831, 0.96);
      scenery.fillRoundedRect(x - 38, y - 16, 76, 32, 4);
      scenery.fillStyle(0xe4e7e8, 0.3);
      for (let row = -9; row <= 9; row += 6) {
        scenery.fillRect(x - 31, y + row, 62, 2);
      }
      scenery.lineStyle(2, 0xffd500, 0.76);
      scenery.strokeRoundedRect(x - 38, y - 16, 76, 32, 4);
    } else if (i % 48 === 12) {
      // Floodlight mast and glow pool.
      scenery.fillStyle(0xffffff, 0.08);
      scenery.fillCircle(x, y - 22, 20);
      scenery.lineStyle(3, 0x89929b, 0.9);
      scenery.lineBetween(x, y + 18, x, y - 18);
      scenery.fillStyle(0xfff4c9, 0.96);
      scenery.fillRoundedRect(x - 10, y - 24, 20, 7, 2);
    } else {
      // Marshal post / braking board.
      scenery.fillStyle(0xe21c1c, 0.92);
      scenery.fillRect(x - 7, y - 12, 14, 24);
      scenery.fillStyle(0xf7f7f4, 0.92);
      scenery.fillRect(x - 4, y - 8, 8, 5);
      scenery.fillRect(x - 4, y + 3, 8, 5);
    }
  }

  // Circuit identity board at start/finish.
  const boardX = start.x + Math.cos(sfAngle) * (halfW + 58);
  const boardY = start.y + Math.sin(sfAngle) * (halfW + 58);
  const board = scene.add.text(boardX, boardY, 'PIXEL\nPRIX', {
    fontFamily: 'monospace',
    fontSize: '13px',
    fontStyle: 'bold',
    color: '#f4f4ef',
    align: 'center',
    backgroundColor: '#d91b1b',
    padding: { x: 8, y: 5 }
  });
  board.setOrigin(0.5);
  board.setRotation(tangentAngle(start, next));
  board.setDepth(3);

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

function tangentAngle(start, next) {
  return Math.atan2(next.y - start.y, next.x - start.x);
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

  const margin = 16;
  const scaleX = (w - margin * 2) / (maxX - minX || 1);
  const scaleY = (h - margin * 2) / (maxY - minY || 1);
  const scale = Math.min(scaleX, scaleY);

  const offsetX = margin + (w - margin * 2 - (maxX - minX) * scale) / 2;
  const offsetY = margin + (h - margin * 2 - (maxY - minY) * scale) / 2;

  const mapX = (x) => offsetX + (x - minX) * scale;
  const mapY = (y) => offsetY + (y - minY) * scale;

  // Background subtle telemetry grid line overlay
  ctx.lineWidth = 0.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  const gridStep = 20;
  for (let x = 0; x < w; x += gridStep) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += gridStep) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const rawPoints = track.points;
  const s1End = track.sector1End || Math.floor(rawPoints.length / 3);
  const s2End = track.sector2End || Math.floor((rawPoints.length * 2) / 3);

  // Build sector sub-paths
  const drawSegment = (startIdx, endIdx, color, glowColor, width = 3) => {
    ctx.beginPath();
    for (let i = startIdx; i <= endIdx; i++) {
      const pt = rawPoints[i % rawPoints.length];
      if (i === startIdx) ctx.moveTo(mapX(pt.x), mapY(pt.y));
      else ctx.lineTo(mapX(pt.x), mapY(pt.y));
    }
    ctx.lineWidth = width + 4;
    ctx.strokeStyle = glowColor;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  };

  // Dark road bed underneath
  ctx.beginPath();
  rawPoints.forEach((p, idx) => {
    if (idx === 0) ctx.moveTo(mapX(p.x), mapY(p.y));
    else ctx.lineTo(mapX(p.x), mapY(p.y));
  });
  ctx.closePath();
  ctx.lineWidth = Math.max(6, track.roadWidth * scale * 0.8);
  ctx.strokeStyle = 'rgba(8, 10, 15, 0.9)';
  ctx.stroke();

  // A neutral track line keeps the route legible without turning the map into
  // a multi-colour legend. Sector labels remain available beside the map.
  const routeColor = '#FFFFFF';
  const routeGlow = 'rgba(73, 216, 255, 0.45)';
  drawSegment(0, s1End, routeColor, routeGlow, 4.0);
  drawSegment(s1End, s2End, routeColor, routeGlow, 4.0);
  drawSegment(s2End, rawPoints.length, routeColor, routeGlow, 4.0);

  // Sector split dots
  const drawSplitMarker = (idx, label) => {
    const pt = rawPoints[idx % rawPoints.length];
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.22)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(mapX(pt.x), mapY(pt.y), 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  };
  drawSplitMarker(0, 'S1');
  drawSplitMarker(s1End, 'S2');
  drawSplitMarker(s2End, 'S3');

  // Start/Finish checkered line overlay
  const sfP = track.points[1] || track.points[0];
  const sfN = track.points[2] || track.points[1];
  const sfAng = Math.atan2(sfN.y - sfP.y, sfN.x - sfP.x) + Math.PI / 2;
  const sfHW = Math.max(6, (track.roadWidth / 2) * scale);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#FFFFFF';
  ctx.shadowColor = 'rgba(255, 255, 255, 0.2)';
  ctx.shadowBlur = 5;
  ctx.beginPath();
  ctx.moveTo(mapX(sfP.x) + Math.cos(sfAng) * sfHW, mapY(sfP.y) + Math.sin(sfAng) * sfHW);
  ctx.lineTo(mapX(sfP.x) - Math.cos(sfAng) * sfHW, mapY(sfP.y) - Math.sin(sfAng) * sfHW);
  ctx.stroke();
  ctx.shadowBlur = 0;
}
