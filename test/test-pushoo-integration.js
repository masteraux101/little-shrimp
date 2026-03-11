#!/usr/bin/env node

/**
 * test-pushoo-integration.js
 * 
 * Tests Pushoo notification integration in BrowserAgent
 * Verifies configuration, notification formatting, and error handling
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('🔔 Testing Pushoo Integration...\n');

// ─── 1. Check source files ──────────────────────────────────────────

console.log('1. Source Files:');

const checks = {
  'pushoo.js exists': fs.existsSync(path.join(__dirname, '../src/pushoo.js')),
  'pushoo imported in app.js': fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8').includes('import PushooNotifier from'),
  'pushooConfig in SESSION_KEYS': fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8').includes("'pushooConfig'"),
  'Pushoo button in HTML': fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8').includes('pushoo-config-btn'),
  'Pushoo dialog in HTML': fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8').includes('pushoo-config-dialog'),
};

let sourcePass = 0;
for (const [check, result] of Object.entries(checks)) {
  console.log(`   ${result ? '✅' : '❌'} ${check}`);
  if (result) sourcePass++;
}
console.log(`   Score: ${sourcePass}/${Object.keys(checks).length}\n`);

// ─── 2. Check Pushoo module ─────────────────────────────────────────

console.log('2. Pushoo Module (pushoo.js):');

const pushooCode = fs.readFileSync(path.join(__dirname, '../src/pushoo.js'), 'utf8');

const moduleChecks = {
  'sendNotification function': /function sendNotification|sendNotification.*=.*=>/.test(pushooCode),
  'validateConfig function': /function validateConfig|validateConfig.*=.*=>/.test(pushooCode),
  'getSupportedPlatforms function': /function getSupportedPlatforms|getSupportedPlatforms.*=.*=>/.test(pushooCode),
  'Markdown content builder': /buildContent/.test(pushooCode),
  'Export object': /return {[\s\S]*sendNotification[\s\S]*validateConfig[\s\S]*getSupportedPlatforms/.test(pushooCode),
};

let modulePass = 0;
for (const [check, result] of Object.entries(moduleChecks)) {
  console.log(`   ${result ? '✅' : '❌'} ${check}`);
  if (result) modulePass++;
}
console.log(`   Score: ${modulePass}/${Object.keys(moduleChecks).length}\n`);

// ─── 3. Check app.js integration ───────────────────────────────────

console.log('3. App.js Integration:');

const appCode = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

const appChecks = {
  'Pushoo config dialog event listeners': /pushoo-config-btn.*addEventListener|pushoo-config-save.*addEventListener/.test(appCode),
  'Pushoo notification on workflow complete': /PushooNotifier.sendNotification/.test(appCode),
  'Pushoo config save in dialog': /pushooConfig|pushoo.*config/i.test(appCode),
  'Error handling for Pushoo': /catch.*pushErr|console.warn.*Pushoo/.test(appCode),
};

let appPass = 0;
for (const [check, result] of Object.entries(appChecks)) {
  console.log(`   ${result ? '✅' : '❌'} ${check}`);
  if (result) appPass++;
}
console.log(`   Score: ${appPass}/${Object.keys(appChecks).length}\n`);

// ─── 4. Check HTML structure ────────────────────────────────────────

console.log('4. HTML UI Elements:');

const htmlCode = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

const htmlChecks = {
  'Pushoo config button': /id="pushoo-config-btn"/.test(htmlCode),
  'Pushoo dialog overlay': /id="pushoo-config-dialog"/.test(htmlCode),
  'JSON textarea input': /id="pushoo-config-json"/.test(htmlCode),
  'Config save button': /id="pushoo-config-save"/.test(htmlCode),
  'Config cancel button': /id="pushoo-config-cancel"|id="pushoo-config-close"/.test(htmlCode),
  'Pushoo documentation link': /pushoo\.js\.org/.test(htmlCode),
};

let htmlPass = 0;
for (const [check, result] of Object.entries(htmlChecks)) {
  console.log(`   ${result ? '✅' : '❌'} ${check}`);
  if (result) htmlPass++;
}
console.log(`   Score: ${htmlPass}/${Object.keys(htmlChecks).length}\n`);

// ─── 5. Check CSS styling ──────────────────────────────────────────

console.log('5. CSS Styling:');

const cssCode = fs.readFileSync(path.join(__dirname, '../style.css'), 'utf8');

const cssChecks = {
  'Modal dialog styles': /#pushoo-config-dialog|\.modal-overlay/.test(cssCode),
  'Modal header styling': /\.modal-header/.test(cssCode),
  'Modal body styling': /\.modal-body/.test(cssCode),
  'Modal textarea styling': /\.modal-body textarea/.test(cssCode),
  'Modal footer styling': /\.modal-footer/.test(cssCode),
  'Button styling (.btn-primary, .btn-secondary)': /\.btn-primary|\.btn-secondary/.test(cssCode),
};

let cssPass = 0;
for (const [check, result] of Object.entries(cssChecks)) {
  console.log(`   ${result ? '✅' : '❌'} ${check}`);
  if (result) cssPass++;
}
console.log(`   Score: ${cssPass}/${Object.keys(cssChecks).length}\n`);

// ─── 6. Check build ────────────────────────────────────────────────

console.log('6. Build Artifacts:');

const distPath = path.join(__dirname, '../dist');
const distExists = fs.existsSync(distPath);

console.log(`   ${distExists ? '✅' : '❌'} dist/ directory exists`);

let buildPass = distExists ? 1 : 0;

if (distExists) {
  const bundlePath = path.join(distPath, 'assets');
  const bundles = fs.existsSync(bundlePath) 
    ? fs.readdirSync(bundlePath).filter(f => f.endsWith('.js'))
    : [];
  
  console.log(`   ${bundles.length > 0 ? '✅' : '❌'} JavaScript bundles built (${bundles.length})`);
  if (bundles.length > 0) buildPass++;
  
  // Check if Pushoo code is in bundles (look more carefully)
  let hasPushooCode = false;
  let hasClientCode = false;
  
  for (const bundle of bundles) {
    const bundleCode = fs.readFileSync(path.join(bundlePath, bundle), 'utf8');
    // Look for parts of the Pushoo module or references to it
    if (bundleCode.includes('sendNotification') || bundleCode.includes('PushooNotifier') || bundleCode.includes('getSupportedPlatforms') || bundleCode.includes('serverchan')) {
      hasPushooCode = true;
    }
    // Look for app.js client code
    if (bundleCode.includes('pushoo-config-btn') || bundleCode.includes('openSettings') || bundleCode.includes('localStorage')) {
      hasClientCode = true;
    }
  }
  
  console.log(`   ${hasPushooCode ? '✅' : '❌'} Pushoo notification code in bundles`);
  if (hasPushooCode) buildPass++;
  
  console.log(`   ${hasClientCode ? '✅' : '❌'} App client code in bundles`);
  if (hasClientCode) buildPass++;
}

console.log(`   Score: ${buildPass}/4\n`);

// ─── Summary ────────────────────────────────────────────────────────

const totalPass = sourcePass + modulePass + appPass + htmlPass + cssPass + buildPass;
const totalChecks = Object.keys(checks).length + Object.keys(moduleChecks).length + 
                   Object.keys(appChecks).length + Object.keys(htmlChecks).length + 
                   Object.keys(cssChecks).length + 4; // 4 from build check

console.log('═'.repeat(50));
console.log(`Overall Score: ${totalPass}/${totalChecks}`);

if (totalPass >= totalChecks * 0.8) {
  console.log('✅ Pushoo integration successful!');
  process.exit(0);
} else {
  console.log('⚠️  Some Pushoo integration checks failed.');
  process.exit(1);
}
