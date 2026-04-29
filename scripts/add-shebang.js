#!/usr/bin/env node
import { readFile, writeFile, chmod } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "..", "dist", "index.js");
const SHEBANG = "#!/usr/bin/env node\n";

const content = await readFile(target, "utf-8");
if (!content.startsWith("#!")) {
  await writeFile(target, SHEBANG + content, "utf-8");
}
await chmod(target, 0o755);
