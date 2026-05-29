import { execFileSync } from "node:child_process";

const allowedFiles = new Set([
    "index.html",
    "styles.css",
    "script.js",
    "src/script-source.js",
    "data/site-lineage.json",
]);
const allowedPrefixes = ["data/signals/", "assets/", "images/", "media/"];
const protectedPrefixes = ["api/", "scripts/", ".github/"];
const protectedFiles = new Set([
    "package.json",
    "package-lock.json",
    "vercel.json",
    ".gitignore",
    "logo.png",
    "README.md",
]);

function git(args) {
    return execFileSync("git", args, { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

const changed = new Set([
    ...git(["diff", "--name-only"]),
    ...git(["diff", "--name-only", "--cached"]),
    ...git(["ls-files", "--others", "--exclude-standard"]),
]);
const violations = [];

for (const filePath of changed) {
    const allowed =
        allowedFiles.has(filePath) ||
        allowedPrefixes.some((prefix) => filePath.startsWith(prefix));
    const protectedPath =
        protectedFiles.has(filePath) ||
        protectedPrefixes.some((prefix) => filePath.startsWith(prefix));

    if (protectedPath) {
        violations.push(`${filePath} is protected from automated Codex edits.`);
    } else if (!allowed) {
        violations.push(`${filePath} is outside the automated chaos allowlist.`);
    }
}

if (violations.length) {
    for (const violation of violations) console.error(`- ${violation}`);
    throw new Error("Codex output touched protected or unsupported files.");
}

console.log("Codex output stayed inside the chaos allowlist.");
