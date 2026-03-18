/**
 * Centralized business API endpoints.
 */

// App update (Lobster-format response)
export const getUpdateCheckUrl = () => 'https://idbots.ai/update.json';

// No fallback download list; updates must provide direct platform URLs.
export const getFallbackDownloadUrl = () => '';
