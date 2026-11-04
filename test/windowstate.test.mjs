// Ported with src/windowstate.js from Getway Chat desktop (vasyaod/agent-getway-desktop).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT, MIN, restore, snapshot } from '../src/windowstate.js';

const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
  { workArea: { x: 1920, y: 0, width: 1280, height: 1024 } }];

test('restore: saved bounds back on a connected display', () => {
  assert.deepEqual(restore({ x: 100, y: 80, width: 900, height: 700, maximized: true }, displays),
    { x: 100, y: 80, width: 900, height: 700, maximized: true });
  assert.deepEqual(restore({ x: 2000, y: 10, width: 800, height: 600, maximized: false }, displays),
    { x: 2000, y: 10, width: 800, height: 600, maximized: false }, 'the second monitor');
});

test('restore: a monitor gone since, nothing saved, or junk opens the default, centred', () => {
  assert.deepEqual(restore({ x: 4000, y: 10, width: 800, height: 600, maximized: false }, displays),
    { width: 800, height: 600, maximized: false });
  assert.deepEqual(restore({ x: 100, y: -500, width: 800, height: 600, maximized: false }, displays),
    { width: 800, height: 600, maximized: false }, 'title bar above every screen');
  assert.deepEqual(restore({ x: 'a', width: 10, height: 10, maximized: false }, displays), { ...MIN, maximized: false });
});

// Issue #31: the app opens maximized by default. Only a saved `maximized: false` — the user
// un-maximized it — opens it at the normal size.
test('restore: a first launch opens maximized; a saved un-maximize is kept', () => {
  assert.deepEqual(restore(null, displays), { ...DEFAULT, maximized: true }, 'nothing saved');
  assert.deepEqual(restore(undefined, displays), { ...DEFAULT, maximized: true });
  assert.deepEqual(restore({ x: 'a', width: 10, height: 10 }, displays), { ...MIN, maximized: true }, 'junk, no flag');
  assert.deepEqual(restore({ x: 100, y: 80, width: 900, height: 700 }, displays),
    { x: 100, y: 80, width: 900, height: 700, maximized: true }, 'a file without the flag');
  assert.deepEqual(restore({ x: 100, y: 80, width: 900, height: 700, maximized: false }, displays),
    { x: 100, y: 80, width: 900, height: 700, maximized: false }, 'the user un-maximized it');
});

test('snapshot keeps the normal bounds and the maximized flag', () => {
  assert.deepEqual(snapshot({ x: 1, y: 2, width: 3, height: 4 }, 1), { x: 1, y: 2, width: 3, height: 4, maximized: true });
});
