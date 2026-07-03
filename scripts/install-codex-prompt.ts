import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(homeDir(), ".codex"));
  const promptsDir = path.join(codexHome, "prompts");
  const sourcePath = path.join(repoRoot, "integrations", "skillscope-codex", "prompts", "skillscope.md");
  const targetPath = path.join(promptsDir, "skillscope.md");
  const oldPromptPath = path.join(promptsDir, "skilllens.md");
  const template = await readFile(sourcePath, "utf8");
  const rendered = template.split("{{SKILLSCOPE_ROOT}}").join(repoRoot);

  await mkdir(promptsDir, { recursive: true });
  await writeFile(targetPath, rendered);
  await rm(oldPromptPath, { force: true });

  console.log(`Installed Codex slash prompt: ${targetPath}`);
  console.log(`Removed old Codex slash prompt if present: ${oldPromptPath}`);
  console.log("Restart Codex or open a new Codex session if /skillscope is not listed immediately.");
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
