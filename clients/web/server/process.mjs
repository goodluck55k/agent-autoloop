// The native process this console started, and nothing else: stopping reaches only the child it owns, so a hub run by the
// login service, another checkout's hub, or a turn already running is left alone.
import { spawn, execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { readConfig } from "../../../host/config.ts";
import { runningUp } from "../../../host/service.ts";

const cli = resolve(import.meta.dirname, "../../../bin/agent-autoloop.ts");
const exec = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;
let ownedUrl;
let lastOutput = "";
export const processStatus = () => ({ owned: Boolean(child), output: lastOutput });

/**
 * Tasks the hub is still working on: claimed now, or queued for a worker. A stop that would take the hub away from them
 * waits by default. Null means the count could not be read, not that nothing is running.
 */
export async function activeTasks(url) {
  let config;
  try {
    config = readConfig();
  } catch {
    return null;
  }
  if (!config.owner) return null;
  try {
    const response = await fetch((url ?? config.url).replace(/\/$/, "") + "/v1/state", {
      headers: { authorization: "Bearer " + config.owner },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) return null;
    const state = await response.json();
    const running = Number(state?.totals?.running ?? 0);
    const queued = Number(state?.totals?.queued ?? 0);
    return { running, queued, total: running + queued };
  } catch {
    return null;
  }
}

export async function hubHealthy(url) {
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/healthz`, {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

function startHub(url) {
  if (child) return child;
  const next = spawn(process.execPath, [cli, "up"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child = next;
  // Keep the address this child was started for: a later connection edit must not make a stop check another hub.
  ownedUrl = url;
  lastOutput = "";
  for (const pipe of [next.stdout, next.stderr]) {
    pipe.setEncoding("utf8");
    pipe.on("data", (chunk) => {
      lastOutput = (lastOutput + chunk).slice(-6000);
    });
  }
  next.once("error", (error) => {
    lastOutput = `${lastOutput}\n无法启动 up：${error.message}`.slice(-6000);
  });
  next.once("close", () => {
    if (child === next) child = undefined;
    if (child === undefined) ownedUrl = undefined;
  });
  return next;
}

async function launchHub(url) {
  const next = startHub(url);
  await new Promise((resolve, reject) => {
    if (next.exitCode !== null) return reject(new Error(lastOutput.trim() || "原生 up 进程立即退出了"));
    next.once("spawn", resolve);
    next.once("error", reject);
  });
  return next;
}

/**
 * Connect to a hub that already answers, otherwise start the native up process (hub, worker and channels from
 * config.json) and wait until it answers. A hub started by the login service is waited for, never started twice.
 */
export async function ensureHub({ log = () => {}, timeout = 45_000 } = {}) {
  const config = readConfig();
  let url;
  try {
    url = new URL(config.url).toString();
  } catch {
    throw new Error(`config.json 里的 url 不是有效地址：${config.url}`);
  }
  if (await hubHealthy(url)) {
    log(`Hub 已在运行，直接连接：${url}`);
    return { started: false, url };
  }
  if (!config.hub && !config.worker) {
    throw new Error("config.json 里既没有 hub 也没有 worker，无法启动任何原生进程。请先运行 agent-autoloop init。");
  }
  const running = runningUp();
  let launched = false;
  if (running !== null) {
    log(`检测到 Hub 正在启动（进程 ${running}），等待健康检查…`);
  } else {
    log("没有检测到运行中的 Hub，正在通过原生 CLI 启动 Hub 和 Worker…");
    await launchHub(url);
    launched = true;
  }
  const end = Date.now() + timeout;
  for (;;) {
    if (await hubHealthy(url)) {
      log("Hub 健康检查通过。");
      return { started: launched, url };
    }
    // up exits when another process already holds the install: that one is still starting, so wait for it instead.
    if (launched && !child) {
      if (runningUp() !== null) {
        launched = false;
      } else {
        await wait(500);
        if (await hubHealthy(url)) continue;
        break;
      }
    }
    if (Date.now() > end) break;
    await wait(300);
  }
  const output = lastOutput.trim();
  throw new Error(
    `Hub 未能通过健康检查（${url}）。` +
      (output ? `\n\n原生进程输出：\n${output}` : "") +
      "\n\n请运行 node bin/agent-autoloop.ts doctor 查看原因，或检查 config.json 里的 url 和 hub.listen。",
  );
}

export async function command(action) {
  if (action === "start") {
    const config = readConfig();
    if (child || runningUp() !== null) throw new Error("本机已有运行中的 up 进程");
    lastOutput = "";
    await launchHub(config.url);
    return { output: "已调用 up，连接状态以 Hub 响应为准。" };
  }
  if (action === "stop") {
    const result = await stopHub();
    if (!result.owned) throw new Error("只能停止本客户端启动的 up 进程");
    return { output: "已停止本客户端启动的 up 进程。" };
  }
  if (!["doctor", "update"].includes(action)) throw new Error("未知的 CLI 操作");
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, action], { windowsHide: true, maxBuffer: 2 ** 20 });
    return { output: (stdout + stderr).trim() };
  } catch (e) {
    const output = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
    if (action === "doctor" && output) return { output: "诊断发现问题（退出码 " + e.code + "）\n" + output };
    throw new Error(output || e.message);
  }
}

/** Stops only the up process this console started, after its tasks are done unless `force` says otherwise. */
export async function stopHub({ force = false } = {}) {
  const next = child;
  if (!next) return { owned: false };
  if (!force) {
    const active = await activeTasks(ownedUrl);
    if (!active) {
      const error = new Error(
        "无法确认 Hub 上是否还有任务，暂不停止。请稍后重试；确实需要立即停止，请运行 stop.cmd --force。",
      );
      error.status = 409;
      throw error;
    }
    if (active.total) {
      const error = new Error(
        `还有 ${active.running} 个任务正在执行、${active.queued} 个等待执行，暂不停止。` +
          "请等任务完成后再停止；确实需要立即停止，请运行 stop.cmd --force。",
      );
      error.status = 409;
      throw error;
    }
  }
  let timer;
  const closed = await new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => done(false), 5000);
    next.once("close", () => done(true));
    if (next.exitCode !== null) return done(true);
    try {
      next.kill();
    } catch {
      done(next.exitCode !== null);
    }
  });
  if (!closed) throw new Error("中台进程没有在 5 秒内退出，本地控制台仍在运行。");
  return { owned: true };
}

process.on("exit", () => child?.kill());
