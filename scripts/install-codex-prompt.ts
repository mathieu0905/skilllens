import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(homeDir(), ".codex"));
  const promptsDir = path.join(codexHome, "prompts");
  const sourcePath = path.join(repoRoot, "integrations", "skilllens-codex", "prompts", "skilllens.md");
  const targetPath = path.join(promptsDir, "skilllens.md");
  const template = await readFile(sourcePath, "utf8");
  const rendered = template.split("{{SKILLLENS_ROOT}}").join(repoRoot);

  await mkdir(promptsDir, { recursive: true });
  await writeFile(targetPath, rendered);

  console.log(`Installed Codex slash prompt: ${targetPath}`);
  console.log("Restart Codex or open a new Codex session if /skilllens is not listed immediately.");
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
