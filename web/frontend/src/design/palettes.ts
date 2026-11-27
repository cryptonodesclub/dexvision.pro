/** Gnoland palette: gno.land's public tokens for the interface, matching light for the hole. */
export type RGB = [number, number, number];
export interface Light { c0: RGB; c1: RGB; c2: RGB; app: RGB; rec: RGB; halo: RGB; skyA: RGB; skyB: RGB; starA: RGB; starB: RGB }

export const GNOLAND: Light = {
  c0: [0.1, 0.1, 0.11], c1: [0.4, 0.41, 0.43], c2: [0.95, 0.97, 1],
  app: [0.06, 0.44, 0.92], rec: [0.3, 0.3, 0.31],
  halo: [0.5, 0.72, 0.9], skyA: [0.035, 0.035, 0.037], skyB: [0.008, 0.05, 0.085], starA: [1, 1, 1], starB: [0.45, 0.78, 1],
};
/** The same hole lit in coral, the testnet's color, so the chain being read shows at a glance. */
export const CORAL: Light = {
  ...GNOLAND,
  app: [0.92, 0.26, 0.08],
  halo: [0.92, 0.6, 0.5], skyB: [0.085, 0.03, 0.012], starB: [1, 0.7, 0.55],
};
export const css = { void: '#090909', ink: '#f0f0f0', ash: '#7c7c7c', accent: '#49afeb', up: '#49afeb', down: '#eb6c49', warn: '#facc32' };
