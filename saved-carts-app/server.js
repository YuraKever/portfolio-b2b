import { createServer } from "node:http";
import handler from "./handler.js";

const { PORT = 3000 } = process.env;
createServer(handler).listen(PORT, () => console.log(`saved-carts-app listening on ${PORT}`));
