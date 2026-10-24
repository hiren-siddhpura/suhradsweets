import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { operationErrorCode, operationErrorMessage } from '../js/callable-error.js';

test('missing live backend and stopped emulator have different actionable messages', () => {
  const error = { code: 'functions/internal', message: 'internal [0]' };
  assert.match(operationErrorMessage(error, 'live'), /Cloud Function is deployed/);
  assert.match(operationErrorMessage(error, 'emulator'), /Functions emulator on port 5001/);
  assert.match(operationErrorMessage({ code: 'functions/unauthenticated' }), /Sign in again/);
  assert.match(operationErrorMessage({ code: 'functions/permission-denied' }), /permission/);
  assert.match(operationErrorMessage({ code: 'functions/not-found' }, 'live'), /not deployed in us-central1/);
  assert.equal(operationErrorMessage({ code: 'functions/failed-precondition', message: 'A customer with this contact already exists.' }), 'A customer with this contact already exists.');
});

test('callable failure stays rejected and diagnostics exclude customer data', async () => {
  const diagnostics = []; let calls = 0;
  const context = {
    operationErrorCode, operationErrorMessage,
    httpsCallable: () => async () => { calls++; throw { code: 'functions/internal', message: 'internal [0]' }; },
    console: { warn: (...args) => diagnostics.push(args) },
  };
  const source = readFileSync(new URL('../js/operations-data.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInNewContext(`${source}\nthis.call = callOperation; this.configure = configureOperations;`, context);
  const functions = {};
  context.configure(functions, 'live');
  await assert.rejects(context.call(functions, 'saveCustomer', { fullName: 'private-customer-name', contact: 'private-contact' }), /live backend could not be reached/);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-customer-name|private-contact/);
});
