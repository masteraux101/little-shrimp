/**
 * test-ui-fixes-simple.js
 * Verify the two UI fixes were properly applied to source code
 */

import fs from 'fs';
import path from 'path';

console.log('════════════════════════════════════════════════════════════');
console.log('UI FIXES - SOURCE CODE VERIFICATION');
console.log('════════════════════════════════════════════════════════════\n');

let passCount = 0;
let failCount = 0;

function check(name, condition) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passCount++;
  } else {
    console.log(`  ❌ ${name}`);
    failCount++;
  }
}

// FIX 1: Link color visibility
console.log('1️⃣  Link Color Fix (cyan for dark background)');
console.log('─'.repeat(60));

const cssPath = path.join(process.cwd(), 'style.css');
const cssContent = fs.readFileSync(cssPath, 'utf-8');

const hasBubbleLink = cssContent.includes('.message-bubble a {');
const hasCyanColor = cssContent.includes('#4ecdc4');
const hasVisitedState = cssContent.includes('.message-bubble a:visited');
const hasHoverState = cssContent.includes('.message-bubble a:hover');
const hasTransition = cssContent.includes('.message-bubble a') && cssContent.includes('transition:');

check('Message bubble <a> tag styling added', hasBubbleLink);
check('Cyan color (#4ecdc4) for links', hasCyanColor);
check('Visited state styling', hasVisitedState);
check('Hover state styling', hasHoverState);
check('Transition effect on links', hasTransition);

// Extract and show the actual color
const colorMatch = cssContent.match(/\.message-bubble a\s*{[^}]*color:\s*(#[0-9a-f]+)/i);
if (colorMatch) {
  console.log(`  ℹ️  Link color: ${colorMatch[1]}`);
}

// FIX 2: Session deletion async handling
console.log('\n2️⃣  Session Deletion Async Safety Fix');
console.log('─'.repeat(60));

const appPath = path.join(process.cwd(), 'src/app.js');
const appContent = fs.readFileSync(appPath, 'utf-8');

const hasAsyncStartNewSession = /async\s+function\s+startNewSession\s*\(/.test(appContent);
const hasAwaitInStartNewSession = appContent.includes('await activateSession(id)');

// Look for the deletion handler pattern
const hasAwaitInDeletion = /if\s*\(\s*entry\.id\s*===\s*currentSessionId\s*\)\s*await\s+startNewSession\s*\(\s*\)/.test(appContent);

check('startNewSession is async function', hasAsyncStartNewSession);
check('activateSession is awaited in startNewSession', hasAwaitInStartNewSession);
check('startNewSession is awaited in deletion handler', hasAwaitInDeletion);

// Show the actual code snippets
if (hasAsyncStartNewSession) {
  const match = appContent.match(/async\s+function\s+startNewSession[^}]*\}/);
  if (match) {
    console.log(`\n  Code snippet:`);
    console.log(`  ${match[0].substring(0, 80)}...`);
  }
}

if (hasAwaitInDeletion) {
  const match = appContent.match(/if\s*\([^)]*currentSessionId[^)]*\)\s*await\s+startNewSession[^\n]*/);
  if (match) {
    console.log(`\n  Deletion code:`);
    console.log(`  ${match[0]}`);
  }
}

// Summary
console.log('\n════════════════════════════════════════════════════════════');
const totalTests = passCount + failCount;
const passPercent = Math.round((passCount / totalTests) * 100);
console.log(`📊 RESULTS: ${passCount}/${totalTests} checks passed (${passPercent}%)`);

if (failCount === 0) {
  console.log('✅ ALL FIXES VERIFIED');
} else {
  console.log(`⚠️  ${failCount} check(s) failed - review the fixes`);
}
console.log('════════════════════════════════════════════════════════════');

process.exit(failCount > 0 ? 1 : 0);
