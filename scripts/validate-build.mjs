import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";

const roots = ["src", "scripts", "prisma"];
const ignoredDirectories = new Set(["generated", "node_modules"]);

function collectJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : collectJavaScriptFiles(path);
    }
    return [".js", ".mjs"].includes(extname(entry.name)) ? [path] : [];
  });
}

const files = roots.flatMap(collectJavaScriptFiles);

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log(`Build validation passed for ${files.length} JavaScript files.`);
