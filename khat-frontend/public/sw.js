/* Tehseen al-Khat — minimal service worker so the site can be installed as an app.
   It does not cache pages or API data: everything always comes fresh from the network. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network as usual */ });
