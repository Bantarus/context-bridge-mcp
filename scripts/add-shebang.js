#!/usr/bin/env node
import { readFile, writeFile, chmod } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SHEBANG = "#!/usr/bin/env node\n";

// Every file package.json lists under "bin"
for (const bin of ["index.js", "beam.js"]) {
  const target = resolve(here, "..", "dist", bin);
  const content = await readFile(target, "utf-8");
  if (!content.startsWith("#!")) {
    await writeFile(target, SHEBANG + content, "utf-8");
  }
  await chmod(target, 0o755);
}
