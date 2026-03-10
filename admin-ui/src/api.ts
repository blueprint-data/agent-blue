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
    const data = (await response.json()) as { error?: string };
    return data.error ?? response.statusText;
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
