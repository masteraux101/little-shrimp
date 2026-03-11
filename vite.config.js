import { defineConfig } from 'vite';
import { resolve } from 'path';
import fs from 'fs';

/**
 * Vite plugin to copy examples/ directory into the build output
 * so bundled SOUL/Skill files are accessible on GitHub Pages.
 */
function copyExamplesPlugin() {
  return {
    name: 'copy-examples',
    writeBundle(options) {
      const outDir = options.dir || 'dist';
      const src = resolve(__dirname, 'examples');
      const dest = resolve(outDir, 'examples');
      copyDirSync(src, dest);
    },
  };
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export default defineConfig({
  base: '/shrimp/',
  build: {
    outDir: 'dist',
  },
  plugins: [copyExamplesPlugin()],
});
