// Starts the app. Listens on all interfaces so phones on the Wi-Fi (and the
// tunnel, in a later step) can reach it.
import { openDb, closeDb } from './db.js';
import { createApp, APP_VERSION } from './app.js';

const PORT = Number(process.env.PORT || 4300);

openDb();
const server = createApp().listen(PORT, '0.0.0.0', () => {
  console.log(`Sheet Metal ${APP_VERSION} — http://localhost:${PORT}`);
});

const shutdown = () => server.close(() => { closeDb(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
