/** Color themes for the Horizon cover. `css` drives the interface, `light` drives the shader. */
export type RGB = [number, number, number];
export interface Light { c0: RGB; c1: RGB; c2: RGB; app: RGB; rec: RGB; halo: RGB; skyA: RGB; skyB: RGB; starA: RGB; starB: RGB }
export interface Palette { id: string; name: string; up: string; down: string; css: Record<string, string>; light: Light }

export const EMBER: Light = {
  c0: [0.55, 0.05, 0.015], c1: [1, 0.36, 0.08], c2: [1, 0.83, 0.6], // disk: outer, mid, inner
  app: [0.36, 0.68, 1], rec: [1, 0.13, 0.07], // approaching, receding
  halo: [1, 0.5, 0.22], skyA: [0.2, 0.035, 0.012], skyB: [0.015, 0.05, 0.11], starA: [1, 0.75, 0.55], starB: [0.65, 0.83, 1],
};

export const PALETTES: Palette[] = [
  { id: 'ember', name: 'Ember', up: 'Blue', down: 'Red', light: EMBER, css: {} },
  {
    // interface colors are gno.land's own tokens: gray-900/50/400/300 and blue-400/600
    id: 'gnoland', name: 'Gnoland', up: 'Blue', down: 'Gray',
    light: {
      c0: [0.1, 0.1, 0.11], c1: [0.4, 0.41, 0.43], c2: [0.95, 0.97, 1],
      app: [0.06, 0.44, 0.92], rec: [0.3, 0.3, 0.31],
      halo: [0.5, 0.72, 0.9], skyA: [0.035, 0.035, 0.037], skyB: [0.008, 0.05, 0.085], starA: [1, 1, 1], starB: [0.45, 0.78, 1],
    },
    css: { void: '#090909', ink: '#f0f0f0', ash: '#7c7c7c', ember: '#49afeb', blue: '#49afeb', red: '#999999', rule: '#f0f0f024', 'band-a': '#49afeb', 'band-b': '#bdbdbd', 'band-c': '#696969', 'band-d': '#292929', 'up-fill': '#3e96c9', 'dn-fill': '#7c7c7c', 'up-line': '#a9dcfb', 'dn-line': '#e2e2e2' },
  },
  {
    id: 'cherenkov', name: 'Cherenkov', up: 'Lime', down: 'Coral',
    light: {
      c0: [0.0, 0.17, 0.16], c1: [0.02, 0.72, 0.5], c2: [0.62, 1, 0.86],
      app: [0.66, 1, 0.22], rec: [1, 0.2, 0.22],
      halo: [0.12, 0.95, 0.66], skyA: [0.0, 0.08, 0.075], skyB: [0.1, 0.02, 0.035], starA: [0.6, 1, 0.85], starB: [1, 0.8, 0.75],
    },
    css: { void: '#020807', ink: '#e6fff4', ash: '#86aaa0', ember: '#1fe0a4', blue: '#c2ff4d', red: '#ff6b6b', rule: '#1fe0a433', 'band-a': '#b6ff3d', 'band-b': '#e6fff4', 'band-c': '#1fa98a', 'band-d': '#ff4a4f', 'up-fill': '#b6ff3d', 'dn-fill': '#ff4a4f', 'up-line': '#dcff9a', 'dn-line': '#ff9c98' },
  },
  {
    id: 'plasma', name: 'Plasma', up: 'Cyan', down: 'Orange',
    light: {
      c0: [0.3, 0.0, 0.16], c1: [1, 0.07, 0.42], c2: [1, 0.72, 0.86],
      app: [0.12, 0.86, 1], rec: [1, 0.36, 0.02],
      halo: [1, 0.2, 0.56], skyA: [0.13, 0.008, 0.07], skyB: [0.0, 0.07, 0.1], starA: [1, 0.65, 0.85], starB: [0.55, 0.95, 1],
    },
    css: { void: '#080207', ink: '#ffeaf4', ash: '#b58fa6', ember: '#ff3d9a', blue: '#45e0ff', red: '#ff8a2b', rule: '#ff3d9a38', 'band-a': '#25d8ff', 'band-b': '#ffeaf4', 'band-c': '#ff3d9a', 'band-d': '#ff6a00', 'up-fill': '#25d8ff', 'dn-fill': '#ff6f0f', 'up-line': '#a5f1ff', 'dn-line': '#ffb27a' },
  },
  {
    id: 'eclipse', name: 'Eclipse', up: 'Yellow', down: 'Violet',
    light: {
      c0: [0.12, 0.11, 0.15], c1: [0.55, 0.53, 0.58], c2: [1, 0.98, 0.94],
      app: [1, 0.86, 0.06], rec: [0.4, 0.14, 1],
      halo: [0.9, 0.88, 0.85], skyA: [0.055, 0.03, 0.11], skyB: [0.06, 0.055, 0.01], starA: [1, 0.97, 0.85], starB: [0.82, 0.76, 1],
    },
    css: { void: '#050506', ink: '#f6f4ee', ash: '#9d9aa3', ember: '#ffe32e', blue: '#ffe32e', red: '#a98aff', rule: '#f6f4ee2e', 'band-a': '#ffe32e', 'band-b': '#f6f4ee', 'band-c': '#8d8a96', 'band-d': '#7a45ff', 'up-fill': '#ffe32e', 'dn-fill': '#8552ff', 'up-line': '#fff3a0', 'dn-line': '#c9b5ff' },
  },
];
