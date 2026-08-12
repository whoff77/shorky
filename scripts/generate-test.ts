import { generateTestSpec } from '../src/utils/testGenerator';

const targetUrl = process.argv[2] || '[https://the-internet.herokuapp.com/login](https://the-internet.herokuapp.com/login)';
const prompt = process.argv[3] || 'Log in using username "tomsmith" and password "SuperSecretPassword!", then verify the success banner.';
const fileName = process.argv[4] || 'generated-login.spec.ts';

generateTestSpec(targetUrl, prompt, fileName).catch((err) => {
  console.error('❌ Error generating test:', err);
  process.exit(1);
});