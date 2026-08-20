import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const htmlFiles = ["index.html", "order.html", "cashier.html", "dashboard.html"];
const missing = [];

JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
new vm.SourceTextModule(fs.readFileSync(path.join(root, "app.js"), "utf8"), { identifier: "app.js" });
new vm.SourceTextModule(fs.readFileSync(path.join(root, "sw.js"), "utf8"), { identifier: "sw.js" });

for (const file of htmlFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const modules = [...source.matchAll(/<script\s+type="module">([\s\S]*?)<\/script>/gi)];
  for (const [index, match] of modules.entries()) {
    new vm.SourceTextModule(match[1], { identifier: `${file}#module-${index + 1}` });
  }
  for (const match of source.matchAll(/(?:src|href)="([^"]+)"/gi)) {
    const ref = match[1];
    if (ref.includes("${") || /^(?:https?:|#|data:|mailto:|tel:)/i.test(ref)) continue;
    const clean = ref.split(/[?#]/)[0];
    if (clean && !fs.existsSync(path.resolve(root, clean))) missing.push(`${file}: ${ref}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
for (const icon of manifest.icons ?? []) {
  if (!fs.existsSync(path.resolve(root, icon.src))) missing.push(`manifest: ${icon.src}`);
}

if (missing.length) {
  console.error(`Missing local assets:\n${missing.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Static syntax and local asset checks passed.");
}
