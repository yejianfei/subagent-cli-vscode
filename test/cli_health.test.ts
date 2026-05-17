import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareSemver } from '../src/cli_health'

test('compareSemver equal versions', () => {
  assert.equal(compareSemver('0.1.17', '0.1.17'), 0)
})

test('compareSemver patch ordering', () => {
  assert.ok(compareSemver('0.1.18', '0.1.17') > 0)
  assert.ok(compareSemver('0.1.16', '0.1.17') < 0)
})

test('compareSemver minor ordering', () => {
  assert.ok(compareSemver('0.2.0', '0.1.99') > 0)
})

test('compareSemver major ordering', () => {
  assert.ok(compareSemver('1.0.0', '0.99.99') > 0)
})

test('compareSemver missing patch defaults to 0', () => {
  assert.equal(compareSemver('0.1', '0.1.0'), 0)
})
