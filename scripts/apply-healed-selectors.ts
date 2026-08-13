import fs from 'fs';
import path from 'path';

const HEALED_JSON_PATH = path.join(__dirname, '../src/fixtures/healed-selectors.json');
const TESTS_DIR = path.join(__dirname, '../tests');

function applyHealedSelectors() {
  if (!fs.existsSync(HEALED_JSON_PATH)) {
    console.log('No healed selectors registry found.');
    process.exit(0);
  }

  const rawData = fs.readFileSync(HEALED_JSON_PATH, 'utf-8');
  const healedMap: Record<string, string> = JSON.parse(rawData || '{}');

  const brokenSelectors = Object.keys(healedMap);
  if (brokenSelectors.length === 0) {
    console.log('✨ No new healed selectors to apply.');
    process.exit(0);
  }

  console.log(`🔍 Found ${brokenSelectors.length} healed selector(s). Refactoring spec files...`);

  const testFiles = fs.readdirSync(TESTS_DIR).filter(f => f.endsWith('.spec.ts') || f.endsWith('.test.ts'));
  let changesMade = 0;

  for (const file of testFiles) {
    const filePath = path.join(TESTS_DIR, file);
    let content = fs.readFileSync(filePath, 'utf-8');
    let fileModified = false;

    for (const [broken, fixed] of Object.entries(healedMap)) {
      if (content.includes(broken)) {
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

  // Always clear the JSON cache file so it stays empty on main
  fs.writeFileSync(HEALED_JSON_PATH, JSON.stringify({}, null, 2), 'utf-8');

  if (changesMade === 0) {
    console.log('ℹ️ No spec files contained matching broken selector strings.');
  } else {
    console.log(`✅ Refactored ${changesMade} selector(s) across spec files and cleared cache.`);
  }
}

applyHealedSelectors();