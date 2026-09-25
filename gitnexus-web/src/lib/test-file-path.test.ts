import { describe, it, expect } from 'vitest';
import { isTestFilePath } from 'gitnexus-shared';

// Pins the shared predicate to the web bundle's resolution (vitest resolves
// through gitnexus-shared's dist). Full pattern coverage lives in the CLI
// suite (gitnexus/test/unit/test-file-path.test.ts); these cases are the ones
// the web hide-test-files toggle depends on across languages.
describe('isTestFilePath (shared predicate, web resolution)', () => {
  const testPaths = [
    'src/test/java/com/x/FooTest.java', // Maven
    'killshop-order/src/test/java/com/x/SeckillControllerTest.java', // multi-module Maven
    '__tests__/foo.spec.ts',
    'pkg/service_test.go',
    'spec/models/user_spec.rb',
    'ios/MyAppTests/LoginTests.swift',
  ];

  for (const p of testPaths) {
    it(`classifies test path: ${p}`, () => {
      expect(isTestFilePath(p)).toBe(true);
    });
  }

  const productionPaths = [
    'src/main/java/com/x/SeckillService.java',
    'src/fixtures/schema.ts',
    'Contest.swift',
    'Latest.php',
    'src/fruitests/helpers.swift',
    'src/widgets/widgets.ts',
  ];

  for (const p of productionPaths) {
    it(`does not classify production path: ${p}`, () => {
      expect(isTestFilePath(p)).toBe(false);
    });
  }

  it('returns false for nullish input', () => {
    expect(isTestFilePath(null)).toBe(false);
    expect(isTestFilePath(undefined)).toBe(false);
    expect(isTestFilePath('')).toBe(false);
  });
});
