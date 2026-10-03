import { B as BrowserWindow, b as baseName, a as app } from "./index.mjs";
import { join } from "path";
import "http";
import "fs";
import "crypto";
import "ws";
import "os";
import "url";
import "child_process";
import "@vscode/ripgrep";
import "fuzzysort";
import "vscode-jsonrpc/node.js";
import "util";
import "net";
import "simple-git";
import "dgram";
function createPopoutWindow(path) {
  const appRoot = app.getAppPath();
  const preloadPath = join(appRoot, "out", "preload", "index.mjs");
  const rendererHtml = join(appRoot, "out", "renderer", "index.html");
  const win = new BrowserWindow({
    width: 1e3,
    height: 720,
    minWidth: 480,
    minHeight: 320,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    title: baseName(path) || "OpenDev IDE",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });
  win.on("ready-to-show", () => win.show());
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  const q = `popout=1&path=${encodeURIComponent(path)}`;
  if (devUrl) {
    win.loadURL(`${devUrl}?${q}`);
  } else {
    win.loadFile(rendererHtml, { search: q });
  }
}
function createPopoutAiWindow(opts = {}) {
  const appRoot = app.getAppPath();
  const preloadPath = join(appRoot, "out", "preload", "index.mjs");
  const rendererHtml = join(appRoot, "out", "renderer", "index.html");
  const win = new BrowserWindow({
    width: 880,
    height: 760,
    minWidth: 420,
    minHeight: 360,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 14 },
    title: opts.name || "AI Chat",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  });
  win.on("ready-to-show", () => win.show());
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  const params = new URLSearchParams();
  params.set("popout", "ai");
  if (opts.conversationId) params.set("convId", opts.conversationId);
  if (opts.name) params.set("name", opts.name);
  if (opts.initialPrompt) params.set("prompt", opts.initialPrompt);
  const q = params.toString();
  if (devUrl) {
    win.loadURL(`${devUrl}?${q}`);
  } else {
    win.loadFile(rendererHtml, { search: q });
  }
}
export {
  createPopoutAiWindow,
  createPopoutWindow
};
