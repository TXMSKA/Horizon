const { test } = require('node:test');
const assert = require('node:assert/strict');
const { popupPosition } = require('../dist/src/shared/popup-position.js');

test('Desktop menus open below when their full height fits', () => {
  assert.deepEqual(popupPosition({ top: 100, bottom: 132 }, 500, 200, 6), { side: 'below', top: 138, availableHeight: 362 });
  assert.deepEqual(popupPosition({ top: 100, bottom: 132 }, 338, 200, 6), { side: 'below', top: 138, availableHeight: 200 });
});

test('Desktop menus open six pixels above when the larger side is above', () => {
  assert.deepEqual(popupPosition({ top: 400, bottom: 432 }, 500, 200, 6), { side: 'above', top: 194, availableHeight: 394 });
  assert.deepEqual(popupPosition({ top: 200, bottom: 232 }, 350, 300, 6), { side: 'above', top: 0, availableHeight: 194 });
});

test('Desktop menus retain the lower side when it offers at least as much space', () => {
  assert.deepEqual(popupPosition({ top: 100, bottom: 132 }, 300, 250, 6), { side: 'below', top: 138, availableHeight: 162 });
  assert.deepEqual(popupPosition({ top: 100, bottom: 132 }, 232, 200, 6), { side: 'below', top: 138, availableHeight: 94 });
  assert.deepEqual(popupPosition({ top: 0, bottom: 32 }, 35, 200, 6), { side: 'below', top: 38, availableHeight: 0 });
});
