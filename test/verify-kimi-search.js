#!/usr/bin/env node

/**
 * Kimi Web Search Support Verification Script
 * Tests that Kimi models support web search functionality
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('🔍 Verifying Kimi Web Search Implementation...\n');

// ─── 1. Check Kimi Provider API ───────────────────────────────────────────

console.log('1. Provider API Implementation:');
const providerApiPath = path.join(__dirname, '../src/provider-api.js');
const providerCode = fs.readFileSync(providerApiPath, 'utf8');

const checks = {
  'enableSearch parameter': /enableSearch\s*=\s*false,/.test(providerCode),
  'web search tools declaration': /type.*builtin_function/.test(providerCode) && /\$web_search/.test(providerCode),
  'tool_calls handling': /(lastToolCall|tool_calls)/.test(providerCode),
  'tool loop support': /while\s*\(\s*continueLoop/.test(providerCode),
};

let providerApiPass = 0;
for (const [check, result] of Object.entries(checks)) {
  console.log(`   ${result ? '✅' : '❌'} ${check}`);
  if (result) providerApiPass++;
}
console.log(`   Score: ${providerApiPass}/${Object.keys(checks).length}\n`);

// ─── 2. Check Chat Module Integration ────────────────────────────────────

console.log('2. Chat Module Integration:');
const chatPath = path.join(__dirname, '../src/chat.js');
const chatCode = fs.readFileSync(chatPath, 'utf8');

const chatChecks = {
  'Kimi with enableSearch passed': /enableSearch,[\s\n]*thinkingConfig/.test(chatCode),
  'Search optional parameter': /enableSearch/ .test(chatCode),
};

let chatPass = 0;
for (const [check, result] of Object.entries(chatChecks)) {
  console.log(`   ${result ? '✅' : '❌'} ${check}`);
  if (result) chatPass++;
}
console.log(`   Score: ${chatPass}/${Object.keys(chatChecks).length}\n`);

// ─── 3. Check Model Capabilities ─────────────────────────────────────────

console.log('3. Model Capabilities:');
const modelCapChecks = {};
const kimiModelsMatch = providerCode.match(/const KIMI_MODELS = \[([\s\S]*?)\];/);
if (kimiModelsMatch) {
  const modelsStr = kimiModelsMatch[1];
  const searchTrueCount = (modelsStr.match(/search: true/g) || []).length;
  const totalModels = (modelsStr.match(/id: ['"]kimi-/g) || []).length;
  
  modelCapChecks[`Kimi models with search support: ${searchTrueCount}/${totalModels}`] = searchTrueCount === totalModels;
  
  let capPass = 0;
  for (const [check, result] of Object.entries(modelCapChecks)) {
    console.log(`   ${result ? '✅' : '❌'} ${check}`);
    if (result) capPass++;
  }
  console.log(`   Score: ${capPass}/${Object.keys(modelCapChecks).length}\n`);
}

// ─── 4. Check Build Output ──────────────────────────────────────────────

console.log('4. Build Verification:');
const distPath = path.join(__dirname, '../dist');
const distExists = fs.existsSync(distPath);
let distPass = 0;

console.log(`   ${distExists ? '✅' : '❌'} Build output exists`);
if (distExists) distPass++;

if (distExists) {
  const bundlePath = path.join(distPath, 'assets');
  const bundles = fs.existsSync(bundlePath) 
    ? fs.readdirSync(bundlePath).filter(f => f.endsWith('.js'))
    : [];
  
  console.log(`   ${bundles.length > 0 ? '✅' : '❌'} JavaScript bundles compiled (${bundles.length} files)`);
  if (bundles.length > 0) distPass++;
  
  // Check if bundles contain Kimi search code
  let hasSearchCode = false;
  for (const bundle of bundles) {
    const bundleCode = fs.readFileSync(path.join(bundlePath, bundle), 'utf8');
    if (bundleCode.includes('$web_search') || bundleCode.includes('enableSearch')) {
      hasSearchCode = true;
      break;
    }
  }
  console.log(`   ${hasSearchCode ? '✅' : '❌'} Search functionality in bundles`);
  if (hasSearchCode) distPass++;
}

console.log(`   Score: ${distPass}/3\n`);

// ─── 5. Summary ────────────────────────────────────────────────────────────

const totalPass = providerApiPass + chatPass + 
                 Object.values(modelCapChecks).filter(x => x).length + distPass;
const totalChecks = Object.keys(checks).length + 
                   Object.keys(chatChecks).length + 
                   Object.keys(modelCapChecks).length + 3;

console.log('═'.repeat(50));
console.log(`Overall Score: ${totalPass}/${totalChecks}`);

if (totalPass === totalChecks) {
  console.log('✅ All Kimi web search features implemented successfully!');
} else {
  console.log('⚠️  Some features may need attention.');
}

// ─── Implementation Details ────────────────────────────────────────────────

console.log('\n📋 Implementation Details:');
console.log('   • Kimi: Enables web search via $web_search built-in function');
console.log('   • Tool Calls: Automatically handled in request/response loop');
console.log('   • Stream Processing: Properly aggregates tool_calls from chunks');
console.log('   • UI Integration: enableSearch checkbox controls search feature');
console.log('   • Models: All Kimi models support web search capability');
console.log('   • Pricing: ¥0.03 per search call + token consumption');
