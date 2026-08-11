import { createServer } from 'vite';

async function main() {
  const server = await createServer({
    configFile: './vite.config.js'
  });
  
  try {
    const mod = await server.ssrLoadModule('/src/pages/RoomBoard.jsx');
    console.log("Success:", Object.keys(mod));
  } catch (e) {
    console.error("Error loading module:");
    console.error(e);
  }
  await server.close();
}
main();
