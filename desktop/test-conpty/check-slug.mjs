// Verify projectSlug() against observed slugs in ~/.claude/projects/
const cases = [
  ['C:\\Users\\example', 'C--Users-example'],
  ['C:\\Users\\example\\AppData\\Local\\Temp', 'C--Users-example-AppData-Local-Temp'],
  ['C:\\Users\\example\\youcoded-dev', 'C--Users-example-youcoded-dev'],
];
const projectSlug = (cwd) => cwd.replace(/[\\/:]/g, '-');
for (const [input, expected] of cases) {
  const got = projectSlug(input);
  const ok = got === expected;
  console.log(`${ok ? 'OK' : 'FAIL'}  ${JSON.stringify(input)} -> ${JSON.stringify(got)} (expected ${JSON.stringify(expected)})`);
}
