import { startStudio } from './studio/server/server.mjs';
const studio = await startStudio({ port: 0, openBrowser: () => {}, advertise: true });
console.log(JSON.stringify({ origin: studio.origin, key: studio.key }));
process.on('SIGTERM', () => studio.close().then(() => process.exit(0)));
