// @ts-check
import { defineConfig } from 'astro/config';

/** For local servers: any /token/r/… address is the token page. */
const rewrite = (/** @type {import('http').IncomingMessage} */ req, /** @type {unknown} */ _res, /** @type {() => void} */ next) => {
  if (req.url?.startsWith('/token/r/')) req.url = '/token/' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  next();
};
const tokenPages = {
  name: 'token-pages',
  configureServer: (/** @type {import('vite').ViteDevServer} */ s) => { s.middlewares.use(rewrite); },
  configurePreviewServer: (/** @type {import('vite').PreviewServer} */ s) => { s.middlewares.use(rewrite); },
};

export default defineConfig({ site: 'https://dexvision.pro', vite: { plugins: [tokenPages] }, outDir: "./../../wwwroot" });
