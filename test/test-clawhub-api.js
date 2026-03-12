/**
 * ClawHub API Access Test
 *
 * Tests the ClawHub skill registry API endpoints:
 *   - GET /api/v1/search?q=...&type=skill  — Semantic vector search
 *   - GET /api/v1/skills                    — List skills (sorted by downloads)
 *   - GET /api/v1/skills/:slug              — Get specific skill details
 *
 * Base URL: https://clawhub.ai
 *
 * Run: node test/test-clawhub-api.js
 */

const BASE = 'https://clawhub.ai';

let passed = 0;
let failed = 0;

function ok(name, detail) {
  passed++;
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, detail) {
  failed++;
  console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`);
}

async function testSearch() {
  console.log('\n1️⃣  GET /api/v1/search?q=email&type=skill (semantic vector search)');
  console.log('─'.repeat(50));
  try {
    const resp = await fetch(`${BASE}/api/v1/search?q=email&type=skill`, {
      headers: { 'User-Agent': 'LittleShrimp-Test/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    console.log(`   Status: ${resp.status} ${resp.statusText}`);

    if (resp.ok) {
      const body = await resp.json();
      const results = body.results || [];
      console.log(`   Found ${results.length} results`);
      results.slice(0, 3).forEach((r, i) => {
        console.log(`   ${i + 1}. [${r.slug}] ${r.displayName} (score: ${r.score?.toFixed(2)})`);
      });
      ok('Search endpoint', `${results.length} results`);
      return body;
    } else {
      const text = await resp.text();
      fail('Search endpoint', `HTTP ${resp.status}: ${text.slice(0, 200)}`);
      return null;
    }
  } catch (e) {
    fail('Search endpoint', e.message);
    return null;
  }
}

async function testSkillsList() {
  console.log('\n2️⃣  GET /api/v1/skills (list / trending)');
  console.log('─'.repeat(50));
  try {
    const resp = await fetch(`${BASE}/api/v1/skills`, {
      headers: { 'User-Agent': 'LittleShrimp-Test/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    console.log(`   Status: ${resp.status} ${resp.statusText}`);

    if (resp.ok) {
      const body = await resp.json();
      const items = body.items || [];
      console.log(`   Found ${items.length} skills`);
      items.slice(0, 3).forEach((s, i) => {
        console.log(`   ${i + 1}. [${s.slug}] ${s.displayName} — downloads: ${s.stats?.downloads}`);
      });
      ok('Skills list endpoint', `${items.length} skills`);
      return body;
    } else {
      const text = await resp.text();
      fail('Skills list endpoint', `HTTP ${resp.status}: ${text.slice(0, 200)}`);
      return null;
    }
  } catch (e) {
    fail('Skills list endpoint', e.message);
    return null;
  }
}

async function testSkillDetail(slug) {
  console.log(`\n3️⃣  GET /api/v1/skills/${slug} (skill detail)`);
  console.log('─'.repeat(50));
  try {
    const resp = await fetch(`${BASE}/api/v1/skills/${encodeURIComponent(slug)}`, {
      headers: { 'User-Agent': 'LittleShrimp-Test/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    console.log(`   Status: ${resp.status} ${resp.statusText}`);

    if (resp.ok) {
      const body = await resp.json();
      const skill = body.skill || {};
      console.log(`   Slug: ${skill.slug}`);
      console.log(`   Name: ${skill.displayName}`);
      console.log(`   Summary: ${(skill.summary || '').slice(0, 120)}...`);
      console.log(`   Downloads: ${skill.stats?.downloads}`);
      console.log(`   Owner: ${body.owner?.handle || 'N/A'}`);
      ok('Skill detail endpoint', skill.slug);
      return body;
    } else {
      const text = await resp.text();
      fail('Skill detail endpoint', `HTTP ${resp.status}: ${text.slice(0, 200)}`);
      return null;
    }
  } catch (e) {
    fail('Skill detail endpoint', e.message);
    return null;
  }
}

async function main() {
  console.log('═'.repeat(60));
  console.log('CLAWHUB API ACCESS TESTS');
  console.log(`Base URL: ${BASE}`);
  console.log('═'.repeat(60));

  // Test 1: Semantic search
  const searchResult = await testSearch();

  // Test 2: Skills listing
  const listResult = await testSkillsList();

  // Test 3: Skill detail — use a slug from search/list results
  let slug = 'source-library'; // fallback
  if (searchResult?.results?.[0]?.slug) {
    slug = searchResult.results[0].slug;
  } else if (listResult?.items?.[0]?.slug) {
    slug = listResult.items[0].slug;
  }
  await testSkillDetail(slug);

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
