// A stop must leave a hub with work in flight alone, and it must not call the console stopped while its process is
// still alive.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const stop = resolve(import.meta.dirname, "../server/stop.mjs");

async function serve(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}

async function runStop(home, args = []) {
  const child = spawn(process.execPath, [stop, ...args], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const [code] = await once(child, "exit");
  return { code, output };
}

test("activeTasks counts the runs a stop would take the hub away from", async (t) => {
  const hub = await serve((req, res) => {
    if (req.url === "/v1/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"totals":{"running":2,"queued":1}}');
    } else res.writeHead(404).end();
  });
  const home = await mkdtemp(join(tmpdir(), "autoloop-active-"));
  t.after(async () => {
    hub.close();
    await rm(home, { recursive: true, force: true });
  });
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ url: `http://127.0.0.1:${hub.address().port}`, owner: "owner-key" }),
  );
  process.env.AGENT_AUTOLOOP_HOME = home;
  const { activeTasks } = await import("../server/process.mjs");
  assert.deepEqual(await activeTasks(), { running: 2, queued: 1, total: 3 });
});

test("stop reports tasks in flight, and only prints success after the console exits", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "autoloop-stop-"));
  const pid = process.pid;
  const seen = [];
  const consoleServer = await serve((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const value = JSON.parse(body || "{}");
      seen.push(value);
      if (value.force) await rm(join(home, "web-client.json"), { force: true });
      res.writeHead(value.force ? 200 : 409, { "Content-Type": "application/json" });
      res.end(value.force ? '{"ok":true,"hubOwned":false}' : '{"error":"还有 1 个任务正在执行、0 个等待执行，暂不停止。"}');
    });
  });
  t.after(async () => {
    consoleServer.close();
    await rm(home, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${consoleServer.address().port}/`;
  const runtime = (pid) =>
    writeFile(join(home, "web-client.json"), JSON.stringify({ pid, url, session: "session", startedAt: new Date().toISOString() }));

  await runtime(pid);
  const refused = await runStop(home);
  assert.equal(refused.code, 1, refused.output);
  assert.match(refused.output, /停止已取消/);
  assert.match(refused.output, /任务/);
  assert.deepEqual(seen, [{ force: false }]);

  const done = spawn(process.execPath, ["-e", ""]);
  await once(done, "exit");
  await runtime(done.pid);
  const forced = await runStop(home, ["--force"]);
  assert.equal(forced.code, 0, forced.output);
  assert.match(forced.output, /--force/);
  assert.equal(seen.at(-1).force, true);
});
