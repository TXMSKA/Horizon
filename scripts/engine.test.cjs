const { test, before } = require('node:test');
const assert = require('node:assert/strict');
let engine;
before(async () => { engine = await import('../packages/engine/dist/index.js'); });

test('engine accepts only web addresses and about:blank at top level', () => {
  for (const url of ['https://example.com/path', 'http://localhost:3000/', 'about:blank', 'https://[::1]:9000/']) assert.equal(engine.isAllowedURL(url), true, url);
  for (const url of ['', null, 7, 'javascript:alert(1)', 'file:///tmp/test', 'data:text/html,test', 'blob:https://example.com/id', 'https://user:pass@example.com/', ' https://example.com', 'https://example.com\n', 'https://exa\tmple.com', `https://example.com/${'a'.repeat(8192)}`]) assert.equal(engine.isAllowedURL(url), false, String(url));
  assert.equal(engine.isWebURL('about:blank'), false);
  assert.equal(engine.isWebURL('https://example.com/'), true);
});
test('engine subframes accept srcdoc, blob and data without accepting privileged schemes', () => {
  for (const url of ['about:srcdoc', 'data:text/html,test', 'blob:https://example.com/id', 'https://example.com/']) assert.equal(engine.isAllowedSubframeURL(url), true);
  for (const url of ['file:///tmp/test', 'javascript:alert(1)', 'horizon://app/', ' data:text/plain,test']) assert.equal(engine.isAllowedSubframeURL(url), false);
});
test('engine classifies addresses and hosts with ports before scheme rejection', () => {
  for (const [input, output] of [[' example.com/path ', 'https://example.com/path'], ['localhost:3000/path', 'https://localhost:3000/path'], ['example.com:8080', 'https://example.com:8080/'], ['[::1]:3000', 'https://[::1]:3000/'], ['http://example.com', 'http://example.com/'], ['about:blank', 'about:blank']]) assert.equal(engine.classifyInput(input), output);
});
test('engine classifies search text with the host search prefix', () => {
  assert.equal(engine.classifyInput('two words & more', 'https://search.example/?q='), 'https://search.example/?q=two%20words%20%26%20more');
  assert.equal(engine.classifyInput('word'), 'https://duckduckgo.com/?q=word');
  assert.throws(() => engine.classifyInput('two words', 'javascript:'), /Invalid address/);
});
test('engine refuses schemes, controls, empty input and oversized input', () => {
  for (const input of ['javascript:alert(1)', 'file:///tmp/test', 'data:text/html,test', 'horizon://app/']) assert.throws(() => engine.classifyInput(input), /Unsupported address scheme/);
  for (const input of ['', ' ', 'exa\tmple.com', 'search\ntext', 'search\x7ftext', 'a'.repeat(8193), null]) assert.throws(() => engine.classifyInput(input), /Invalid address/);
  assert.equal(engine.parseErrorName('net::ERR_CONNECTION_REFUSED'), 'ERR_CONNECTION_REFUSED');
  assert.equal(engine.parseErrorName('unknown failure'), 'ERR_FAILED');
});
test('engine blocking policy forces protections in private mode and respects site exceptions', () => {
  for (const privateMode of [false, true]) for (const ads of [false, true]) for (const cookies of [false, true]) for (const site of [false, true]) {
    assert.deepEqual(engine.blockingPolicy(privateMode, ads, cookies, site), { filters: privateMode || ads && site, thirdPartyCookies: privateMode || cookies && site });
  }
});
test('engine cosmetic CSS permits hiding rules and refuses resource or active CSS', () => {
  assert.deepEqual(engine.safeCosmeticCSS('.ad { display:none!important }'), { css: '.ad { display: none !important; }', rules: 1 });
  for (const css of ['.ad { background:url(https://tracker.example/) }', '@import "https://tracker.example/";', '.ad { display:none!important; color:red }', '.ad { display:expression(alert(1)) }', '.ad\\31 { display:none!important }', '@font-face { display:none!important }']) assert.equal(engine.safeCosmeticCSS(css).rules, 0, css);
  assert.equal(engine.safeCosmeticCSS('.ad {display:none!important} .tracker {display:none!important;}').rules, 2);
});
