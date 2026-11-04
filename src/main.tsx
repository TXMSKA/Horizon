import './tokens.css';
import './styles.css';

// The suggestion over a sign-in field is drawn by a small view of its own, which has no browser API; everything else is the chrome.
if (window.horizonVault) void import('./vault-overlay'); else void import('./chrome-main');
