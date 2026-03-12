import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const canUseAnsi = Boolean(output.isTTY) && process.env.NO_COLOR !== "1";

function paint(text: string, code: number): string {
  if (!canUseAnsi) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

export const ui = {
  info: (text: string) => paint(text, 36),
  success: (text: string) => paint(text, 32),
  error: (text: string) => paint(text, 31),
  warn: (text: string) => paint(text, 33),
  dim: (text: string) => paint(text, 37),
  bold: (text: string) => paint(text, 1),
  magenta: (text: string) => paint(text, 35),
};

export function log(text: string): void {
  output.write(`${text}\n`);
}

export function logStep(step: number, total: number, text: string): void {
  log(`\n${ui.info(`[${step}/${total}]`)} ${ui.bold(text)}`);
}

export async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  const answer = await rl.question(`${ui.info("?")} ${prompt}: `);
  return answer.trim();
}

export async function askRequired(rl: readline.Interface, prompt: string): Promise<string> {
  while (true) {
    const answer = await ask(rl, prompt);
    if (answer.length > 0) return answer;
    log(ui.warn("  This field is required."));
  }
}

export async function askMultiline(rl: readline.Interface, prompt: string): Promise<string> {
  log(`${ui.info("?")} ${prompt} ${ui.dim('(enter an empty line to finish)')}`);
  const lines: string[] = [];
  while (true) {
    const line = await rl.question("  ");
    if (line.trim().length === 0 && lines.length > 0) break;
    if (line.trim().length > 0) lines.push(line);
  }
  return lines.join("\n");
}

export async function confirm(rl: readline.Interface, prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await ask(rl, `${prompt} (${hint})`);
  if (answer.length === 0) return defaultYes;
  return answer.toLowerCase().startsWith("y");
}

export function createReadline(): readline.Interface {
  return readline.createInterface({ input, output });
}
