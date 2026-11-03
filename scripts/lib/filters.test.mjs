import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDesignRole, isInIsrael, guessLevel, minYears } from './filters.mjs';

test('design roles', () => {
  for (const t of ['Product Designer', 'UX/UI Designer', 'Senior UI/UX Product Designer', 'UX Designer, Waze', 'Product Designer (UX/UI) - Base44', 'Associate Product Designer'])
    assert.ok(isDesignRole(t), t);
  for (const t of ['Graphic Designer', 'Industrial Designer', 'Physical Design Engineer', 'Frontend Developer (UI/UX)', 'Mechanical Designer', 'Product Manager', 'UI Artist'])
    assert.ok(!isDesignRole(t), t);
});

test('israel locations', () => {
  for (const l of ['Tel Aviv-Yafo, Tel Aviv District, Israel', 'Israel - Tel Aviv', 'Petach Tikva', 'Raanana', 'TLV', 'Herzliya, IL'])
    assert.ok(isInIsrael(l), l);
  for (const l of ['New York, NY', 'London, UK', 'Remote - United States'])
    assert.ok(!isInIsrael(l), l);
});

test('levels', () => {
  assert.equal(guessLevel('Junior Product Designer'), 'Junior');
  assert.equal(guessLevel('Senior Product Designer'), 'Senior+');
  assert.equal(guessLevel('Product Designer', '2-3 years of experience designing web apps'), 'Junior');
  assert.equal(guessLevel('Product Designer', '5+ years of experience'), 'Senior+');
  assert.equal(guessLevel('Product Designer', '3+ years of product design'), 'Mid');
  assert.equal(minYears('no numbers here'), null);
  // Wiz: the higher requirement wins
  assert.equal(guessLevel('Product Designer', '4+ years of experience in UX design. 2+ years of experience designing interfaces for B2B'), 'Mid');
  // company history is not a requirement
  assert.equal(minYears('Founded 10 years ago. 3+ years of product design experience'), 3);
  assert.equal(minYears('Approximately 5 years of product or UX/UI design experience'), 5);
});
