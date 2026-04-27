export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000/api/v1";

export type User = {
  id: string;
  username: string;
  display_name: string;
  is_active: boolean;
  roles: string[];
};

export type UserCreatePayload = {
  username: string;
  password: string;
  display_name: string;
  roles: string[];
};

export type UserPatchPayload = {
  display_name?: string;
  is_active?: boolean;
  roles?: string[];
};

export type StorageFile = {
  name: string;
  path: string;
  width: number;
  height: number;
};

export type AnnotationBox = {
  id?: string;
  class_id?: string;
  class_name?: string;
  color?: string;
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
};

export type AnnotationPayload = {
  annotation_state: "not_started" | "annotated" | "no_object";
  is_no_object: boolean;
  boxes: AnnotationBox[];
};

export type TaskImage = {
  id: string;
  file_path: string;
  width: number;
  height: number;
  per_image_status: string;
  working_version: number;
  annotation_state: AnnotationPayload["annotation_state"];
  boxes_count: number;
  is_no_object: boolean;
  effective_annotation_state?: string;
  review_comment?: string | null;
  review_example_payload?: AnnotationPayload | null;
};

export type LabelClass = {
  id: string;
  name: string;
  color: string;
  sort_order: number;
};

export type TaskSummary = {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  assignee_user_id?: string | null;
  assignee_user?: SubmissionActor | null;
  created_by: string;
  created_by_user?: SubmissionActor | null;
  reviewer_user_id?: string | null;
  reviewer_user?: SubmissionActor | null;
  due_at?: string | null;
  priority: string;
  image_count: number;
  completed_count: number;
  changes_requested_count: number;
  storage_root_ref: string;
};

export type TaskDetail = TaskSummary & {
  images: TaskImage[];
  classes: LabelClass[];
};

export type SubmissionActor = {
  id: string;
  username?: string | null;
  display_name?: string | null;
};

export type SubmissionSummary = {
  id: string;
  status: string;
  submitter_id: string;
  submitter?: SubmissionActor | null;
  created_at: string;
  closed_at?: string | null;
};

export type SubmissionDetail = {
  id: string;
  task_id: string;
  status: string;
  submitter_id: string;
  submitter?: SubmissionActor | null;
  created_at: string;
  closed_at?: string | null;
  overall_comment?: string | null;
  images: Array<{
    task_image_id: string;
    payload: AnnotationPayload;
    review?: {
      decision: "passed" | "failed";
      comment?: string | null;
      example_payload?: AnnotationPayload | null;
    } | null;
  }>;
};

type RequestOptions = RequestInit & { token?: string | null };

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers ?? {});
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok) {
    const detail = data?.detail;
    const detailCode = typeof detail?.code === "string" ? detail.code : undefined;
    const detailDetails = detail?.details;
    const detailMessage =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail.map((item) => item?.msg ?? JSON.stringify(item)).join("; ")
          : typeof detail?.message === "string"
            ? detail.message
          : undefined;
    const message = data?.error?.message ?? detailMessage ?? `HTTP ${response.status} ${response.statusText || "Request failed"}`;
    const errorCode = typeof data?.error?.code === "string" ? data.error.code : detailCode;
    const errorDetails = data?.error?.details ?? detailDetails;
    throw new ApiError(message, response.status, errorCode, errorDetails);
  }
  return data as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ access_token: string; user: User }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  me: (token: string) => request<User>("/auth/me", { token }),
  logout: (token: string) => request<{ ok: boolean }>("/auth/logout", { method: "POST", token }),
  users: (token: string) => request<User[]>("/users", { token }),
  createUser: (token: string, payload: UserCreatePayload) =>
    request<User>("/users", { method: "POST", token, body: JSON.stringify(payload) }),
  patchUser: (token: string, userId: string, payload: UserPatchPayload) =>
    request<User>(`/users/${userId}`, { method: "PATCH", token, body: JSON.stringify(payload) }),
  deleteUser: (token: string, userId: string) =>
    request<{ ok: boolean }>(`/users/${userId}`, { method: "DELETE", token }),
  storageRoots: (token: string) => request<Array<{ name: string; path: string }>>("/storage/roots", { token }),
  storageBrowse: (token: string, root: string, path = "") =>
    request<{
      root: string;
      path: string;
      directories: Array<{ name: string; path: string }>;
      files: StorageFile[];
      total: number;
    }>(`/storage/browse?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&page_size=500`, { token }),
  storageFolderImages: (token: string, root: string, path = "", recursive = true, maxFiles = 20000) =>
    request<{
      root: string;
      path: string;
      recursive: boolean;
      files: StorageFile[];
      total: number;
    }>(
      `/storage/folder-images?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&recursive=${recursive ? "true" : "false"}&max_files=${maxFiles}`,
      { token }
    ),
  tasks: (token: string) => request<TaskSummary[]>("/tasks", { token }),
  task: (token: string, taskId: string) => request<TaskDetail>(`/tasks/${taskId}`, { token }),
  createTask: (token: string, payload: Record<string, unknown>) =>
    request<TaskSummary>("/tasks", { method: "POST", token, body: JSON.stringify(payload) }),
  patchTask: (token: string, taskId: string, payload: Record<string, unknown>) =>
    request<TaskSummary>(`/tasks/${taskId}`, { method: "PATCH", token, body: JSON.stringify(payload) }),
  deleteTask: (token: string, taskId: string) =>
    request<{ ok: boolean }>(`/tasks/${taskId}`, { method: "DELETE", token }),
  createLabelClass: (token: string, taskId: string, payload: { name: string; color: string }) =>
    request<LabelClass>(`/tasks/${taskId}/classes`, { method: "POST", token, body: JSON.stringify(payload) }),
  deleteLabelClass: (token: string, taskId: string, classId: string) =>
    request<{ ok: boolean }>(`/tasks/${taskId}/classes/${classId}`, { method: "DELETE", token }),
  working: (token: string, taskId: string, imageId: string) =>
    request<{ version: number; payload: AnnotationPayload; updated_at?: string | null }>(
      `/tasks/${taskId}/images/${imageId}/annotations/working`,
      { token }
    ),
  saveWorking: (
    token: string,
    taskId: string,
    imageId: string,
    expectedVersion: number,
    payload: AnnotationPayload
  ) =>
    request<{ version: number; payload: AnnotationPayload; updated_at?: string | null }>(
      `/tasks/${taskId}/images/${imageId}/annotations/working`,
      {
        method: "PUT",
        token,
        body: JSON.stringify({ expected_version: expectedVersion, payload })
      }
    ),
  effective: (token: string, taskId: string, imageId: string) =>
    request<{ payload: AnnotationPayload }>(`/tasks/${taskId}/images/${imageId}/annotations/effective`, { token }),
  createSubmission: (token: string, taskId: string) =>
    request<{ id: string; status: string }>(`/tasks/${taskId}/submissions`, { method: "POST", token }),
  submissions: (token: string, taskId: string) =>
    request<SubmissionSummary[]>(`/tasks/${taskId}/submissions`, { token }),
  submission: (token: string, submissionId: string) =>
    request<SubmissionDetail>(`/submissions/${submissionId}`, { token }),
  reviewComplete: (
    token: string,
    submissionId: string,
    payload: {
      overall_comment?: string;
      decisions: Array<{ task_image_id: string; decision: string; comment?: string; example_payload?: AnnotationPayload }>;
    }
  ) =>
    request<{ id: string; outcome: string }>(`/submissions/${submissionId}/review/complete`, {
      method: "POST",
      token,
      body: JSON.stringify(payload)
    }),
  batchApprove: (token: string, submissionId: string) =>
    request<{ id: string; outcome: string }>(`/submissions/${submissionId}/review/batch-approve`, {
      method: "POST",
      token
    }),
  exportTask: (token: string, taskId: string, format: "yolo" | "platform_json") =>
    request<{ filename: string; download_url: string }>(`/tasks/${taskId}/export`, {
      method: "POST",
      token,
      body: JSON.stringify({ format, include_images: true })
    }),
  audit: (token: string) => request<Array<Record<string, unknown>>>("/audit", { token })
};

export async function fetchImageBlob(token: string, taskId: string, imageId: string): Promise<string> {
  const response = await fetch(`${API_BASE}/tasks/${taskId}/images/${imageId}/file`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error("无法加载图像");
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

