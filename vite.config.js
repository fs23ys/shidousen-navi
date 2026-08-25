import { defineConfig } from 'vite';

// GitHub Pages will serve this app from https://<user>.github.io/shidousen-navi/
// so all asset URLs need that repo name as a base path.
export default defineConfig({
  base: '/shidousen-navi/',
});
