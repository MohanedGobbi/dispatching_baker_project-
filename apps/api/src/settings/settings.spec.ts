import { describe, it, expect } from 'vitest';
import { validateSetting } from './settings';

describe('validateSetting', () => {
  it('accepts matching types', () => {
    expect(validateSetting('rules.maxConsecutiveDays', 42)).toBeNull();
    expect(validateSetting('rules.chiefRequired', false)).toBeNull();
    expect(validateSetting('org.workingDays', '1111100')).toBeNull();
  });
  it('rejects unknown keys, wrong types, negatives', () => {
    expect(validateSetting('nope', 1)).toMatch(/Unknown/);
    expect(validateSetting('rules.chiefRequired', 'yes')).toMatch(/boolean/);
    expect(validateSetting('rules.maxConsecutiveDays', -1)).toMatch(/non-negative/);
    expect(validateSetting('rules.maxConsecutiveDays', 'x')).toMatch(/number/);
  });
});
