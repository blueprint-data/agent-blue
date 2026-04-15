import readline from "node:readline/promises";
import { DbtModelInfo } from "../core/types.js";
import { DbtRepositoryService } from "../core/interfaces.js";
import { ask, log, ui } from "./prompt.js";

interface GroupedModels {
  [folder: string]: DbtModelInfo[];
}

function groupModelsByFolder(models: DbtModelInfo[]): GroupedModels {
  const groups: GroupedModels = {};
  for (const model of models) {
    const parts = model.relativePath.replace(/\\/g, "/").split("/");
    const folder = parts.length > 1 ? parts.slice(0, -1).join("/") : "(root)";
    if (!groups[folder]) groups[folder] = [];
    groups[folder].push(model);
  }
  return groups;
}

function displayModelList(models: DbtModelInfo[], startIndex: number): void {
  for (let i = 0; i < models.length; i++) {
    const idx = startIndex + i;
    log(
      `    ${ui.dim(String(idx + 1).padStart(4, " "))} ${models[i].name} ${ui.dim(`(${models[i].relativePath})`)}`
    );
  }
}

export async function selectModels(
  rl: readline.Interface,
  dbt: DbtRepositoryService,
  tenantId: string
): Promise<DbtModelInfo[]> {
  const allModels = await dbt.listModels(tenantId);

  if (allModels.length === 0) {
    log(
      `  ${ui.warn("No dbt models found.")} Make sure the repo is synced (npm run dev -- sync-dbt --tenant ${tenantId}).`
    );
    return [];
  }

  log(`\n  ${ui.bold("dbt Models")} — ${allModels.length} models found\n`);

  const grouped = groupModelsByFolder(allModels);
  const folders = Object.keys(grouped).sort();

  log(`  ${ui.bold("Folders:")}`);
  for (let i = 0; i < folders.length; i++) {
    log(
      `    ${ui.dim(String(i + 1).padStart(4, " "))} ${folders[i]} ${ui.dim(`(${grouped[folders[i]].length} models)`)}`
    );
  }

  log(
    `\n  ${ui.dim("Selection options:")}`
  );
  log(`    ${ui.dim("- Type folder numbers to select all models in those folders (e.g. 1,3,5)")}`);
  log(`    ${ui.dim('- Type "all" to select everything')}`);
  log(`    ${ui.dim('- Type "search <term>" to filter by name')}`);
  log(`    ${ui.dim('- Type "list <folder#>" to see models in a folder')}`);
  log(`    ${ui.dim('- Type "pick" to enter individual model selection mode')}`);

  const selected = new Set<string>();

  while (true) {
    const input = await ask(rl, `\nSelect models (${selected.size} selected)`);
    const cmd = input.toLowerCase().trim();

    if (cmd === "done" || (cmd === "" && selected.size > 0)) {
      break;
    }

    if (cmd === "all") {
      for (const m of allModels) selected.add(m.name);
      log(`  ${ui.success(`Selected all ${allModels.length} models.`)}`);
      break;
    }

    if (cmd.startsWith("search ")) {
      const term = cmd.slice(7).trim().toLowerCase();
      const matches = allModels.filter(
        (m) =>
          m.name.toLowerCase().includes(term) ||
          m.relativePath.toLowerCase().includes(term)
      );
      if (matches.length === 0) {
        log(`  ${ui.warn("No models matching")} "${term}"`);
      } else {
        log(`  ${ui.info(`${matches.length} matches:`)}`);
        displayModelList(
          matches,
          0
        );
        const pick = await ask(
          rl,
          `Add all ${matches.length} matches? (Y/n)`
        );
        if (pick === "" || pick.toLowerCase().startsWith("y")) {
          for (const m of matches) selected.add(m.name);
          log(`  ${ui.success(`Added ${matches.length} models.`)}`);
        }
      }
      continue;
    }

    if (cmd.startsWith("list ")) {
      const folderIdx = parseInt(cmd.slice(5).trim(), 10) - 1;
      if (folderIdx >= 0 && folderIdx < folders.length) {
        const folder = folders[folderIdx];
        log(`\n  ${ui.bold(folder)}:`);
        displayModelList(grouped[folder], 0);
      } else {
        log(`  ${ui.warn("Invalid folder number.")}`);
      }
      continue;
    }

    if (cmd === "pick") {
      log(`\n  ${ui.dim("Enter model names one per line. Empty line to finish.")}`);
      while (true) {
        const name = await ask(rl, "  Model name");
        if (!name) break;
        const match = allModels.find(
          (m) => m.name.toLowerCase() === name.toLowerCase()
        );
        if (match) {
          selected.add(match.name);
          log(`    ${ui.success("+")} ${match.name}`);
        } else {
          const fuzzy = allModels.filter((m) =>
            m.name.toLowerCase().includes(name.toLowerCase())
          );
          if (fuzzy.length > 0 && fuzzy.length <= 10) {
            log(`  ${ui.warn("Not found.")} Did you mean:`);
            for (const m of fuzzy) log(`    - ${m.name}`);
          } else {
            log(`  ${ui.warn("Model not found:")} ${name}`);
          }
        }
      }
      continue;
    }

    if (cmd === "selected") {
      if (selected.size === 0) {
        log(`  ${ui.dim("No models selected yet.")}`);
      } else {
        log(`  ${ui.info("Currently selected:")}`);
        for (const name of Array.from(selected).sort())
          log(`    - ${name}`);
      }
      continue;
    }

    const folderNums = cmd.split(/[,\s]+/).filter(Boolean);
    const validNums = folderNums.every((n) => /^\d+$/.test(n));
    if (validNums && folderNums.length > 0) {
      let addedCount = 0;
      for (const numStr of folderNums) {
        const idx = parseInt(numStr, 10) - 1;
        if (idx >= 0 && idx < folders.length) {
          for (const m of grouped[folders[idx]]) {
            selected.add(m.name);
            addedCount++;
          }
        } else {
          log(`  ${ui.warn(`Skipping invalid folder #${numStr}`)}`);
        }
      }
      log(`  ${ui.success(`Added ${addedCount} models from selected folders.`)}`);
      continue;
    }

    log(
      `  ${ui.dim('Type folder numbers, "all", "search <term>", "list <folder#>", "pick", "selected", or "done".')}`
    );
  }

  const selectedModels = allModels.filter((m) => selected.has(m.name));
  log(`\n  ${ui.success(`${selectedModels.length} models selected for context.`)}`);
  return selectedModels;
}
