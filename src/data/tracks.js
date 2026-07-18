export const TRACKS = [
  {
    id: 'monaco-oval',
    name: 'Monaco Oval',
    description: 'Smooth high-speed oval circuit, ideal for mastering steering and boost timing.',
    difficulty: 'EASY',
    laps: 2,
    roadWidth: 110,
    worldWidth: 1800,
    worldHeight: 1300,
    startPos: { x: 900, y: 1050, rotation: 0 },
    points: [
      { x: 400, y: 1050 },
      { x: 900, y: 1050 },
      { x: 1400, y: 1050 },
      { x: 1600, y: 850 },
      { x: 1600, y: 450 },
      { x: 1400, y: 250 },
      { x: 900, y: 250 },
      { x: 400, y: 250 },
      { x: 200, y: 450 },
      { x: 200, y: 850 }
    ],
    checkpoints: [
      { id: 0, x: 900, y: 1050, label: 'START/FINISH' },
      { id: 1, x: 1600, y: 650, label: 'CP 1' },
      { id: 2, x: 900, y: 250, label: 'CP 2' },
      { id: 3, x: 200, y: 650, label: 'CP 3' }
    ]
  },
  {
    id: 'serpent-bend',
    name: 'Serpent Bend',
    description: 'Winding S-curves that test cornering balance and line choice.',
    difficulty: 'MEDIUM',
    laps: 2,
    roadWidth: 100,
    worldWidth: 2000,
    worldHeight: 1400,
    startPos: { x: 1000, y: 1200, rotation: 0 },
    points: [
      { x: 400, y: 1200 },
      { x: 1000, y: 1200 },
      { x: 1600, y: 1200 },
      { x: 1800, y: 950 },
      { x: 1600, y: 700 },
      { x: 1200, y: 700 },
      { x: 800, y: 700 },
      { x: 400, y: 500 },
      { x: 600, y: 250 },
      { x: 1200, y: 250 },
      { x: 1700, y: 350 },
      { x: 1800, y: 650 },
      { x: 1500, y: 950 },
      { x: 300, y: 1000 }
    ],
    checkpoints: [
      { id: 0, x: 1000, y: 1200, label: 'START/FINISH' },
      { id: 1, x: 1700, y: 825, label: 'CP 1' },
      { id: 2, x: 1000, y: 700, label: 'CP 2' },
      { id: 3, x: 900, y: 250, label: 'CP 3' },
      { id: 4, x: 1650, y: 500, label: 'CP 4' },
      { id: 5, x: 300, y: 1000, label: 'CP 5' }
    ]
  },
  {
    id: 'neon-ring',
    name: 'Neon Ring',
    description: 'Technical city circuit with sharp 90-degree turns and high-speed chicanes.',
    difficulty: 'HARD',
    laps: 2,
    roadWidth: 95,
    worldWidth: 1800,
    worldHeight: 1400,
    startPos: { x: 900, y: 1200, rotation: 0 },
    points: [
      { x: 300, y: 1200 },
      { x: 900, y: 1200 },
      { x: 1500, y: 1200 },
      { x: 1500, y: 800 },
      { x: 1100, y: 800 },
      { x: 1100, y: 500 },
      { x: 1500, y: 500 },
      { x: 1500, y: 200 },
      { x: 300, y: 200 },
      { x: 300, y: 600 },
      { x: 700, y: 600 },
      { x: 700, y: 900 },
      { x: 300, y: 900 }
    ],
    checkpoints: [
      { id: 0, x: 900, y: 1200, label: 'START/FINISH' },
      { id: 1, x: 1500, y: 1000, label: 'CP 1' },
      { id: 2, x: 1100, y: 650, label: 'CP 2' },
      { id: 3, x: 900, y: 200, label: 'CP 3' },
      { id: 4, x: 500, y: 600, label: 'CP 4' },
      { id: 5, x: 300, y: 1050, label: 'CP 5' }
    ]
  },
  {
    id: 'desert-drift',
    name: 'Desert Drift',
    description: 'Wide open desert road circuit with gentle sweeping turns and long straightaways.',
    difficulty: 'EASY',
    laps: 2,
    roadWidth: 120,
    worldWidth: 2200,
    worldHeight: 1500,
    startPos: { x: 1100, y: 1300, rotation: 0 },
    points: [
      { x: 500, y: 1300 },
      { x: 1100, y: 1300 },
      { x: 1800, y: 1300 },
      { x: 2000, y: 1000 },
      { x: 1800, y: 600 },
      { x: 1400, y: 900 },
      { x: 1000, y: 400 },
      { x: 1600, y: 250 },
      { x: 600, y: 250 },
      { x: 300, y: 600 },
      { x: 300, y: 1000 }
    ],
    checkpoints: [
      { id: 0, x: 1100, y: 1300, label: 'START/FINISH' },
      { id: 1, x: 1900, y: 1150, label: 'CP 1' },
      { id: 2, x: 1600, y: 750, label: 'CP 2' },
      { id: 3, x: 1100, y: 300, label: 'CP 3' },
      { id: 4, x: 300, y: 800, label: 'CP 4' }
    ]
  },
  {
    id: 'cyber-ring',
    name: 'Cyber Ring',
    description: 'Expert level compact loop requiring tight line discipline and instant reflexes.',
    difficulty: 'HARD',
    laps: 2,
    roadWidth: 90,
    worldWidth: 1600,
    worldHeight: 1200,
    startPos: { x: 800, y: 1050, rotation: 0 },
    points: [
      { x: 350, y: 1050 },
      { x: 800, y: 1050 },
      { x: 1300, y: 1050 },
      { x: 1450, y: 850 },
      { x: 1250, y: 650 },
      { x: 1450, y: 450 },
      { x: 1250, y: 200 },
      { x: 800, y: 200 },
      { x: 350, y: 200 },
      { x: 150, y: 450 },
      { x: 350, y: 650 },
      { x: 150, y: 850 }
    ],
    checkpoints: [
      { id: 0, x: 800, y: 1050, label: 'START/FINISH' },
      { id: 1, x: 1350, y: 750, label: 'CP 1' },
      { id: 2, x: 1350, y: 325, label: 'CP 2' },
      { id: 3, x: 575, y: 200, label: 'CP 3' },
      { id: 4, x: 250, y: 550, label: 'CP 4' }
    ]
  },
  {
    id: 'g3-sweden',
    name: 'G3 Sweden',
    description: 'Scenic Scandinavian circuit winding through snowy forests with tricky chicanes.',
    difficulty: 'MEDIUM',
    laps: 2,
    roadWidth: 100,
    worldWidth: 2000,
    worldHeight: 1400,
    startPos: { x: 1000, y: 1250, rotation: 0 },
    points: [
      { x: 600, y: 1250 },
      { x: 1000, y: 1250 },
      { x: 1500, y: 1250 },
      { x: 1800, y: 1050 },
      { x: 1550, y: 850 },
      { x: 1800, y: 600 },
      { x: 1600, y: 300 },
      { x: 1000, y: 200 },
      { x: 400, y: 350 },
      { x: 250, y: 650 },
      { x: 500, y: 850 },
      { x: 300, y: 1100 }
    ],
    checkpoints: [
      { id: 0, x: 1000, y: 1250, label: 'START/FINISH' },
      { id: 1, x: 1600, y: 1000, label: 'CP 1' },
      { id: 2, x: 1700, y: 450, label: 'CP 2' },
      { id: 3, x: 800, y: 200, label: 'CP 3' },
      { id: 4, x: 350, y: 750, label: 'CP 4' }
    ]
  }
];

export function getTrackById(id) {
  return TRACKS.find(t => t.id === id) || TRACKS[0];
}
