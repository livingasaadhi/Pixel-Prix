export const TRACKS = [
  {
    id: 'monaco-oval',
    name: 'Monaco Oval',
    description: 'Master steering and KERS boost timing on this legendary high-speed GP loop.',
    difficulty: 'EASY',
    laps: 2,
    roadWidth: 200,
    length: '3.4 KM',
    worldWidth: 3600,
    worldHeight: 2400,
    startPos: { x: 1800, y: 2000, rotation: 0 },
    sector1End: 2,
    sector2End: 4,
    points: [
      { x: 800, y: 2000 },
      { x: 1800, y: 2000 },
      { x: 2800, y: 2000 },
      { x: 3200, y: 1600 },
      { x: 2900, y: 1100 },
      { x: 3100, y: 700 },
      { x: 2500, y: 500 },
      { x: 1800, y: 500 },
      { x: 1000, y: 500 },
      { x: 500, y: 900 },
      { x: 500, y: 1500 },
      { x: 800, y: 1850 }
    ],
    checkpoints: [
      { id: 0, x: 1800, y: 2000, label: 'START/FINISH' },
      { id: 1, x: 3200, y: 1600, label: 'CP 1 (BEAU RIVAGE)' },
      { id: 2, x: 2900, y: 1100, label: 'CP 2 (CASINO)' },
      { id: 3, x: 1800, y: 500, label: 'CP 3 (TUNNEL)' },
      { id: 4, x: 500, y: 900, label: 'CP 4 (TABAC)' },
      { id: 5, x: 500, y: 1500, label: 'CP 5 (SWIMMING POOL)' }
    ]
  },
  {
    id: 'serpent-bend',
    name: 'Serpent Bend',
    description: 'Winding S-curves and hairpin turns that test tire grip and throttle control.',
    difficulty: 'MEDIUM',
    laps: 2,
    roadWidth: 180,
    length: '4.2 KM',
    worldWidth: 4000,
    worldHeight: 2800,
    startPos: { x: 2000, y: 2400, rotation: 0 },
    sector1End: 2,
    sector2End: 4,
    points: [
      { x: 800, y: 2400 },
      { x: 2000, y: 2400 },
      { x: 3200, y: 2400 },
      { x: 3600, y: 1900 },
      { x: 3100, y: 1500 },
      { x: 2300, y: 1600 },
      { x: 2600, y: 1100 },
      { x: 2100, y: 700 },
      { x: 1300, y: 800 },
      { x: 800, y: 1200 },
      { x: 1200, y: 1700 },
      { x: 700, y: 2100 }
    ],
    checkpoints: [
      { id: 0, x: 2000, y: 2400, label: 'START/FINISH' },
      { id: 1, x: 3600, y: 1900, label: 'CP 1 (ABBEY)' },
      { id: 2, x: 2300, y: 1600, label: 'CP 2 (LOOP)' },
      { id: 3, x: 2100, y: 700, label: 'CP 3 (WELLINGTON)' },
      { id: 4, x: 800, y: 1200, label: 'CP 4 (LUFFIELD)' },
      { id: 5, x: 700, y: 2100, label: 'CP 5 (COPSE)' }
    ]
  },
  {
    id: 'neon-ring',
    name: 'Neon Ring',
    description: 'Technical city circuit with sharp 90-degree turns and high-speed chicanes.',
    difficulty: 'HARD',
    laps: 2,
    roadWidth: 170,
    length: '5.8 KM',
    worldWidth: 3600,
    worldHeight: 2800,
    startPos: { x: 1800, y: 2400, rotation: 0 },
    sector1End: 2,
    sector2End: 4,
    points: [
      { x: 600, y: 2400 },
      { x: 1800, y: 2400 },
      { x: 3000, y: 2400 },
      { x: 3200, y: 1900 },
      { x: 2600, y: 1600 },
      { x: 2200, y: 1100 },
      { x: 2800, y: 700 },
      { x: 2100, y: 500 },
      { x: 1400, y: 500 },
      { x: 800, y: 900 },
      { x: 1200, y: 1400 },
      { x: 600, y: 1900 }
    ],
    checkpoints: [
      { id: 0, x: 1800, y: 2400, label: 'START/FINISH' },
      { id: 1, x: 3200, y: 1900, label: 'CP 1 (ESPLANADE)' },
      { id: 2, x: 2600, y: 1600, label: 'CP 2 (RAFFLES)' },
      { id: 3, x: 2800, y: 700, label: 'CP 3 (BRIDGE)' },
      { id: 4, x: 800, y: 900, label: 'CP 4 (HELIX)' },
      { id: 5, x: 600, y: 1900, label: 'CP 5 (MERLION)' }
    ]
  },
  {
    id: 'desert-drift',
    name: 'Desert Drift',
    description: 'Wide open desert road circuit with gentle sweeping turns and long straightaways.',
    difficulty: 'EASY',
    laps: 2,
    roadWidth: 220,
    length: '6.8 KM',
    worldWidth: 4400,
    worldHeight: 3000,
    startPos: { x: 2200, y: 2600, rotation: 0 },
    sector1End: 1,
    sector2End: 3,
    points: [
      { x: 1000, y: 2600 },
      { x: 2200, y: 2600 },
      { x: 3600, y: 2600 },
      { x: 4000, y: 1900 },
      { x: 3400, y: 1400 },
      { x: 2700, y: 1600 },
      { x: 2000, y: 1000 },
      { x: 2800, y: 500 },
      { x: 1500, y: 500 },
      { x: 700, y: 1100 },
      { x: 700, y: 2000 }
    ],
    checkpoints: [
      { id: 0, x: 2200, y: 2600, label: 'START/FINISH' },
      { id: 1, x: 4000, y: 1900, label: 'CP 1 (DUNE)' },
      { id: 2, x: 2700, y: 1600, label: 'CP 2 (MIRAGE)' },
      { id: 3, x: 2800, y: 500, label: 'CP 3 (CANYON)' },
      { id: 4, x: 700, y: 1100, label: 'CP 4 (SUNSET)' }
    ]
  },
  {
    id: 'cyber-ring',
    name: 'Cyber Ring',
    description: 'Futuristic technical loop requiring tight line discipline and instant reflexes.',
    difficulty: 'HARD',
    laps: 2,
    roadWidth: 160,
    length: '3.8 KM',
    worldWidth: 3200,
    worldHeight: 2400,
    startPos: { x: 1600, y: 2100, rotation: 0 },
    sector1End: 1,
    sector2End: 3,
    points: [
      { x: 700, y: 2100 },
      { x: 1600, y: 2100 },
      { x: 2600, y: 2100 },
      { x: 2900, y: 1600 },
      { x: 2400, y: 1100 },
      { x: 2700, y: 700 },
      { x: 2000, y: 400 },
      { x: 1100, y: 400 },
      { x: 500, y: 800 },
      { x: 800, y: 1300 },
      { x: 400, y: 1700 }
    ],
    checkpoints: [
      { id: 0, x: 1600, y: 2100, label: 'START/FINISH' },
      { id: 1, x: 2900, y: 1600, label: 'CP 1 (CASTROL)' },
      { id: 2, x: 2400, y: 1100, label: 'CP 2 (REMUS)' },
      { id: 3, x: 2000, y: 400, label: 'CP 3 (RAUCH)' },
      { id: 4, x: 500, y: 800, label: 'CP 4 (RINDT)' }
    ]
  },
  {
    id: 'g3-sweden',
    name: 'G3 Sweden',
    description: 'Scenic Scandinavian forest road with double hairpins and snowy curves.',
    difficulty: 'MEDIUM',
    laps: 2,
    roadWidth: 180,
    length: '4.8 KM',
    worldWidth: 4000,
    worldHeight: 2800,
    startPos: { x: 2000, y: 2500, rotation: 0 },
    sector1End: 1,
    sector2End: 3,
    points: [
      { x: 1200, y: 2500 },
      { x: 2000, y: 2500 },
      { x: 3000, y: 2500 },
      { x: 3600, y: 2000 },
      { x: 3100, y: 1500 },
      { x: 3400, y: 900 },
      { x: 2600, y: 500 },
      { x: 1700, y: 500 },
      { x: 1000, y: 800 },
      { x: 600, y: 1400 },
      { x: 1100, y: 1900 },
      { x: 600, y: 2300 }
    ],
    checkpoints: [
      { id: 0, x: 2000, y: 2500, label: 'START/FINISH' },
      { id: 1, x: 3600, y: 2000, label: 'CP 1 (EAU ROUGE)' },
      { id: 2, x: 3400, y: 900, label: 'CP 2 (KEMMEL)' },
      { id: 3, x: 1700, y: 500, label: 'CP 3 (LES COMBES)' },
      { id: 4, x: 600, y: 1400, label: 'CP 4 (POUHON)' }
    ]
  }
];

export function getTrackById(id) {
  return TRACKS.find(t => t.id === id) || TRACKS[0];
}
