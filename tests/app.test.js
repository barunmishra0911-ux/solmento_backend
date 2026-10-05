import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-jwt-signing";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";

const { createApp } = await import("../src/app.js");

test("health endpoint reports a healthy backend", async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.status, "ok");
  server.close();
});

test("protected me endpoint rejects requests without a JWT", async () => {
  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).success, false);
  server.close();
});
