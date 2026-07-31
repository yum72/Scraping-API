import UserAgent from 'user-agents';

const desktop = new UserAgent({ deviceCategory: 'desktop' });

/**
 * Returns a plausible desktop user agent string.
 *
 * Only used on the plain-fetch path. The browser path leaves the user agent
 * alone, because cloakbrowser matches it to the rest of the fingerprint it
 * presents and overriding one half of that is what gets you detected.
 *
 * @returns {string}
 */
export const getRandomUserAgent = () => desktop.random().toString();
