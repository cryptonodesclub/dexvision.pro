// @ts-check
import { defineConfig } from 'astro/config';

// Public "Coming soon" site. Separate entry so the design lab and its demo data never ship.
export default defineConfig({
  srcDir: './launch',
  publicDir: './launch/public',
  outDir: '../../wwwroot',
  site: 'https://dexvision.pro',
  devToolbar: { enabled: false },
});
