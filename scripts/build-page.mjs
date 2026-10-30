// 把 page/core.js + page/app.js 打成一个经典脚本 page/app.bundle.js。
// Magpie 的插件页面跑在沙箱 iframe（opaque origin）里，ES module 会被 CORS 拦掉，只能用经典脚本。
// 用法：node scripts/build-page.mjs [--check]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = fs.readFileSync(path.join(root, "page/core.js"), "utf8").replace(/^export /gm, "");
const app = fs.readFileSync(path.join(root, "page/app.js"), "utf8").replace(/^import \{[^}]*\} from "\.\/core\.js";\n/m, "");
if (/^import /m.test(app)) throw new Error("page/app.js 只能 import ./core.js");
const out = `// 自动生成，勿手改：node scripts/build-page.mjs\n(function () {\n"use strict";\n${core}\n${app}\n})();\n`;
const file = path.join(root, "page/app.bundle.js");
if (process.argv.includes("--check")) {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (cur !== out) { console.error("page/app.bundle.js 过期，请运行 npm run build"); process.exit(1); }
  console.log("page/app.bundle.js 是最新的");
} else { fs.writeFileSync(file, out); console.log(`wrote ${path.relative(root, file)} (${out.length} bytes)`); }
