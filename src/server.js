import { createApp } from "./app.js";

const PORT = process.env.PORT || 3002;

createApp().listen(PORT, "127.0.0.1", () => {
  console.log(`API running on port ${PORT}`);
});
