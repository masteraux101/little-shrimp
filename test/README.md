# Test Suite

This directory contains essential integration and verification tests for the BrowserAgent project.

## Test Files

### test-builtin-catalog.js
Verifies that built-in SOUL and SKILL files are correctly bundled into the production build.

**What it tests:**
- Bundled SOUL files are accessible at `/examples/souls/`
- Bundled SKILL files are accessible at `/examples/skills/`
- Index files properly reference all bundled files
- File format (.txt) is correct

**Run:** `node test/test-builtin-catalog.js`

### test-multi-provider.js
Validates support for multiple AI model providers (Gemini, Qwen, Kimi).

**What it tests:**
- Provider detection from model names
- Model list includes all providers
- Provider-specific configuration options

**Run:** `node test/test-multi-provider.js`

### test-ui-fixes-simple.js
Verifies UI fixes for link colors and session state management.

**What it tests:**
- Link color CSS rules (cyan #4ecdc4 for dark background)
- Session state management code structure
- Async/await patterns in critical functions

**Run:** `node test/test-ui-fixes-simple.js`

### test-session-deletion-simple.js
Validates that deleting a session properly resets the UI state.

**What it tests:**
- applySettings function is async
- activateSession is awaited in applySettings
- startNewSession is async with proper await
- Deletion handler checks available sessions correctly
- Input field is properly disabled when no sessions exist

**Run:** `node test/test-session-deletion-simple.js`

## Running All Tests

```bash
npm run test
```

This will execute all test files in sequence.

## Adding New Tests

When adding new features:
1. Add a focused test file (e.g., `test-feature-name.js`)
2. Target only one feature or concern per test file
3. Use clear, descriptive names
4. Include comments explaining what's being tested
5. Return a helpful summary on success/failure

## Cleanup Rationale

Removed redundant test files:
- Duplicate versions covering the same functionality (kept the simplified versions)
- Debugging-specific tests (replaced with proper logging)
- Feature-specific tests that aren't part of core flow
