import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(root, "src");
const forbiddenImports = [
	"@/stores/userStore",
	"@/stores/contentStore",
	"@/lib/auth",
	"@/features/chat",
	"@/features/generation",
	"@/features/prediction-session",
];

const violations = [];

function visit(directory) {
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const filePath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			visit(filePath);
			continue;
		}
		if (!/\.(js|ts|vue)$/.test(entry.name)) continue;
		const source = fs.readFileSync(filePath, "utf8");
		for (const forbiddenImport of forbiddenImports) {
			if (source.includes(forbiddenImport)) {
				violations.push(`${path.relative(root, filePath)} imports ${forbiddenImport}`);
			}
		}
	}
}

visit(sourceRoot);

if (violations.length) {
	console.error(violations.join("\n"));
	process.exitCode = 1;
} else {
	console.log("Standalone boundaries OK.");
}
