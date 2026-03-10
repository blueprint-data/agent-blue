import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { LlmProvider } from "../core/interfaces.js";
import { ask, askRequired, log, ui } from "./prompt.js";

interface CompanyInfo {
  name: string;
  website: string;
}

export interface TenantSummaryInput {
  companies: CompanyInfo[];
  additionalNotes: string;
}

async function fetchWebsiteContent(url: string): Promise<string> {
  try {
    const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
    const response = await fetch(normalizedUrl, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; AgentBlue/1.0; +https://blueprintdata.xyz)",
      },
    });
    if (!response.ok) return "";
    const html = await response.text();
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripped.slice(0, 8_000);
  } catch {
    return "";
  }
}

async function summarizeWebsite(
  llm: LlmProvider,
  llmModel: string,
  company: CompanyInfo,
  websiteText: string
): Promise<string> {
  if (!websiteText) {
    return `No website content available for ${company.name}.`;
  }
  const result = await llm.generateText({
    model: llmModel,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          "You are a business analyst. Given website content, write a concise summary (3-5 paragraphs) describing what the company does, its industry, products/services, and target market. Write in third person. Be factual and specific.",
      },
      {
        role: "user",
        content: `Company name: ${company.name}\nWebsite: ${company.website}\n\nWebsite content:\n${websiteText}`,
      },
    ],
  });
  return result;
}

export async function collectTenantSummaryInput(
  rl: readline.Interface
): Promise<TenantSummaryInput> {
  log(`\n  ${ui.bold("Company Information")}`);
  log(
    `  ${ui.dim("Add one or more companies associated with this tenant.")}`
  );

  const companies: CompanyInfo[] = [];
  let addMore = true;

  while (addMore) {
    const num = companies.length + 1;
    log(`\n  ${ui.magenta(`Company #${num}`)}`);
    const name = await askRequired(rl, `Company name`);
    const website = await ask(rl, `Website URL (optional)`);
    companies.push({ name, website });

    const answer = await ask(rl, `Add another company? (y/N)`);
    addMore = answer.toLowerCase().startsWith("y");
  }

  const additionalNotes = await ask(
    rl,
    `Any additional notes about the tenant (optional)`
  );

  return { companies, additionalNotes };
}

export async function generateTenantSummary(
  contextDir: string,
  input: TenantSummaryInput,
  tenantId: string,
  llm: LlmProvider,
  llmModel: string
): Promise<void> {
  const sections: string[] = [];
  sections.push(`# Tenant Summary — ${tenantId}\n`);

  for (const company of input.companies) {
    sections.push(`## ${company.name}\n`);
    if (company.website) {
      sections.push(`**Website:** ${company.website}\n`);
      log(`  ${ui.dim(`Fetching ${company.website}...`)}`);
      const websiteText = await fetchWebsiteContent(company.website);
      if (websiteText) {
        log(`  ${ui.dim("Generating summary with LLM...")}`);
        const summary = await summarizeWebsite(
          llm,
          llmModel,
          company,
          websiteText
        );
        sections.push(summary);
      } else {
        log(`  ${ui.warn("Could not fetch website content.")}`);
        sections.push(
          `*Website content could not be retrieved for automated summary.*\n`
        );
      }
    } else {
      sections.push(`*No website provided.*\n`);
    }
    sections.push("");
  }

  if (input.additionalNotes) {
    sections.push(`## Additional Notes\n`);
    sections.push(input.additionalNotes);
    sections.push("");
  }

  const filePath = path.join(contextDir, "tenant_summary.md");
  fs.writeFileSync(filePath, sections.join("\n"), "utf8");
  log(`  ${ui.success("Created")} tenant_summary.md`);
}
