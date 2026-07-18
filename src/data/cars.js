export const CARS = [
  {
    id: 'scuderia-furiosa',
    name: 'Scuderia Furiosa',
    description: 'Iconic red racer designed for high cornering precision and acceleration.',
    color: '#ff1801',
    accentColor: '#ffeb00',
    topSpeed: 275,
    acceleration: 150,
    handling: 4.4,
    boostPower: 1.45,
    drag: 0.985
  },
  {
    id: 'blue-bull',
    name: 'Blue Bull Racing',
    description: 'Overclocked powertrain delivering extreme straight-line speeds and boost.',
    color: '#0f1c3f',
    accentColor: '#ff1801',
    topSpeed: 306,
    acceleration: 138,
    handling: 3.8,
    boostPower: 1.6,
    drag: 0.987
  },
  {
    id: 'silver-arrows',
    name: 'Silver Arrows',
    description: 'Lightweight aerodynamic chassis with unmatched handling and stability.',
    color: '#c0c0c0',
    accentColor: '#00ffc4',
    topSpeed: 262,
    acceleration: 175,
    handling: 5.0,
    boostPower: 1.35,
    drag: 0.982
  },
  {
    id: 'papaya-express',
    name: 'Papaya Express',
    description: 'High-rev motor tuned for quick recovery and excellent balance.',
    color: '#ff8700',
    accentColor: '#005aff',
    topSpeed: 288,
    acceleration: 162,
    handling: 4.6,
    boostPower: 1.5,
    drag: 0.984
  },
  {
    id: 'green-emerald',
    name: 'Green Emerald',
    description: 'High-capacity engine that dominates long straightaways.',
    color: '#004b49',
    accentColor: '#ccff00',
    topSpeed: 331,
    acceleration: 125,
    handling: 3.4,
    boostPower: 1.55,
    drag: 0.988
  },
  {
    id: 'alpen-glow',
    name: 'Alpen Glow',
    description: 'Agile prototype racer engineered for fast line adjustments.',
    color: '#ff4ba4',
    accentColor: '#00a2ff',
    topSpeed: 281,
    acceleration: 168,
    handling: 4.8,
    boostPower: 1.4,
    drag: 0.983
  }
];

export function getCarById(id) {
  return CARS.find(car => car.id === id) || CARS[0];
}
