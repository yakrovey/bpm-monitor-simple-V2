import { createServer } from './server-lib.mjs';

const PORT = Number(process.env.STAND_PORT || 4177);
const server = createServer();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`BPM virtual stand: http://127.0.0.1:${PORT}/`);
});
