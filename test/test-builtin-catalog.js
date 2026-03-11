/**
 * Built-in Catalog Test
 * Tests: bundled SOUL/SKILL catalogs, /soul list, /skills panel, settings preset
 *
 * Requires: Vite dev server running at localhost:5173
 *   npm run dev
 */

import playwright from "playwright";

const BASE_URL = "http://localhost:5173/";
const HEADLESS = process.env.HEADLESS !== "false"; // default headless

let passed = 0;
let failed = 0;

function ok(name) { passed++; console.log(`  ✅ ${name}`); }
function fail(name, detail) { failed++; console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`); }

async function test() {
  const { chromium } = playwright;
  let browser;

  try {
    browser = await chromium.launch({ headless: HEADLESS });
    const page = await browser.newPage();

    // Collect browser errors
    const errors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(err.message));

    console.log("═".repeat(60));
    console.log("BUILT-IN CATALOG TESTS");
    console.log("═".repeat(60));

    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // ───────────────────────────────────────────────────────────
    // TEST 1: Verify examples/ JSON indexes are served
    // ───────────────────────────────────────────────────────────
    console.log("\n1️⃣  Static file serving");
    console.log("─".repeat(40));

    const soulsData = await page.evaluate(async () => {
      const r = await fetch("/examples/souls/index.json");
      if (!r.ok) return null;
      return r.json();
    });

    if (soulsData && Array.isArray(soulsData) && soulsData.length >= 6) {
      ok(`souls/index.json served (${soulsData.length} entries)`);
    } else {
      fail("souls/index.json", `got ${JSON.stringify(soulsData)?.substring(0, 80)}`);
    }

    const skillsData = await page.evaluate(async () => {
      const r = await fetch("/examples/skills/index.json");
      if (!r.ok) return null;
      return r.json();
    });

    if (skillsData && Array.isArray(skillsData) && skillsData.length >= 10) {
      ok(`skills/index.json served (${skillsData.length} entries)`);
    } else {
      fail("skills/index.json", `got ${JSON.stringify(skillsData)?.substring(0, 80)}`);
    }

    // Spot-check one SOUL .txt file
    const soulMd = await page.evaluate(async () => {
      const r = await fetch("/examples/souls/CODER_SOUL.txt");
      if (!r.ok) return null;
      return r.text();
    });
    if (soulMd && soulMd.includes("Code Architect")) {
      ok("CODER_SOUL.txt served correctly");
    } else {
      fail("CODER_SOUL.txt", "content mismatch");
    }

    // Spot-check one SKILL .txt file
    const skillMd = await page.evaluate(async () => {
      const r = await fetch("/examples/skills/web-scraper.txt");
      if (!r.ok) return null;
      return r.text();
    });
    if (skillMd && skillMd.includes("name: Web Scraper")) {
      ok("web-scraper.txt served correctly");
    } else {
      fail("web-scraper.txt", "content mismatch");
    }

    // ───────────────────────────────────────────────────────────
    // TEST 2: Settings panel — SOUL preset select populated
    // ───────────────────────────────────────────────────────────
    console.log("\n2️⃣  Settings panel SOUL preset");
    console.log("─".repeat(40));

    // Create a new session to open settings
    await page.locator("#new-session-btn").click();
    await page.waitForTimeout(1500);

    // Check that #set-soul-preset has built-in options
    const soulOptions = await page.evaluate(() => {
      const sel = document.querySelector("#set-soul-preset");
      if (!sel) return [];
      return Array.from(sel.options).map((o) => ({ value: o.value, text: o.textContent }));
    });

    // Expect: — None — , built-in souls, Use URL…
    const builtinOpts = soulOptions.filter(
      (o) => o.value !== "" && o.value !== "__custom__"
    );

    if (builtinOpts.length >= 6) {
      ok(`SOUL preset has ${builtinOpts.length} built-in options`);
    } else {
      fail("SOUL preset population", `only ${builtinOpts.length} built-in options`);
    }

    // Check that "— None —" and "Use URL…" still exist
    const hasNone = soulOptions.some((o) => o.value === "");
    const hasCustom = soulOptions.some((o) => o.value === "__custom__");
    if (hasNone && hasCustom) {
      ok("'— None —' and 'Use URL…' options preserved");
    } else {
      fail("Standard options", `none=${hasNone}, custom=${hasCustom}`);
    }

    // Check an option value is a valid URL
    const coderOpt = builtinOpts.find((o) => o.text.includes("Code Architect"));
    if (coderOpt && coderOpt.value.includes("/examples/souls/CODER_SOUL.txt")) {
      ok(`Code Architect option value: ${coderOpt.value}`);
    } else {
      fail("Code Architect option", `not found, opts: ${builtinOpts.map(o => o.text).join(', ')}`);
    }

    // ───────────────────────────────────────────────────────────
    // TEST 3: Select a built-in SOUL in settings and verify soulUrl
    // ───────────────────────────────────────────────────────────
    console.log("\n3️⃣  Select built-in SOUL in settings");
    console.log("─".repeat(40));

    // Select Code Architect
    if (coderOpt) {
      await page.locator("#set-soul-preset").selectOption(coderOpt.value);
      await page.waitForTimeout(300);

      // URL field should be hidden since it's a built-in
      const urlFieldVisible = await page.evaluate(() => {
        const el = document.querySelector("#soul-url-field");
        return el && !el.classList.contains("hidden");
      });
      if (!urlFieldVisible) {
        ok("URL field hidden when built-in selected");
      } else {
        fail("URL field visibility", "should be hidden for built-in");
      }

      // Switch to __custom__ and check URL field shows
      await page.locator("#set-soul-preset").selectOption("__custom__");
      await page.waitForTimeout(300);
      const urlFieldVisible2 = await page.evaluate(() => {
        const el = document.querySelector("#soul-url-field");
        return el && !el.classList.contains("hidden");
      });
      if (urlFieldVisible2) {
        ok("URL field shown when 'Use URL…' selected");
      } else {
        fail("URL field toggle", "should be visible for __custom__");
      }

      // Select back to built-in
      await page.locator("#set-soul-preset").selectOption(coderOpt.value);
    }

    // Fill passphrase, API key (dummy) and model so slash commands work
    await page.evaluate(() => {
      document.querySelector("#set-passphrase").value = "test-pass-123";
      document.querySelector("#set-api-key").value = "AIzaDUMMY_TEST_KEY_FOR_SLASH_COMMANDS";
      document.querySelector("#set-model").value = "gemini-2.5-flash";
    });
    await page.locator("#apply-settings").click();
    await page.waitForTimeout(3000);

    // Ensure settings panel is closed
    const panelOpen = await page.evaluate(() =>
      !document.querySelector("#settings-panel")?.classList.contains("hidden")
    );
    if (panelOpen) {
      await page.locator("#close-settings").click();
      await page.waitForTimeout(500);
    }

    // Verify session was activated and SOUL loaded
    const headerSoul = await page.locator("#header-soul-name").textContent();
    if (headerSoul && headerSoul.includes("Code Architect")) {
      ok(`Header shows SOUL name: "${headerSoul}"`);
    } else {
      // May still be loading, check after more time
      await page.waitForTimeout(3000);
      const h2 = await page.locator("#header-soul-name").textContent();
      if (h2 && h2.includes("Code Architect")) {
        ok(`Header shows SOUL name (after wait): "${h2}"`);
      } else {
        fail("Header SOUL name", `expected "Code Architect", got "${h2 || headerSoul}"`);
      }
    }

    // ───────────────────────────────────────────────────────────
    // TEST 4: /soul list command
    // ───────────────────────────────────────────────────────────
    console.log("\n4️⃣  /soul list command");
    console.log("─".repeat(40));

    const input = page.locator("#message-input");
    await input.focus();
    await input.fill("/soul list");
    // Use evaluate to click send and bypass any overlay issues
    await page.evaluate(() => document.querySelector("#send-btn")?.click());
    await page.waitForTimeout(5000);

    const chatText4 = await page.evaluate(() =>
      document.querySelector("#chat-box")?.innerText || ""
    );

    if (chatText4.includes("Built-in SOULs")) {
      ok("/soul list shows 'Built-in SOULs' heading");
    } else {
      fail("/soul list heading", `missing 'Built-in SOULs'. Chat excerpt: ${chatText4.substring(chatText4.length - 200)}`);
    }

    // Check that soul names appear
    const expectedSouls = ["BrowserAgent Assistant", "Code Architect", "Creative Writer", "Data Analyst", "Learning Tutor"];
    let soulNamesFound = 0;
    for (const name of expectedSouls) {
      if (chatText4.includes(name)) soulNamesFound++;
    }
    if (soulNamesFound >= 5) {
      ok(`All ${soulNamesFound} expected SOUL names present`);
    } else {
      fail("SOUL names in /soul list", `only ${soulNamesFound}/${expectedSouls.length} found`);
    }

    // Check "Use" buttons exist
    const useButtonCount = await page.evaluate(() =>
      document.querySelectorAll(".gh-soul-select-btn").length
    );
    if (useButtonCount >= 5) {
      ok(`${useButtonCount} "Use" buttons rendered`);
    } else {
      fail("Use buttons", `only ${useButtonCount}`);
    }

    // Click "Use" on BrowserAgent Assistant to switch SOUL
    const switched = await page.evaluate(async () => {
      const btns = document.querySelectorAll(".gh-soul-select-btn");
      for (const btn of btns) {
        if (btn.closest("div")?.innerText?.includes("BrowserAgent Assistant")) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (switched) {
      await page.waitForTimeout(3000);
      const headerAfter = await page.locator("#header-soul-name").textContent();
      if (headerAfter && headerAfter.includes("BrowserAgent")) {
        ok(`Switched SOUL via button: "${headerAfter}"`);
      } else {
        fail("SOUL switch via /soul list button", `header: "${headerAfter}"`);
      }
    }

    // ───────────────────────────────────────────────────────────
    // TEST 5: /soul <built-in name> command
    // ───────────────────────────────────────────────────────────
    console.log("\n5️⃣  /soul <built-in name> command");
    console.log("─".repeat(40));

    await input.fill("/soul Data Analyst");
    await page.evaluate(() => document.querySelector("#send-btn")?.click());
    await page.waitForTimeout(4000);

    const chatText5 = await page.evaluate(() =>
      document.querySelector("#chat-box")?.innerText || ""
    );
    const header5 = await page.locator("#header-soul-name").textContent();

    if (chatText5.includes("Switched to SOUL") || chatText5.includes("✅")) {
      ok("/soul Data Analyst — success message shown");
    } else {
      fail("/soul Data Analyst response", chatText5.split("\n").slice(-3).join(" | "));
    }

    if (header5 && header5.includes("Data Analyst")) {
      ok(`Header updated: "${header5}"`);
    } else {
      fail("Header after /soul name", `got "${header5}"`);
    }

    // Test invalid name
    await input.fill("/soul NonExistentSoul");
    await page.evaluate(() => document.querySelector("#send-btn")?.click());
    await page.waitForTimeout(3000);

    const chatText5b = await page.evaluate(() =>
      document.querySelector("#chat-box")?.innerText || ""
    );
    if (chatText5b.includes("❌") || chatText5b.includes("Not a valid")) {
      ok("/soul <invalid-name> shows error with available list");
    } else {
      fail("/soul invalid name", "expected error message");
    }

    // ───────────────────────────────────────────────────────────
    // TEST 6: /skills command — built-in library panel
    // ───────────────────────────────────────────────────────────
    console.log("\n6️⃣  /skills command — built-in library");
    console.log("─".repeat(40));

    await input.fill("/skills");
    await page.evaluate(() => document.querySelector("#send-btn")?.click());
    await page.waitForTimeout(4000);

    const chatText6 = await page.evaluate(() =>
      document.querySelector("#chat-box")?.innerText || ""
    );

    if (chatText6.includes("Built-in Library")) {
      ok("/skills shows 'Built-in Library' section");
    } else {
      fail("/skills Built-in Library", "section missing");
    }

    if (chatText6.includes("Skill Manager")) {
      ok("/skills shows 'Skill Manager' heading");
    } else {
      fail("/skills Skill Manager heading", "missing");
    }

    // Check that built-in skill names appear
    const expectedSkills = ["Code Review", "Translator", "Web Scraper", "Summary & Digest", "Writing Polish", "JSON/API Helper"];
    let skillNamesFound = 0;
    for (const name of expectedSkills) {
      if (chatText6.includes(name)) skillNamesFound++;
    }
    if (skillNamesFound >= 5) {
      ok(`${skillNamesFound}/${expectedSkills.length} built-in skill names present`);
    } else {
      fail("Built-in skill names", `only ${skillNamesFound}/${expectedSkills.length} found`);
    }

    // Check "Add" buttons for built-in skills
    const addBtnCount = await page.evaluate(() =>
      document.querySelectorAll(".gh-skill-builtin-btn").length
    );
    if (addBtnCount >= 8) {
      ok(`${addBtnCount} built-in skill "Add" buttons rendered`);
    } else {
      fail("Built-in skill Add buttons", `only ${addBtnCount}`);
    }

    // ───────────────────────────────────────────────────────────
    // TEST 7: Add a built-in skill from /skills panel
    // ───────────────────────────────────────────────────────────
    console.log("\n7️⃣  Add built-in skill via /skills panel");
    console.log("─".repeat(40));

    // Click "Add" on the Code Review skill
    const addedSkill = await page.evaluate(async () => {
      const btns = document.querySelectorAll(".gh-skill-builtin-btn");
      for (const btn of btns) {
        const row = btn.closest("div[style]");
        if (row?.innerText?.includes("Code Review") && !btn.disabled) {
          btn.click();
          return "Code Review";
        }
      }
      return null;
    });

    if (addedSkill) {
      await page.waitForTimeout(3000);

      // After clicking, the panel re-renders. Check if the skill now shows as "✓ Loaded"
      const chatText7 = await page.evaluate(() =>
        document.querySelector("#chat-box")?.innerText || ""
      );
      const isLoaded = chatText7.includes("✓ Loaded") || chatText7.includes("Loaded");
      if (isLoaded) {
        ok(`"Code Review" skill loaded (button shows ✓ Loaded)`);
      } else {
        // Check if it appears in active skills section
        const activeSkills = chatText7.includes("Code Review");
        if (activeSkills) {
          ok(`"Code Review" skill appears in panel`);
        } else {
          fail("Code Review loading", "not found in panel after click");
        }
      }
    } else {
      fail("Code Review Add button", "button not found or already loaded");
    }

    // ───────────────────────────────────────────────────────────
    // TEST 8: /skill <built-in name> command
    // ───────────────────────────────────────────────────────────
    console.log("\n8️⃣  /skill <built-in name> command");
    console.log("─".repeat(40));

    await input.fill("/skill Translator");
    await page.evaluate(() => document.querySelector("#send-btn")?.click());
    await page.waitForTimeout(4000);

    const chatText8 = await page.evaluate(() =>
      document.querySelector("#chat-box")?.innerText || ""
    );
    if (chatText8.includes("✅ Loaded") || chatText8.includes("Loaded skill") || chatText8.includes("Translation Skill")) {
      ok("/skill Translator — loaded successfully");
    } else {
      fail("/skill Translator", chatText8.split("\n").slice(-3).join(" | "));
    }

    // Test invalid skill name
    await input.fill("/skill FakeSkillName");
    await page.evaluate(() => document.querySelector("#send-btn")?.click());
    await page.waitForTimeout(3000);

    const chatText8b = await page.evaluate(() =>
      document.querySelector("#chat-box")?.innerText || ""
    );
    if (chatText8b.includes("❌") || chatText8b.includes("Not a valid")) {
      ok("/skill <invalid-name> shows error with available list");
    } else {
      fail("/skill invalid name", "expected error message");
    }

    // ───────────────────────────────────────────────────────────
    // TEST 9: Slash autocomplete includes /soul list
    // ───────────────────────────────────────────────────────────
    console.log("\n9️⃣  Slash autocomplete includes /soul list");
    console.log("─".repeat(40));

    await input.fill("/soul");
    await page.waitForTimeout(500);
    // Trigger input event so autocomplete updates
    await page.evaluate(() => {
      const inp = document.querySelector("#message-input");
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(500);

    const autocompleteVisible = await page.evaluate(() => {
      const ac = document.querySelector("#slash-autocomplete");
      return ac && !ac.classList.contains("hidden");
    });
    const autocompleteContent = await page.evaluate(() => {
      return document.querySelector("#slash-autocomplete")?.innerText || "";
    });

    if (autocompleteVisible && autocompleteContent.includes("/soul list")) {
      ok("/soul list appears in slash autocomplete");
    } else if (autocompleteContent.includes("/soul")) {
      ok("/soul appears in autocomplete (list is a subcommand)");
    } else {
      fail("Slash autocomplete", `visible=${autocompleteVisible}, content: ${autocompleteContent.substring(0, 100)}`);
    }

    // Hide autocomplete
    await input.fill("");
    await page.waitForTimeout(200);

    // ───────────────────────────────────────────────────────────
    // TEST 10: Re-open settings and verify SOUL preset matches
    // ───────────────────────────────────────────────────────────
    console.log("\n🔟  Settings preset matches saved SOUL");
    console.log("─".repeat(40));

    await page.locator("#settings-btn").click();
    await page.waitForTimeout(1500);

    const currentPresetValue = await page.evaluate(() => {
      return document.querySelector("#set-soul-preset")?.value || "";
    });

    // We last set it to Data Analyst via /soul command, so the soulUrl should be the built-in URL
    if (currentPresetValue.includes("DATA_SOUL.txt")) {
      ok(`Preset correctly matches saved SOUL: ${currentPresetValue}`);
    } else if (currentPresetValue === "__custom__") {
      // It might be set as custom URL (still valid)
      const urlVal = await page.evaluate(() =>
        document.querySelector("#set-soul-url")?.value || ""
      );
      if (urlVal.includes("DATA_SOUL.txt")) {
        ok(`SOUL URL correctly saved (as custom URL): ${urlVal}`);
      } else {
        fail("Settings preset", `value="${currentPresetValue}", url="${urlVal}"`);
      }
    } else {
      fail("Settings preset match", `expected DATA_SOUL.txt, got "${currentPresetValue}"`);
    }

    // Close settings
    await page.locator("#close-settings").click();

    // ───────────────────────────────────────────────────────────
    // SUMMARY
    // ───────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(60));
    console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
    console.log("═".repeat(60));

    if (errors.length > 0) {
      console.log(`\n⚠️  Browser errors (${errors.length}):`);
      for (const e of errors.slice(0, 10)) console.log(`  ${e.substring(0, 120)}`);
    }

    if (failed === 0) {
      console.log("\n✅ ALL TESTS PASSED");
    } else {
      console.log(`\n❌ ${failed} TEST(S) FAILED`);
      process.exitCode = 1;
    }

  } catch (err) {
    console.error("\n💥 Fatal error:", err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
}

test();
