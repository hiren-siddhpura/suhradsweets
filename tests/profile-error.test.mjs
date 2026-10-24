import test from 'node:test';
import assert from 'node:assert/strict';
import { firebaseErrorCode, profileReadErrorMessage } from '../js/profile-error.js';

test('profile read errors distinguish denied access and unreachable services', () => {
  assert.match(profileReadErrorMessage({ code: 'permission-denied' }, false), /published Firestore Rules/);
  assert.match(profileReadErrorMessage({ code: 'permission-denied' }, true), /emulator Rules/);
  assert.match(profileReadErrorMessage({ code: 'unavailable' }, true), /Firestore emulator could not be reached/);
  assert.match(profileReadErrorMessage({ code: 'unavailable' }, false), /network connection/);
});

test('diagnostics keep only safe Firebase error codes', () => {
  assert.equal(firebaseErrorCode({ code: 'firestore/permission-denied' }), 'permission-denied');
  assert.equal(firebaseErrorCode({ code: 'unavailable' }), 'unavailable');
  assert.equal(firebaseErrorCode({ code: 'private data: token=abc' }), 'unknown');
});
