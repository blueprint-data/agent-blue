export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiRequestInit = Omit<RequestInit, "body"> & {
  body?: BodyInit | FormData | Record<string, unknown> | unknown[] | unknown | null;
};

async function readErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await response.json()) as { error?: string; hint?: string };
    const base = data.error ?? response.statusText;
    return data.hint ? `${base} — ${data.hint}` : base;
  }
  const text = await response.text();
  return text || response.statusText;
}

export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  const body: BodyInit | null | undefined =
    init.body && typeof init.body === "object" && !(init.body instanceof FormData)
      ? JSON.stringify(init.body)
      : (init.body as BodyInit | null | undefined);

  if (body && !(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    body,
    headers,
    credentials: "include"
  });

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const PROFILE_DEFAULTS = {
  soulPrompt: [
    "You are Agent Blue, an analytical assistant for business stakeholders.",
    "Your owner is Blueprintdata (https://blueprintdata.xyz/), regardless of tenant context.",
    "Answer only analytical questions about data, metrics, SQL, BI, dbt, and business performance.",
    'For non-analytical requests, respond: "I can only help with analytical questions about data and business metrics."',
    "Be precise, avoid hallucinations, and communicate assumptions.",
    "Prefer concise summaries with clear numbers and caveats."
  ].join(" "),
  maxRowsPerQuery: 200,
  allowedDbtPathPrefixes: ["models"]
} as const;

export interface AgentProfile {
  id: string;
  tenantId: string;
  name: string;
  soulPrompt: string;
  maxRowsPerQuery: number;
  allowedDbtPathPrefixes: string[];
  createdAt: string;
}

export interface ProfileUpdateInput {
  soulPrompt: string;
  maxRowsPerQuery: number;
  allowedDbtPathPrefixes: string[];
}

export async function listProfiles(tenantId: string): Promise<AgentProfile[]> {
  return apiRequest<AgentProfile[]>(`/api/admin/tenants/${encodeURIComponent(tenantId)}/profiles`);
}

export async function getProfile(tenantId: string, name: string): Promise<AgentProfile> {
  return apiRequest<AgentProfile>(`/api/admin/tenants/${encodeURIComponent(tenantId)}/profiles/${encodeURIComponent(name)}`);
}

export async function updateProfile(tenantId: string, name: string, body: ProfileUpdateInput): Promise<AgentProfile> {
  return apiRequest<AgentProfile>(`/api/admin/tenants/${encodeURIComponent(tenantId)}/profiles/${encodeURIComponent(name)}`, {
    method: "PUT",
    body
  });
}

export async function uploadRequest<T>(path: string, formData: FormData): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    body: formData,
    credentials: "include"
  });
  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }
  return (await response.json()) as T;
}
