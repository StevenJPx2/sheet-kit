// Bundled agent skills, served from the package so guidance always matches the
// installed version. The hidden stub in skills/ is a discovery pointer
// (`sheet-kit skills install`); the real content lives in skill-data/ and is
// served by `sheet-kit skills get`.
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

const pkgRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Discover skills/<dir>/SKILL.md and skill-data/<dir>/SKILL.md with frontmatter. */
function discoverSkills() {
  const out = [];
  for (const root of ["skills", "skill-data"]) {
    const base = join(pkgRoot, root);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      const meta = parseFrontmatter(join(dir, "SKILL.md"));
      out.push({ name: meta.name || entry.name, meta, dir });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function parseFrontmatter(path) {
  const text = readFileSync(path, "utf8");
  const meta = {};
  if (!text.startsWith("---\n")) return meta;
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return meta;
  for (const line of text.slice(4, end).split("\n")) {
    const m = /^(name|description|hidden):\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = m[1] === "hidden" ? m[2].trim() === "true" : m[2].trim();
  }
  return meta;
}

function findSkill(skills, name) {
  return skills.find((s) => s.name === name);
}

function printSkill(s, full) {
  process.stdout.write(readFileSync(join(s.dir, "SKILL.md"), "utf8"));
  if (!full) return;
  const refs = join(s.dir, "references");
  if (!existsSync(refs)) return;
  for (const f of readdirSync(refs).sort()) {
    process.stdout.write(`\n--- references/${f} ---\n`);
    process.stdout.write(readFileSync(join(refs, f), "utf8"));
  }
}

/** cmdSkills implements `sheet-kit skills`. */
export function cmdSkills(args) {
  const skills = discoverSkills();
  const [sub, ...rest] = args;

  if (!sub || sub === "list") {
    for (const s of skills) {
      if (s.meta.hidden) continue;
      const desc = (s.meta.description || "").slice(0, 70);
      process.stdout.write(`  ${s.name.padEnd(10)} ${desc}\n`);
    }
    return 0;
  }

  if (sub === "install") return install(skills);

  if (sub === "get") {
    const full = rest.includes("--full");
    const names = rest.filter((a) => a !== "--full");
    if (names.length === 0) {
      process.stderr.write("skills: `get` requires a skill name\n");
      return 2;
    }
    let first = true;
    for (const name of names) {
      const s = findSkill(skills, name);
      if (!s) {
        process.stderr.write(`skill ${JSON.stringify(name)} not found (see \`sheet-kit skills list\`)\n`);
        return 1;
      }
      if (!first) process.stdout.write("\n---\n");
      first = false;
      printSkill(s, full);
    }
    return 0;
  }

  process.stderr.write("skills: unknown arguments (use list, get <name> [--full], install)\n");
  return 2;
}

// install writes the hidden stub into the agent skills dir
// (~/.claude/skills/sheet-kit by default, or SHEET_KIT_SKILLS_DIR).
function install(skills) {
  const stub = findSkill(skills, "sheet-kit");
  if (!stub) {
    process.stderr.write("no stub skill to install\n");
    return 1;
  }
  const dir = process.env.SHEET_KIT_SKILLS_DIR || join(homedir(), ".claude", "skills");
  const target = join(dir, stub.name);
  mkdirSync(target, { recursive: true });
  const out = join(target, "SKILL.md");
  writeFileSync(out, readFileSync(join(stub.dir, "SKILL.md")));
  process.stdout.write(`Installed sheet-kit skill stub to ${out}\nRun \`sheet-kit skills get core\` for the usage guide.\n`);
  return 0;
}
