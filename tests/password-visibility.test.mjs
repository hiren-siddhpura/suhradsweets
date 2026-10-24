import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initPasswordVisibilityToggle } from '../js/password-visibility.js';

test('login password toggle preserves the password and never submits the form', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="password"[^>]*type="password"/);
  assert.match(html, /id="password-visibility-toggle"[^>]*type="button"/);

  let click;
  const eye = { hidden: false };
  const eyeOff = { hidden: true };
  const input = { type: 'password', value: 'private-test-value', focus() { this.focused = true; } };
  const button = {
    attributes: {},
    addEventListener(type, listener) { if (type === 'click') click = listener; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector(selector) { return selector === '.password-eye-open' ? eye : eyeOff; },
  };
  initPasswordVisibilityToggle({ getElementById(id) { return id === 'password' ? input : button; } });
  click();
  assert.equal(input.type, 'text');
  assert.equal(input.value, 'private-test-value');
  assert.equal(button.attributes['aria-label'], 'Hide password');
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(eye.hidden, true);
  assert.equal(eyeOff.hidden, false);
  click();
  assert.equal(input.type, 'password');
  assert.equal(input.value, 'private-test-value');
  assert.equal(button.attributes['aria-label'], 'Show password');
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal(input.focused, true);
});
