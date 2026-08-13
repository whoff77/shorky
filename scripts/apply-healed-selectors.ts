import fs from 'fs';
import path from 'path';

const HEALED_JSON_PATH = path.join(__dirname, '../src/fixtures/healed-selectors.json');
const TESTS_DIR = path.join(__dirname, '../tests');

function applyHealedSelectors() {
  if (!fs.existsSync(HEALED_JSON_PATH)) {
    console.log('No healed selectors registry found.');
    return;
  }

  const rawData = fs.readFileSync(HEALED_JSON_PATH, 'utf-8');
  const healedMap: Record<string, string> = JSON.parse(rawData || '{}');

  const brokenSelectors = Object.keys(healedMap);
  if (brokenSelectors.length === 0) {
    console.log('✨ No new healed selectors to apply.');
    return;
  }

  console.log(`🔍 Found ${brokenSelectors.length} healed selector(s). Refactoring spec files...`);

  // Scan all test files in tests/
  const testFiles = fs.readdirSync(TESTS_DIR).filter(f => f.endsWith('.spec.ts') || f.endsWith('.test.ts'));

  let changesMade = 0;

  for (const file of testFiles) {
    const filePath = path.join(TESTS_DIR, file);
    let content = fs.readFileSync(filePath, 'utf-8');
    let fileModified = false;

    for (const [broken, fixed] of Object.entries(healedMap)) {
      if (content.includes(broken)) {
        // Replace all occurrences of the broken selector string with the fixed one
        content = content.replaceAll(broken, fixed);
        fileModified = true;
        changesMade++;
        console.log(`  🩹 Fixed "${broken}" -> "${fixed}" in tests/${file}`);
      }
    }

    if (fileModified) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }

  if (changesMade > 0) {
    // Reset the cache file back to empty since specs are now fixed directly in code
    fs.writeFileSync(HEALED_JSON_PATH, JSON.stringify({}, null, 2), 'utf-8');
    console.log('✅ Applied selector fixes to source code and reset local cache registry.');
  }
}

applyHealedSelectors();