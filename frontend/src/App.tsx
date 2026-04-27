import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, NavLink, Route, Routes, useParams } from "react-router-dom";
import { AnnotationCanvas } from "./components/AnnotationCanvas";
import { ReviewWorkbench } from "./components/ReviewWorkbench";
import { TaskComposer } from "./components/TaskComposer";
import {
  ApiError,
  api,
  fetchImageBlob,
  type AnnotationPayload,
  type LabelClass,
  type TaskDetail,
  type TaskSummary,
  type User
} from "./lib/api";
import { useAuth } from "./lib/auth";

function statusTone(status: string) {
  if (["approved", "no_object_approved"].includes(status)) {
    return "badge-success";
  }
  if (["changes_requested", "rejected"].includes(status)) {
    return "badge-danger";
  }
  if (["in_review"].includes(status)) {
    return "badge-highlight";
  }
  return "badge-muted";
}

function payloadStatus(payload: AnnotationPayload) {
  if (payload.is_no_object) {
    return "no_object_marked";
  }
  if (payload.boxes.length) {
    return "in_progress";
  }
  return "not_started";
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 6;
const REMEMBERED_LOGIN_KEY = "labelwe-remembered-login";
const HIDDEN_TASK_STORAGE_PREFIX = "labelwe-hidden-task-ids:";

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

type RememberedLogin = {
  username: string;
  password: string;
  rememberPassword: boolean;
};

function emptyRememberedLogin(): RememberedLogin {
  return { username: "", password: "", rememberPassword: false };
}

function loadRememberedLogin(): RememberedLogin {
  if (typeof window === "undefined") {
    return emptyRememberedLogin();
  }
  try {
    const raw = window.localStorage.getItem(REMEMBERED_LOGIN_KEY);
    if (!raw) {
      return emptyRememberedLogin();
    }
    const parsed = JSON.parse(raw) as Partial<RememberedLogin>;
    const username = typeof parsed.username === "string" ? parsed.username : "";
    const password = typeof parsed.password === "string" ? parsed.password : "";
    const rememberPassword = parsed.rememberPassword === true && Boolean(username) && Boolean(password);
    if (!rememberPassword) {
      return emptyRememberedLogin();
    }
    return { username, password, rememberPassword };
  } catch {
    return emptyRememberedLogin();
  }
}

function persistRememberedLogin(username: string, password: string, rememberPassword: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  if (!rememberPassword) {
    window.localStorage.removeItem(REMEMBERED_LOGIN_KEY);
    return;
  }
  window.localStorage.setItem(REMEMBERED_LOGIN_KEY, JSON.stringify({ username, password, rememberPassword: true }));
}

function hiddenTaskStorageKey(userId: string) {
  return `${HIDDEN_TASK_STORAGE_PREFIX}${userId}`;
}

function loadHiddenTaskIds(userId: string) {
  if (typeof window === "undefined") {
    return new Set<string>();
  }
  try {
    const raw = window.localStorage.getItem(hiddenTaskStorageKey(userId));
    if (!raw) {
      return new Set<string>();
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }
    return new Set(parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0));
  } catch {
    return new Set<string>();
  }
}

function persistHiddenTaskIds(userId: string, ids: Set<string>) {
  if (typeof window === "undefined") {
    return;
  }
  if (!ids.size) {
    window.localStorage.removeItem(hiddenTaskStorageKey(userId));
    return;
  }
  window.localStorage.setItem(hiddenTaskStorageKey(userId), JSON.stringify(Array.from(ids)));
}

const USER_ROLE_OPTIONS = [
  { value: "manager", label: "任务管理员", description: "创建任务、选择图片并分配标注员/审核员" },
  { value: "annotator", label: "标注员", description: "接收任务，执行框选并提交审核" },
  { value: "reviewer", label: "审核员", description: "审核提交结果，可通过或打回" },
  { value: "user", label: "观察者", description: "普通只读账号，不参与流程操作" },
  { value: "admin", label: "系统管理员", description: "管理用户与审计信息，谨慎授予" }
];

const CLASS_COLOR_PALETTE = ["#ff7a18", "#ef476f", "#06d6a0", "#118ab2", "#ffd166", "#8d99ae", "#2b9348", "#8f5cff"];
const FLOW_VISIBLE_ROLES = new Set(["manager", "admin"]);

type FlowStepState = "done" | "active" | "pending";

type TaskFlowStep = {
  key: "dispatch" | "annotation" | "review" | "complete";
  title: string;
  hint: string;
  state: FlowStepState;
};

type TaskFlowSnapshot = {
  currentStatusLabel: string;
  responsibilityRole: string;
  responsibilityUserId?: string | null;
  responsibilityFallback?: string;
  nextAction: string;
  steps: TaskFlowStep[];
};

function canViewTaskFlow(
  user: User,
  task?: Pick<TaskSummary, "created_by" | "assignee_user_id" | "reviewer_user_id"> | null
) {
  if (user.roles.some((role) => FLOW_VISIBLE_ROLES.has(role))) {
    return true;
  }
  if (!task) {
    return false;
  }
  return task.created_by === user.id || task.assignee_user_id === user.id || task.reviewer_user_id === user.id;
}

function toStatusLabel(status: string) {
  const mapping: Record<string, string> = {
    draft: "草稿",
    in_progress: "标注中",
    submitted: "已提交",
    in_review: "审核中",
    rejected: "已打回",
    approved: "已完成"
  };
  return mapping[status] ?? status;
}

type ActorBrief = {
  id: string;
  username?: string | null;
  display_name?: string | null;
};

function actorLabel(
  userId: string | null | undefined,
  usersById: Record<string, User>,
  candidates: Array<ActorBrief | null | undefined> = []
) {
  if (!userId) {
    return "未分配";
  }
  const user = usersById[userId];
  if (!user) {
    for (const candidate of candidates) {
      if (!candidate || candidate.id !== userId) {
        continue;
      }
      const displayName = candidate.display_name?.trim() ?? "";
      const username = candidate.username?.trim() ?? "";
      if (displayName && username) {
        return displayName === username ? displayName : `${displayName} (${username})`;
      }
      if (displayName) {
        return displayName;
      }
      if (username) {
        return username;
      }
      break;
    }
    return `用户 ${userId.slice(0, 8)}`;
  }
  return `${user.display_name} (${user.username})`;
}

const ALL_FOLDERS_KEY = "__all_folders__";

function normalizeImagePath(path: string) {
  return path.replace(/\\/g, "/");
}

function folderPathOf(filePath: string) {
  const normalized = normalizeImagePath(filePath);
  const marker = normalized.lastIndexOf("/");
  return marker === -1 ? "" : normalized.slice(0, marker);
}

function folderLabelOf(folderPath: string) {
  return folderPath || "根目录";
}

function folderDepthOf(folderPath: string) {
  return folderPath ? folderPath.split("/").filter(Boolean).length : 0;
}

function folderNameOf(folderPath: string) {
  if (!folderPath) {
    return "根目录";
  }
  const parts = folderPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? folderPath;
}

function buildTaskFlow(task: TaskSummary): TaskFlowSnapshot {
  const activeStepIndex =
    task.status === "draft"
      ? 0
      : task.status === "in_progress" || task.status === "rejected"
        ? 1
        : task.status === "submitted" || task.status === "in_review"
          ? 2
          : task.status === "approved"
            ? 3
            : 0;

  const stepDefs: Array<Pick<TaskFlowStep, "key" | "title" | "hint">> = [
    { key: "dispatch", title: "任务分发", hint: "配置任务并指定标注员与审核员" },
    { key: "annotation", title: "标注执行", hint: "标注员完成框选并提交审核" },
    { key: "review", title: "审核处理", hint: "审核员逐张通过或打回" },
    { key: "complete", title: "任务完成", hint: "审核通过后结果生效并归档" }
  ];

  const steps: TaskFlowStep[] = stepDefs.map((step, index) => ({
    ...step,
    state: index < activeStepIndex ? "done" : index === activeStepIndex ? "active" : "pending"
  }));

  if (task.status === "approved") {
    steps[3] = { ...steps[3], state: "active" };
  }

  if (task.status === "draft") {
    return {
      currentStatusLabel: toStatusLabel(task.status),
      responsibilityRole: "任务管理员",
      responsibilityUserId: task.created_by,
      nextAction: "分配标注员和审核员后开始任务",
      steps
    };
  }

  if (task.status === "submitted" || task.status === "in_review") {
    return {
      currentStatusLabel: toStatusLabel(task.status),
      responsibilityRole: "审核员",
      responsibilityUserId: task.reviewer_user_id,
      nextAction: "审核员对提交结果进行通过或打回",
      steps
    };
  }

  if (task.status === "in_progress" || task.status === "rejected") {
    return {
      currentStatusLabel: toStatusLabel(task.status),
      responsibilityRole: "标注员",
      responsibilityUserId: task.assignee_user_id,
      nextAction: task.status === "rejected" ? "根据审核意见修正后重新提交" : "继续标注并提交审核",
      steps
    };
  }

  if (task.status === "approved") {
    return {
      currentStatusLabel: toStatusLabel(task.status),
      responsibilityRole: "已完成",
      responsibilityFallback: "当前无待办责任人",
      nextAction: "可导出结果或分发新任务",
      steps
    };
  }

  return {
    currentStatusLabel: toStatusLabel(task.status),
    responsibilityRole: "任务管理员",
    responsibilityUserId: task.created_by,
    nextAction: "根据流程状态继续推进",
    steps
  };
}

function shouldFallbackHideTaskRecord(error: unknown) {
  if (error instanceof ApiError && error.code === "TASK_NOT_DELETABLE") {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.includes("仅可删除未完成任务") || error.message.includes("已审核通过的任务不能直接删除");
}

function AppShell() {
  const { user, token, logout } = useAuth();
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.localStorage.getItem("labelwe_sidebar_hidden") === "1";
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem("labelwe_sidebar_hidden", sidebarHidden ? "1" : "0");
  }, [sidebarHidden]);

  if (!user || !token) {
    return null;
  }

  return (
    <div className={`app-shell ${sidebarHidden ? "is-sidebar-hidden" : ""}`}>
      <aside className="app-sidebar">
        <div className="brand-lockup">
          <span className="brand-mark">LW</span>
          <div>
            <p className="eyebrow">Collaborative Annotation</p>
            <h1>LabelWe</h1>
          </div>
          <button type="button" className="ghost-button sidebar-toggle" onClick={() => setSidebarHidden(true)}>
            隐藏侧栏
          </button>
        </div>
        <nav className="nav-stack">
          <NavLink to="/" end className="nav-link">
            仪表盘
          </NavLink>
          <NavLink to="/admin" className="nav-link">
            管理后台
          </NavLink>
          <NavLink to="/shortcuts" className="nav-link">
            快捷键说明
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <p>{user.display_name}</p>
          <small>{user.roles.join(" / ")}</small>
          <button type="button" className="ghost-button" onClick={() => logout()}>
            退出登录
          </button>
        </div>
      </aside>
      <main className="app-content">
        {sidebarHidden ? (
          <button type="button" className="ghost-button sidebar-reopen" onClick={() => setSidebarHidden(false)}>
            显示侧栏
          </button>
        ) : null}
        <Routes>
          <Route path="/" element={<DashboardPage token={token} currentUser={user} />} />
          <Route path="/tasks/:taskId" element={<TaskPage token={token} currentUser={user} />} />
          <Route path="/admin" element={<AdminPage token={token} currentUser={user} />} />
          <Route path="/shortcuts" element={<ShortcutGuidePage />} />
        </Routes>
      </main>
    </div>
  );
}

function DashboardPage({ token, currentUser }: { token: string; currentUser: User }) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [hiddenTaskIds, setHiddenTaskIds] = useState<Set<string>>(() => loadHiddenTaskIds(currentUser.id));
  const [showHiddenTasks, setShowHiddenTasks] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [taskList, userList] = await Promise.all([
        api.tasks(token),
        currentUser.roles.some((role) => ["manager", "admin"].includes(role)) ? api.users(token) : Promise.resolve([])
      ]);
      setTasks(taskList);
      setUsers(userList);
      setHiddenTaskIds((current) => {
        if (!current.size) {
          return current;
        }
        const existingIds = new Set(taskList.map((task) => task.id));
        const next = new Set(Array.from(current).filter((taskId) => existingIds.has(taskId)));
        return next.size === current.size ? current : next;
      });
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "仪表盘加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    setHiddenTaskIds(loadHiddenTaskIds(currentUser.id));
    setShowHiddenTasks(false);
  }, [currentUser.id]);

  useEffect(() => {
    persistHiddenTaskIds(currentUser.id, hiddenTaskIds);
  }, [currentUser.id, hiddenTaskIds]);

  const visibleTasks = showHiddenTasks ? tasks : tasks.filter((task) => !hiddenTaskIds.has(task.id));
  const assigned = visibleTasks.filter((task) => task.assignee_user_id === currentUser.id);
  const reviewQueue = visibleTasks.filter((task) => task.reviewer_user_id === currentUser.id && task.status === "in_review");
  const managed = visibleTasks.filter((task) => task.created_by === currentUser.id);
  const usersById: Record<string, User> = Object.fromEntries(users.map((item) => [item.id, item])) as Record<string, User>;

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Operational View</p>
          <h2>协同检测标注控制台</h2>
          <p className="hero-copy">
            一个面向任务分发、标注执行、逐张审核和审计追踪的全链路工作台。当前账号同时能看到自己需要标注、需要审核和需要管理的任务。
          </p>
        </div>
        <div className="hero-metrics">
          <div>
            <strong>{assigned.length}</strong>
            <span>我的标注任务</span>
          </div>
          <div>
            <strong>{reviewQueue.length}</strong>
            <span>待我审核</span>
          </div>
          <div>
            <strong>{managed.length}</strong>
            <span>我创建的任务</span>
          </div>
        </div>
      </section>

      {currentUser.roles.some((role) => ["manager", "admin"].includes(role)) ? (
        <TaskComposer token={token} users={users} onCreated={load} />
      ) : null}

      {message ? <p className="inline-message">{message}</p> : null}
      {hiddenTaskIds.size ? (
        <div className="button-cluster">
          <button type="button" className="ghost-button" onClick={() => setShowHiddenTasks((current) => !current)}>
            {showHiddenTasks ? `隐藏已隐藏任务 (${hiddenTaskIds.size})` : `显示已隐藏任务 (${hiddenTaskIds.size})`}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setHiddenTaskIds(new Set<string>());
              setShowHiddenTasks(false);
              setMessage("已清空前端隐藏列表。");
            }}
          >
            清空隐藏列表
          </button>
        </div>
      ) : null}
      {loading ? <div className="panel">正在加载任务...</div> : null}

      <section className="task-grid">
        {[...visibleTasks].map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            token={token}
            currentUser={currentUser}
            usersById={usersById}
            onDeleted={(deletedTaskId, options) => {
              if (options?.hiddenOnly) {
                setHiddenTaskIds((current) => {
                  const next = new Set(current);
                  next.add(deletedTaskId);
                  return next;
                });
                setShowHiddenTasks(false);
                setMessage(options.message ?? "后端仍限制删除已审核任务，已在当前账号前端隐藏该记录。");
                return;
              }
              setTasks((current) => current.filter((item) => item.id !== deletedTaskId));
              setHiddenTaskIds((current) => {
                if (!current.has(deletedTaskId)) {
                  return current;
                }
                const next = new Set(current);
                next.delete(deletedTaskId);
                return next;
              });
              setMessage("任务已删除；原始图片文件未删除，可重新分发。");
            }}
          />
        ))}
      </section>
    </div>
  );
}

function TaskCard({
  task,
  token,
  currentUser,
  usersById,
  onDeleted
}: {
  task: TaskSummary;
  token: string;
  currentUser: User;
  usersById: Record<string, User>;
  onDeleted: (taskId: string, options?: { hiddenOnly?: boolean; message?: string }) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const canDelete = currentUser.roles.some((role) => role === "manager" || role === "admin");
  const canSeeFlow = canViewTaskFlow(currentUser, task);
  const flow = buildTaskFlow(task);
  const taskActorCandidates = [task.created_by_user, task.assignee_user, task.reviewer_user];
  const ownerName = flow.responsibilityUserId
    ? actorLabel(flow.responsibilityUserId, usersById, taskActorCandidates)
    : flow.responsibilityFallback ?? "-";

  async function handleDelete() {
    const confirmed = window.confirm(
      `确认删除任务「${task.title}」？\n\n此操作会删除任务、工作副本、提交与审核记录，但不会删除原始图片文件。`
    );
    if (!confirmed) {
      return;
    }
    setDeleting(true);
    try {
      await api.deleteTask(token, task.id);
      onDeleted(task.id);
    } catch (error) {
      if (shouldFallbackHideTaskRecord(error)) {
        onDeleted(task.id, {
          hiddenOnly: true,
          message: "当前后端仍在执行“仅可删除未完成任务”的旧规则，已先隐藏该任务记录。更新并重启后端后可进行真实删除。"
        });
        return;
      }
      window.alert(error instanceof Error ? error.message : "删除任务失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article className="task-card">
      <Link to={`/tasks/${task.id}`} className="task-card__content">
        <div className="task-card__header">
          <div>
            <p className="eyebrow">Task</p>
            <h3>{task.title}</h3>
          </div>
          <span className={`badge ${statusTone(task.status)}`}>{task.status}</span>
        </div>
        <p>{task.description || "无任务说明"}</p>
        <div className="task-card__meta">
          <span>{task.image_count} 张图</span>
          <span>{task.completed_count} 已完成</span>
          <span>{task.changes_requested_count} 待返工</span>
        </div>
        {canSeeFlow ? (
          <div className="task-card__workflow">
            <strong>状态：{flow.currentStatusLabel}</strong>
            <span>
              当前责任人：{flow.responsibilityRole} · {ownerName}
            </span>
            <small>下一步：{flow.nextAction}</small>
          </div>
        ) : null}
      </Link>
      {canDelete ? (
        <div className="task-card__actions">
          <button type="button" className="danger-button" onClick={handleDelete} disabled={deleting}>
            {deleting ? "正在删除..." : "删除任务记录"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function TaskPage({ token, currentUser }: { token: string; currentUser: User }) {
  const { taskId } = useParams();
  const sampleListRef = useRef<HTMLDivElement | null>(null);
  const classAssignInputRef = useRef<HTMLInputElement | null>(null);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [payload, setPayload] = useState<AnnotationPayload>({ annotation_state: "not_started", is_no_object: false, boxes: [] });
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [hydrating, setHydrating] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [showLabels, setShowLabels] = useState(true);
  const [showBoxes, setShowBoxes] = useState(true);
  const [showReviewExample, setShowReviewExample] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [activeFolderPath, setActiveFolderPath] = useState<string>(ALL_FOLDERS_KEY);
  const [message, setMessage] = useState<string | null>(null);
  const [newClassName, setNewClassName] = useState("");
  const [newClassColor, setNewClassColor] = useState("#ff7a18");
  const [pendingClassBoxId, setPendingClassBoxId] = useState<string | null>(null);
  const [pendingClassInput, setPendingClassInput] = useState("");
  const [usersById, setUsersById] = useState<Record<string, User>>({});

  async function loadTask() {
    if (!taskId) {
      return;
    }
    try {
      const detail = await api.task(token, taskId);
      setTask(detail);
      setSelectedImageId((current) => current && detail.images.some((item) => item.id === current) ? current : detail.images[0]?.id ?? null);
      setSelectedClassId((current) => (current && detail.classes.some((item) => item.id === current) ? current : null));
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "任务加载失败");
    }
  }

  useEffect(() => {
    loadTask();
  }, [taskId, token]);

  const showWorkflowBoard = canViewTaskFlow(currentUser, task);

  useEffect(() => {
    const canFetchFlowUsers = currentUser.roles.some((role) => role === "admin" || role === "manager");
    if (!showWorkflowBoard || !canFetchFlowUsers) {
      setUsersById(currentUser.id ? { [currentUser.id]: currentUser } : {});
      return;
    }
    let active = true;
    async function loadUsers() {
      try {
        const list = await api.users(token);
        if (active) {
          setUsersById(Object.fromEntries(list.map((item) => [item.id, item])) as Record<string, User>);
        }
      } catch {
        if (active) {
          setUsersById({});
        }
      }
    }
    void loadUsers();
    return () => {
      active = false;
    };
  }, [currentUser, showWorkflowBoard, token]);

  const orderedTaskImages = useMemo(
    () =>
      task
        ? [...task.images].sort((left, right) =>
            normalizeImagePath(left.file_path).localeCompare(normalizeImagePath(right.file_path), "zh-CN", {
              numeric: true,
              sensitivity: "base"
            })
          )
        : [],
    [task]
  );
  const folderGroups = useMemo(() => {
    const grouped = new Map<string, TaskDetail["images"]>();
    orderedTaskImages.forEach((image) => {
      const folderPath = folderPathOf(image.file_path);
      const bucket = grouped.get(folderPath);
      if (bucket) {
        bucket.push(image);
      } else {
        grouped.set(folderPath, [image]);
      }
    });
    return Array.from(grouped.entries()).map(([folderPath, images]) => ({
      folderPath,
      folderLabel: folderLabelOf(folderPath),
      images
    }));
  }, [orderedTaskImages]);
  const filteredImages = useMemo(
    () =>
      activeFolderPath === ALL_FOLDERS_KEY
        ? orderedTaskImages
        : orderedTaskImages.filter((image) => folderPathOf(image.file_path) === activeFolderPath),
    [activeFolderPath, orderedTaskImages]
  );
  const visibleFolderGroups = useMemo(
    () =>
      activeFolderPath === ALL_FOLDERS_KEY
        ? folderGroups
        : folderGroups.filter((group) => group.folderPath === activeFolderPath),
    [activeFolderPath, folderGroups]
  );
  const sampleIndexByImageId = useMemo(
    () =>
      Object.fromEntries(filteredImages.map((image, index) => [image.id, index + 1])) as Record<string, number>,
    [filteredImages]
  );
  const selectedImage = task?.images.find((item) => item.id === selectedImageId) ?? null;
  const totalSampleCount = filteredImages.length;
  const totalTaskImageCount = orderedTaskImages.length;
  const currentSampleIndex = selectedImageId ? sampleIndexByImageId[selectedImageId] ?? 0 : 0;
  const currentSampleName = selectedImage?.file_path.split("/").pop() ?? "未选择样本";
  const currentSampleFolderPath = selectedImage ? folderPathOf(selectedImage.file_path) : "";
  const currentSampleFolderLabel = folderLabelOf(currentSampleFolderPath);
  const currentSampleProgress = totalSampleCount ? Math.round((currentSampleIndex / totalSampleCount) * 100) : 0;
  const reviewerMode = Boolean(task && task.reviewer_user_id === currentUser.id);
  const assigneeMode = Boolean(task && task.assignee_user_id === currentUser.id);
  const lockedStatuses = ["approved", "no_object_approved"];
  const readOnly =
    !task ||
    !selectedImage ||
    !assigneeMode ||
    task.status === "in_review" ||
    lockedStatuses.includes(selectedImage.per_image_status);
  const readOnlyReason = !selectedImage
    ? "请先选择图片"
    : !assigneeMode
      ? "当前账号不是该任务标注员，无法编辑标注"
      : task.status === "in_review"
        ? "任务处于审核中，标注暂时只读"
        : lockedStatuses.includes(selectedImage.per_image_status)
          ? "当前图像已审核通过并锁定"
          : null;

  const flow = task ? buildTaskFlow(task) : null;
  const taskActorCandidates = task ? [task.created_by_user, task.assignee_user, task.reviewer_user] : [];
  const creatorName = task ? actorLabel(task.created_by, usersById, taskActorCandidates) : "-";
  const assigneeName = task ? actorLabel(task.assignee_user_id, usersById, taskActorCandidates) : "-";
  const reviewerName = task ? actorLabel(task.reviewer_user_id, usersById, taskActorCandidates) : "-";
  const currentOwnerName = flow
    ? flow.responsibilityUserId
      ? actorLabel(flow.responsibilityUserId, usersById, taskActorCandidates)
      : flow.responsibilityFallback ?? "-"
    : "-";

  useEffect(() => {
    if (activeFolderPath === ALL_FOLDERS_KEY) {
      return;
    }
    if (folderGroups.some((group) => group.folderPath === activeFolderPath)) {
      return;
    }
    setActiveFolderPath(ALL_FOLDERS_KEY);
  }, [activeFolderPath, folderGroups]);

  useEffect(() => {
    if (!filteredImages.length) {
      setSelectedImageId(null);
      return;
    }
    if (!selectedImageId || !filteredImages.some((image) => image.id === selectedImageId)) {
      setSelectedImageId(filteredImages[0].id);
    }
  }, [filteredImages, selectedImageId]);

  useEffect(() => {
    if (!selectedImageId) {
      return;
    }
    const container = sampleListRef.current;
    if (!container) {
      return;
    }
    const selectedItem = container.querySelector<HTMLButtonElement>(`.image-list__item[data-image-id="${selectedImageId}"]`);
    if (!selectedItem) {
      return;
    }
    selectedItem.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedImageId, task?.id]);

  useEffect(() => {
    if (!pendingClassBoxId) {
      return;
    }
    classAssignInputRef.current?.focus();
    classAssignInputRef.current?.select();
  }, [pendingClassBoxId]);

  useEffect(() => {
    setPendingClassBoxId(null);
    setPendingClassInput("");
  }, [selectedImageId]);

  useEffect(() => {
    if (!reviewerMode) {
      return;
    }
    setPendingClassBoxId(null);
    setPendingClassInput("");
    setFocusMode(false);
  }, [reviewerMode]);

  useEffect(() => {
    let active = true;
    async function loadImage() {
      if (!taskId || !selectedImageId) {
        setImageUrl(null);
        return;
      }
      try {
        const url = await fetchImageBlob(token, taskId, selectedImageId);
        if (active) {
          setImageUrl((previous) => {
            if (previous) {
              URL.revokeObjectURL(previous);
            }
            return url;
          });
        }
      } catch {
        if (active) {
          setImageUrl(null);
        }
      }
    }
    loadImage();
    return () => {
      active = false;
    };
  }, [selectedImageId, taskId, token]);

  useEffect(() => {
    let active = true;
    async function loadWorking() {
      if (!taskId || !selectedImageId) {
        return;
      }
      setHydrating(true);
      try {
        const response = await api.working(token, taskId, selectedImageId);
        if (active) {
          setPayload(response.payload);
          setVersion(response.version);
          setDirty(false);
          setHydrating(false);
        }
      } catch (error) {
        if (active) {
          setMessage(error instanceof Error ? error.message : "加载工作副本失败");
          setHydrating(false);
        }
      }
    }
    loadWorking();
    return () => {
      active = false;
    };
  }, [selectedImageId, taskId, token]);

  useEffect(() => {
    if (!dirty || hydrating || readOnly || !selectedImage || !taskId) {
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.saveWorking(token, taskId, selectedImage.id, version, payload);
        setVersion(response.version);
        setDirty(false);
        setTask((current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            images: current.images.map((item) =>
              item.id === selectedImage.id
                ? {
                    ...item,
                    working_version: response.version,
                    annotation_state: response.payload.annotation_state,
                    boxes_count: response.payload.boxes.length,
                    is_no_object: response.payload.is_no_object,
                    per_image_status: payloadStatus(response.payload)
                  }
                : item
            )
          };
        });
        setMessage("工作副本已自动保存");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "自动保存失败");
        if (error instanceof Error && error.message.includes("版本冲突")) {
          await loadTask();
        }
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [dirty, hydrating, payload, readOnly, selectedImage, taskId, token, version]);

  async function submitForReview() {
    if (!taskId) {
      return;
    }
    try {
      await api.createSubmission(token, taskId);
      setMessage("任务已提交审核");
      await loadTask();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "提交失败");
    }
  }

  async function exportTask(format: "yolo" | "platform_json") {
    if (!taskId) {
      return;
    }
    try {
      const exported = await api.exportTask(token, taskId, format);
      const response = await fetch(`${import.meta.env.VITE_API_BASE_URL?.replace("/api/v1", "") ?? "http://127.0.0.1:8000"}${exported.download_url}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exported.filename;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage(`已导出 ${exported.filename}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导出失败");
    }
  }

  function normalizeClassName(value: string) {
    return value.trim().replace(/\s+/g, " ");
  }

  function pickNextClassColor() {
    if (!task) {
      return newClassColor;
    }
    const used = new Set(task.classes.map((item) => item.color.toLowerCase()));
    const next = CLASS_COLOR_PALETTE.find((color) => !used.has(color.toLowerCase()));
    return next ?? CLASS_COLOR_PALETTE[task.classes.length % CLASS_COLOR_PALETTE.length] ?? newClassColor;
  }

  function findClassByName(name: string) {
    const normalized = normalizeClassName(name).toLowerCase();
    return task?.classes.find((item) => item.name.trim().toLowerCase() === normalized) ?? null;
  }

  async function createClassByName(name: string, preferredColor?: string) {
    if (!task) {
      return null;
    }
    const normalized = normalizeClassName(name);
    if (!normalized) {
      return null;
    }
    const existed = findClassByName(normalized);
    if (existed) {
      return existed;
    }
    const created = await api.createLabelClass(token, task.id, {
      name: normalized,
      color: preferredColor ?? pickNextClassColor()
    });
    setTask((current) => (current ? { ...current, classes: [...current.classes, created] } : current));
    return created;
  }

  function removeBoxById(boxId: string) {
    setPayload((current) => {
      const boxes = current.boxes.filter((box) => box.id !== boxId);
      return {
        ...current,
        boxes,
        annotation_state: current.is_no_object ? "no_object" : boxes.length ? "annotated" : "not_started"
      };
    });
    setDirty(true);
  }

  function applyClassToBox(boxId: string, label: LabelClass) {
    setPayload((current) => {
      const boxes = current.boxes.map((box) =>
        box.id === boxId
          ? {
              ...box,
              class_id: label.id,
              class_name: label.name,
              color: label.color
            }
          : box
      );
      return {
        ...current,
        boxes,
        annotation_state: current.is_no_object ? "no_object" : boxes.length ? "annotated" : "not_started"
      };
    });
    setDirty(true);
  }

  async function deleteClassById(classId: string, className: string) {
    if (!task) {
      return;
    }
    const confirmed = window.confirm(`确认删除类别「${className}」？\n\n删除后不会改动已有标注框，只会从可选类别中移除。`);
    if (!confirmed) {
      return;
    }
    try {
      await api.deleteLabelClass(token, task.id, classId);
      setTask((current) => (current ? { ...current, classes: current.classes.filter((item) => item.id !== classId) } : current));
      setSelectedClassId((current) => (current === classId ? null : current));
      setMessage(`类别已删除：${className}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "类别删除失败");
    }
  }

  async function removeClassByInput() {
    if (!task) {
      return;
    }
    const target = findClassByName(newClassName);
    if (!target) {
      setMessage("输入的类别不存在，无法删除");
      return;
    }
    await deleteClassById(target.id, target.name);
    setNewClassName("");
  }

  function openClassAssignDialog(boxId: string) {
    if (!task || readOnly || !boxId) {
      return;
    }
    const preset = selectedClassId
      ? task.classes.find((item) => item.id === selectedClassId)?.name ?? normalizeClassName(newClassName)
      : normalizeClassName(newClassName);
    setPendingClassBoxId(boxId);
    setPendingClassInput(preset ?? "");
  }

  function closeClassAssignDialog(removePendingBox: boolean) {
    if (removePendingBox && pendingClassBoxId) {
      removeBoxById(pendingClassBoxId);
      setMessage("已取消类别输入，标注框已移除");
    }
    setPendingClassBoxId(null);
    setPendingClassInput("");
  }

  function pickPendingClass(label: LabelClass) {
    if (!pendingClassBoxId) {
      return;
    }
    setSelectedClassId(label.id);
    applyClassToBox(pendingClassBoxId, label);
    setPendingClassBoxId(null);
    setPendingClassInput("");
    setMessage(`标注已归类到：${label.name}`);
  }

  async function confirmPendingClass(nameOverride?: string) {
    if (!pendingClassBoxId) {
      return;
    }
    const normalized = normalizeClassName(nameOverride ?? pendingClassInput);
    if (!normalized) {
      setMessage("类别名称不能为空");
      return;
    }
    try {
      const label = await createClassByName(normalized);
      if (!label) {
        removeBoxById(pendingClassBoxId);
        setPendingClassBoxId(null);
        setPendingClassInput("");
        setMessage("类别创建失败，标注框已移除");
        return;
      }
      setSelectedClassId(label.id);
      applyClassToBox(pendingClassBoxId, label);
      setPendingClassBoxId(null);
      setPendingClassInput("");
      setMessage(`标注已归类到：${label.name}`);
    } catch (error) {
      removeBoxById(pendingClassBoxId);
      setPendingClassBoxId(null);
      setPendingClassInput("");
      setMessage(error instanceof Error ? error.message : "类别设置失败，标注框已移除");
    }
  }

  function handleBoxDrawn(boxId: string) {
    openClassAssignDialog(boxId);
  }

  async function addClass() {
    if (!task) {
      return;
    }
    try {
      const created = await createClassByName(newClassName, newClassColor);
      if (!created) {
        return;
      }
      setSelectedClassId(created.id);
      setNewClassName("");
      setMessage("类别已新增");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "类别新增失败");
    }
  }

  function updatePayload(next: AnnotationPayload) {
    setPayload(next);
    setDirty(true);
  }

  function toggleNoObject() {
    if (readOnly) {
      return;
    }
    updatePayload(
      payload.is_no_object
        ? { annotation_state: "not_started", is_no_object: false, boxes: [] }
        : { annotation_state: "no_object", is_no_object: true, boxes: [] }
    );
  }

  function selectRelativeImage(offset: number) {
    if (!filteredImages.length || !selectedImageId) {
      return;
    }
    const currentIndex = filteredImages.findIndex((image) => image.id === selectedImageId);
    const nextIndex = (currentIndex === -1 ? 0 : currentIndex + offset + filteredImages.length) % filteredImages.length;
    setSelectedImageId(filteredImages[nextIndex].id);
  }

  useEffect(() => {
    function onKeydown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) {
        return;
      }
      if (pendingClassBoxId) {
        if (event.key === "Escape") {
          closeClassAssignDialog(true);
          event.preventDefault();
        }
        return;
      }

      const key = event.key.toLowerCase();
      let handled = true;
      if (key === "escape" && focusMode) {
        setFocusMode(false);
      } else if (key === "+" || key === "=") {
        setZoom((value) => clampZoom(value + 0.08));
      } else if (key === "-" || key === "_") {
        setZoom((value) => clampZoom(value - 0.08));
      } else if (key === "0") {
        setZoom(1);
      } else if (key === "l") {
        setShowLabels((value) => !value);
      } else if (key === "b") {
        setShowBoxes((value) => !value);
      } else if (key === "n") {
        toggleNoObject();
      } else if (key === "[" || key === "arrowleft") {
        selectRelativeImage(-1);
      } else if (key === "]" || key === "arrowright") {
        selectRelativeImage(1);
      } else {
        handled = false;
      }

      if (handled) {
        event.preventDefault();
      }
    }

    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [filteredImages, focusMode, pendingClassBoxId, payload, readOnly, selectedImageId]);

  if (!task) {
    return <div className="panel">正在加载任务...</div>;
  }

  return (
    <div className="page-stack">
      <section className="task-hero panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Task Workspace</p>
            <h2>{task.title}</h2>
          </div>
          <div className="button-cluster">
            <span className={`badge ${statusTone(task.status)}`}>{task.status}</span>
            <button type="button" className="ghost-button" onClick={() => exportTask("yolo")}>
              导出 YOLO
            </button>
            {assigneeMode ? (
              <button type="button" className="primary-button" onClick={submitForReview} disabled={readOnly || task.status === "in_review"}>
                提交审核
              </button>
            ) : null}
          </div>
        </div>
        <p>{task.description || "无任务说明"}</p>
        {showWorkflowBoard && flow ? (
          <div className="workflow-board">
            <div className="workflow-board__meta">
              <div className="workflow-kv">
                <span>当前状态</span>
                <strong>{flow.currentStatusLabel}</strong>
              </div>
              <div className="workflow-kv">
                <span>当前责任人</span>
                <strong>{currentOwnerName}</strong>
                <small>{flow.responsibilityRole}</small>
              </div>
              <div className="workflow-kv">
                <span>标注员</span>
                <strong>{assigneeName}</strong>
              </div>
              <div className="workflow-kv">
                <span>审核员</span>
                <strong>{reviewerName}</strong>
              </div>
              <div className="workflow-kv">
                <span>创建人</span>
                <strong>{creatorName}</strong>
              </div>
              <div className="workflow-kv">
                <span>下一步</span>
                <strong>{flow.nextAction}</strong>
              </div>
            </div>
            <ol className="workflow-steps">
              {flow.steps.map((step, index) => (
                <li key={step.key} className={`workflow-step is-${step.state}`}>
                  <span className="workflow-step__index">{index + 1}</span>
                  <strong>{step.title}</strong>
                  <small>{step.hint}</small>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </section>

      {!reviewerMode ? (
      <section className={`workspace-grid ${focusMode ? "is-focus-mode" : ""}`}>
        <section className={`panel editor-panel ${focusMode ? "is-focus-mode" : ""}`}>
          <div className="editor-toolbar">
            <div className="button-cluster">
              {assigneeMode ? (
                <button
                  type="button"
                  className={focusMode ? "primary-button" : "ghost-button"}
                  onClick={() => {
                    setFocusMode((value) => !value);
                    setZoom((value) => (focusMode ? value : Math.max(value, 1)));
                  }}
                >
                  {focusMode ? "退出专注" : "专注标注"}
                </button>
              ) : null}
              <button type="button" className="ghost-button" onClick={() => setShowLabels((value) => !value)}>
                {showLabels ? "隐藏标签" : "显示标签"}
              </button>
              <button type="button" className="ghost-button" onClick={() => setShowBoxes((value) => !value)}>
                {showBoxes ? "隐藏框" : "显示框"}
              </button>
              {selectedImage?.review_example_payload ? (
                <button type="button" className="ghost-button" onClick={() => setShowReviewExample((value) => !value)}>
                  {showReviewExample ? "隐藏审核示例" : "显示审核示例"}
                </button>
              ) : null}
              <button
                type="button"
                className={`ghost-button ${payload.is_no_object ? "is-active" : ""}`}
                onClick={toggleNoObject}
                disabled={readOnly}
              >
                标记无目标
              </button>
            </div>
            {focusMode ? (
              <div className="focus-sample-progress" title={currentSampleName}>
                <div className="focus-sample-progress__meta">
                  <strong>{currentSampleName}</strong>
                  <span>
                    {currentSampleIndex}/{totalSampleCount} ({currentSampleProgress}%)
                  </span>
                </div>
                <div
                  className="focus-sample-progress__track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={totalSampleCount}
                  aria-valuenow={currentSampleIndex}
                >
                  <div className="focus-sample-progress__bar" style={{ width: `${currentSampleProgress}%` }} />
                </div>
              </div>
            ) : null}
            <div className="focus-class-strip">
              {task.classes.map((label) => (
                <div key={label.id} className="class-chip-line">
                  <button
                    type="button"
                    className={`class-chip ${selectedClassId === label.id ? "is-selected" : ""}`}
                    onClick={() => setSelectedClassId(label.id)}
                    style={{ borderColor: label.color }}
                    disabled={readOnly}
                  >
                    <span className="class-chip__dot" style={{ backgroundColor: label.color }} />
                    {label.name}
                  </button>
                  <button
                    type="button"
                    className="class-chip-remove"
                    onClick={() => deleteClassById(label.id, label.name)}
                    disabled={readOnly}
                    aria-label={`删除类别 ${label.name}`}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
            <label className="zoom-control">
              <span>Zoom {Math.round(zoom * 100)}%</span>
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.02}
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
              />
            </label>
          </div>
          {selectedImage ? (
            <AnnotationCanvas
              imageUrl={imageUrl}
              imageWidth={selectedImage.width}
              imageHeight={selectedImage.height}
              payload={payload}
              classes={task.classes}
              selectedClassId={selectedClassId}
              readOnly={readOnly}
              zoom={zoom}
              showLabels={showLabels}
              showBoxes={showBoxes}
              backgroundPayload={showReviewExample ? selectedImage.review_example_payload : null}
              backgroundLabel="审核示例"
              onChange={updatePayload}
              onBoxDrawn={handleBoxDrawn}
            />
          ) : (
            <div className="empty-state">请选择一张图片开始标注</div>
          )}
          {message ? <p className="inline-message">{message}</p> : null}
          {!message && readOnlyReason ? <p className="inline-message">{readOnlyReason}</p> : null}
        </section>

        {!focusMode ? (
          <aside className="panel side-tools">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Classes</p>
              <h3>类别与状态</h3>
            </div>
          </div>
          <div className="class-list">
            {task.classes.length ? (
              task.classes.map((label) => (
                <div key={label.id} className="class-chip-line">
                  <button
                    type="button"
                    className={`class-chip ${selectedClassId === label.id ? "is-selected" : ""}`}
                    onClick={() => setSelectedClassId(label.id)}
                    style={{ borderColor: label.color }}
                  >
                    <span className="class-chip__dot" style={{ backgroundColor: label.color }} />
                    {label.name}
                  </button>
                  <button
                    type="button"
                    className="class-chip-remove"
                    onClick={() => deleteClassById(label.id, label.name)}
                    aria-label={`删除类别 ${label.name}`}
                  >
                    删除
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-state compact">当前任务还没有类别。可先画框，随后新增类别并补齐类别信息。</div>
            )}
          </div>
          <div className="class-form">
            <label>
              <span>新类别名称</span>
              <input value={newClassName} onChange={(event) => setNewClassName(event.target.value)} placeholder="例如 pallet" />
            </label>
            <label>
              <span>颜色</span>
              <input type="color" value={newClassColor} onChange={(event) => setNewClassColor(event.target.value)} />
            </label>
            <button type="button" className="ghost-button" onClick={addClass}>
              新增类别
            </button>
            <button type="button" className="ghost-button" onClick={removeClassByInput}>
              按输入删除类别
            </button>
          </div>
          <div className="detail-block detail-block--compact">
            <div className="detail-block__row">
              <h4>当前图像</h4>
              <span className={`badge ${selectedImage ? statusTone(selectedImage.per_image_status) : "badge-muted"}`}>
                {selectedImage?.per_image_status ?? "not_started"}
              </span>
            </div>
            <p className="detail-block__name" title={selectedImage?.file_path}>
              {currentSampleName}
            </p>
            <p className="detail-block__meta" title={currentSampleFolderLabel}>
              目录 {currentSampleFolderLabel}
            </p>
            <p className="detail-block__meta">
              尺寸 {selectedImage?.width} × {selectedImage?.height}
            </p>
            {selectedImage?.review_comment ? (
              <p className="detail-block__meta detail-block__meta--muted" title={selectedImage.review_comment}>
                审核意见：{selectedImage.review_comment}
              </p>
            ) : null}
          </div>
          <div className="task-samples-dock">
            <div className="task-samples-dock__head">
              <div>
                <p className="eyebrow">Samples</p>
                <h4>任务样本</h4>
              </div>
              <Link to="/shortcuts" className="ghost-button task-samples-dock__help-link">
                快捷键说明
              </Link>
            </div>
            <div className="sample-list-window sample-list-window--dock" ref={sampleListRef}>
              <div className="sample-current-meta" title={`${currentSampleName} · ${currentSampleFolderLabel}`}>
                当前样本: {currentSampleName} · 目录: {currentSampleFolderLabel}
              </div>
              <div className="sample-folder-filter" aria-label="目录筛选">
                <button
                  type="button"
                  className={`sample-folder-chip ${activeFolderPath === ALL_FOLDERS_KEY ? "is-active" : ""}`}
                  onClick={() => setActiveFolderPath(ALL_FOLDERS_KEY)}
                >
                  全部目录 ({totalTaskImageCount})
                </button>
                {folderGroups.map((group) => (
                  <button
                    key={group.folderPath || "__root__"}
                    type="button"
                    className={`sample-folder-chip ${activeFolderPath === group.folderPath ? "is-active" : ""}`}
                    onClick={() => setActiveFolderPath(group.folderPath)}
                    title={group.folderLabel}
                  >
                    {folderNameOf(group.folderPath)} ({group.images.length})
                  </button>
                ))}
              </div>
              <div className="sample-table-body">
                <div className="sample-folder-groups">
                  {visibleFolderGroups.map((group) => (
                    <section key={group.folderPath || "__root__"} className="sample-folder-group">
                      <header
                        className="sample-folder-group__head"
                        title={group.folderLabel}
                        style={{ paddingLeft: `${10 + Math.min(folderDepthOf(group.folderPath), 6) * 12}px` }}
                      >
                        <strong>{folderNameOf(group.folderPath)}</strong>
                        <span>{group.folderLabel}</span>
                        <small>{group.images.length} 张</small>
                      </header>
                      <div className="image-list image-list--line">
                        {group.images.map((image) => (
                          <button
                            key={image.id}
                            type="button"
                            data-image-id={image.id}
                            className={`image-list__item image-list__item--line ${selectedImageId === image.id ? "is-active" : ""}`}
                            onClick={() => setSelectedImageId(image.id)}
                            title={image.file_path}
                          >
                            <span className="sample-line-index">{sampleIndexByImageId[image.id] ?? "-"}</span>
                            <span className="sample-line-name">{image.file_path.split("/").pop() ?? image.file_path}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </aside>
        ) : null}
      </section>
      ) : null}

      {pendingClassBoxId && !reviewerMode ? (
        <div className="class-assign-overlay" role="dialog" aria-modal="true">
          <div className="panel class-assign-dialog">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Class Assign</p>
                <h3>为新标注框设置类别</h3>
              </div>
            </div>
            <p className="class-assign-tip">可直接点击已存在类别快速应用，或输入新类别名称后确认。</p>
            {task.classes.length ? (
              <div className="class-assign-quick">
                {task.classes.map((label) => (
                  <button
                    key={label.id}
                    type="button"
                    className="class-chip"
                    style={{ borderColor: label.color }}
                    onClick={() => pickPendingClass(label)}
                  >
                    <span className="class-chip__dot" style={{ backgroundColor: label.color }} />
                    {label.name}
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state compact">暂无可选类别，请输入新类别名称。</div>
            )}
            <form
              className="class-assign-form"
              onSubmit={(event) => {
                event.preventDefault();
                void confirmPendingClass();
              }}
            >
              <label>
                <span>类别名称</span>
                <input
                  ref={classAssignInputRef}
                  value={pendingClassInput}
                  onChange={(event) => setPendingClassInput(event.target.value)}
                  placeholder="例如 pallet / crack"
                />
              </label>
              <div className="button-cluster">
                <button type="button" className="ghost-button" onClick={() => closeClassAssignDialog(true)}>
                  取消并删除框
                </button>
                <button type="submit" className="primary-button">
                  确认并应用
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {reviewerMode ? (
        <ReviewWorkbench token={token} task={task} currentUserId={currentUser.id} onReviewed={loadTask} />
      ) : null}
    </div>
  );
}

function ShortcutGuidePage() {
  return (
    <div className="page-stack">
      <section className="panel shortcut-page">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Guides</p>
            <h2>快捷键与操作说明</h2>
          </div>
          <Link to="/" className="ghost-button">
            返回任务列表
          </Link>
        </div>
        <p className="shortcut-page__summary">
          标注界面已将样本列表固定在右下角。以下快捷键在标注画布中可直接使用，输入框内输入文字时不会触发。
        </p>
        <div className="shortcut-page__grid">
          <article className="shortcut-item">
            <h4>视图控制</h4>
            <p><kbd>+</kbd><kbd>-</kbd> 缩放画布</p>
            <p><kbd>0</kbd> 重置缩放至 100%</p>
            <p><kbd>Space</kbd> + 拖动 平移视野</p>
          </article>
          <article className="shortcut-item">
            <h4>标注显示</h4>
            <p><kbd>B</kbd> 显示/隐藏标注框</p>
            <p><kbd>L</kbd> 显示/隐藏标签</p>
            <p><kbd>N</kbd> 标记/取消无目标</p>
          </article>
          <article className="shortcut-item">
            <h4>样本切换</h4>
            <p><kbd>[</kbd><kbd>]</kbd> 上一张/下一张</p>
            <p><kbd>←</kbd><kbd>→</kbd> 上一张/下一张</p>
            <p><kbd>Delete</kbd> 删除当前选中框</p>
          </article>
        </div>
      </section>
    </div>
  );
}

type AuditLogRow = {
  id: string;
  actor_user_id?: string | null;
  action_type?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  summary?: string | null;
  timestamp?: string | null;
  before_json?: unknown;
  after_json?: unknown;
};

const AUDIT_NOISE_ACTIONS = new Set(["ANNOTATION_SAVE", "AUTH_LOGIN", "AUTH_LOGOUT"]);

const AUDIT_ACTION_LABELS: Record<string, string> = {
  USER_CREATE: "创建用户",
  USER_UPDATE: "更新用户",
  USER_DELETE: "删除用户",
  TASK_CREATE: "创建任务",
  TASK_UPDATE: "更新任务",
  TASK_DELETE: "删除任务",
  TASK_IMAGES_ADD: "追加图片",
  TASK_SUBMIT: "提交审核",
  TASK_REVIEW_COMPLETE: "审核完成",
  TASK_EXPORT: "导出任务",
  LABEL_CLASS_CREATE: "新增类别",
  LABEL_CLASS_UPDATE: "更新类别",
  LABEL_CLASS_DELETE: "删除类别"
};

function formatAuditTimestamp(timestamp: string | null | undefined) {
  if (!timestamp) {
    return "-";
  }
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  return parsed.toLocaleString("zh-CN", { hour12: false });
}

function formatAuditTarget(row: AuditLogRow) {
  const type = row.target_type ?? "-";
  const targetId = row.target_id ? String(row.target_id).slice(0, 8) : "-";
  return `${type} / ${targetId}`;
}

function formatAuditTargetFull(row: AuditLogRow) {
  const type = row.target_type ?? "-";
  const targetId = row.target_id ? String(row.target_id) : "-";
  return `${type} / ${targetId}`;
}

function compactAuditSummary(summary: string | null | undefined) {
  if (!summary) {
    return "-";
  }
  const compact = summary.replace(/\s+/g, " ").trim();
  if (compact.length <= 96) {
    return compact;
  }
  return `${compact.slice(0, 96)}...`;
}

function normalizeAuditSummary(summary: string | null | undefined) {
  if (!summary) {
    return "-";
  }
  return summary.replace(/\s+/g, " ").trim();
}

function formatAuditJson(payload: unknown) {
  if (payload === null || payload === undefined) {
    return "无";
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function AdminPage({ token, currentUser }: { token: string; currentUser: User }) {
  const [users, setUsers] = useState<User[]>([]);
  const [auditRows, setAuditRows] = useState<Array<Record<string, unknown>>>([]);
  const [selectedAuditRowId, setSelectedAuditRowId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadAdminData() {
    if (!currentUser.roles.includes("admin")) {
      return;
    }
    try {
      const [userRows, audit] = await Promise.all([api.users(token), api.audit(token)]);
      setUsers(userRows);
      setAuditRows(audit);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "管理后台加载失败");
    }
  }

  useEffect(() => {
    loadAdminData();
  }, [currentUser.roles, token]);

  async function handleUserCreated() {
    await loadAdminData();
  }

  const usersById: Record<string, User> = Object.fromEntries(users.map((item) => [item.id, item])) as Record<string, User>;
  const normalizedAuditRows = useMemo(
    () => (auditRows as AuditLogRow[]).filter((row) => !AUDIT_NOISE_ACTIONS.has(String(row.action_type ?? ""))),
    [auditRows]
  );
  const hiddenAuditCount = Math.max(0, auditRows.length - normalizedAuditRows.length);
  const visibleAuditRows = useMemo(() => normalizedAuditRows.slice(0, 180), [normalizedAuditRows]);
  const selectedAuditRow =
    (selectedAuditRowId ? visibleAuditRows.find((row) => String(row.id) === selectedAuditRowId) : null) ?? visibleAuditRows[0] ?? null;
  const selectedActorUserId = selectedAuditRow?.actor_user_id ? String(selectedAuditRow.actor_user_id) : "";
  const selectedActor = selectedActorUserId ? usersById[selectedActorUserId] : null;
  const selectedActorLabel = selectedActor
    ? `${selectedActor.display_name} (${selectedActor.username})`
    : selectedActorUserId
      ? `用户 ${selectedActorUserId.slice(0, 8)}`
      : "-";
  const selectedActionType = String(selectedAuditRow?.action_type ?? "");
  const selectedActionLabel = selectedAuditRow ? AUDIT_ACTION_LABELS[selectedActionType] ?? selectedActionType : "-";
  const selectedTimestampLabel = selectedAuditRow ? formatAuditTimestamp(selectedAuditRow.timestamp ?? null) : "-";
  const selectedTargetLabel = selectedAuditRow ? formatAuditTargetFull(selectedAuditRow) : "-";
  const selectedSummary = selectedAuditRow ? normalizeAuditSummary(selectedAuditRow.summary) : "-";

  useEffect(() => {
    if (!visibleAuditRows.length) {
      if (selectedAuditRowId !== null) {
        setSelectedAuditRowId(null);
      }
      return;
    }
    if (!selectedAuditRowId || !visibleAuditRows.some((row) => String(row.id) === selectedAuditRowId)) {
      setSelectedAuditRowId(String(visibleAuditRows[0].id));
    }
  }, [selectedAuditRowId, visibleAuditRows]);

  if (!currentUser.roles.includes("admin")) {
    return <div className="panel">当前账号不是管理员，无权访问后台。</div>;
  }

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Admin</p>
            <h2>用户与审计总览</h2>
          </div>
        </div>
        {message ? <p className="inline-message">{message}</p> : null}
        <div className="admin-grid">
          <UserCreatePanel token={token} onCreated={handleUserCreated} />
          <div className="admin-column">
            <h3>用户列表</h3>
            {users.map((user) => (
              <UserPermissionCard
                key={user.id}
                token={token}
                user={user}
                currentUserId={currentUser.id}
                onSaved={loadAdminData}
              />
            ))}
          </div>
          <div className="admin-column">
            <div className="audit-board">
              <div className="audit-board__head">
                <h3>最近审计</h3>
                <small>
                  总计 {auditRows.length} 条，展示 {visibleAuditRows.length} 条，过滤低价值记录 {hiddenAuditCount} 条
                </small>
              </div>
              <div className="audit-board__body">
                <div className="audit-table-wrap">
                  <table className="audit-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>动作</th>
                        <th>操作人</th>
                        <th>目标</th>
                        <th>摘要</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleAuditRows.map((row) => {
                        const actorUserId = row.actor_user_id ? String(row.actor_user_id) : "";
                        const actor = actorUserId ? usersById[actorUserId] : null;
                        const actorLabel = actor ? `${actor.display_name} (${actor.username})` : actorUserId ? `用户 ${actorUserId.slice(0, 8)}` : "-";
                        const actionType = String(row.action_type ?? "");
                        const actionLabel = AUDIT_ACTION_LABELS[actionType] ?? actionType;
                        const targetLabel = formatAuditTarget(row);
                        const targetTitle = formatAuditTargetFull(row);
                        const summaryLabel = compactAuditSummary(row.summary);
                        const summaryTitle = normalizeAuditSummary(row.summary);
                        const timestampLabel = formatAuditTimestamp(row.timestamp ?? null);
                        const rowId = String(row.id);
                        const isActive = selectedAuditRow ? String(selectedAuditRow.id) === rowId : false;
                        return (
                          <tr
                            key={rowId}
                            className={isActive ? "is-active" : ""}
                            onClick={() => setSelectedAuditRowId(rowId)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setSelectedAuditRowId(rowId);
                              }
                            }}
                            tabIndex={0}
                          >
                            <td title={timestampLabel}>{timestampLabel}</td>
                            <td title={actionLabel}>{actionLabel}</td>
                            <td title={actorLabel}>{actorLabel}</td>
                            <td title={targetTitle}>{targetLabel}</td>
                            <td title={summaryTitle}>{summaryLabel}</td>
                          </tr>
                        );
                      })}
                      {!visibleAuditRows.length ? (
                        <tr>
                          <td colSpan={5} className="audit-table__empty">
                            暂无可展示的审计记录
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
                <aside className="audit-detail" aria-live="polite">
                  <div className="audit-detail__head">
                    <h4>记录详情</h4>
                    <small>{selectedAuditRow ? `ID: ${String(selectedAuditRow.id).slice(0, 8)}` : "暂无选中记录"}</small>
                  </div>
                  {selectedAuditRow ? (
                    <div className="audit-detail__content">
                      <dl className="audit-detail__meta">
                        <div>
                          <dt>时间</dt>
                          <dd>{selectedTimestampLabel}</dd>
                        </div>
                        <div>
                          <dt>动作</dt>
                          <dd>{selectedActionLabel || "-"}</dd>
                        </div>
                        <div>
                          <dt>操作人</dt>
                          <dd>{selectedActorLabel}</dd>
                        </div>
                        <div>
                          <dt>目标</dt>
                          <dd>{selectedTargetLabel}</dd>
                        </div>
                      </dl>
                      <section className="audit-detail__section">
                        <h5>完整摘要</h5>
                        <p>{selectedSummary}</p>
                      </section>
                      <section className="audit-detail__section">
                        <h5>变更前</h5>
                        <pre>{formatAuditJson(selectedAuditRow.before_json)}</pre>
                      </section>
                      <section className="audit-detail__section">
                        <h5>变更后</h5>
                        <pre>{formatAuditJson(selectedAuditRow.after_json)}</pre>
                      </section>
                    </div>
                  ) : (
                    <p className="audit-detail__empty">当前没有可查看的审计记录。</p>
                  )}
                </aside>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function UserCreatePanel({ token, onCreated }: { token: string; onCreated: () => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [roles, setRoles] = useState<string[]>(["annotator"]);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function toggleRole(role: string) {
    setRoles((current) => (current.includes(role) ? current.filter((item) => item !== role) : [...current, role]));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cleanUsername = username.trim();
    const cleanDisplayName = displayName.trim() || cleanUsername;
    if (!cleanUsername || !password.trim()) {
      setMessage("请填写用户名和密码");
      return;
    }
    if (!roles.length) {
      setMessage("请至少选择一个角色");
      return;
    }

    setSubmitting(true);
    try {
      await api.createUser(token, {
        username: cleanUsername,
        password,
        display_name: cleanDisplayName,
        roles
      });
      setUsername("");
      setDisplayName("");
      setPassword("");
      setRoles(["annotator"]);
      setMessage(`已创建账号：${cleanUsername}`);
      await onCreated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建用户失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="admin-column account-form" onSubmit={submit}>
      <div>
        <p className="eyebrow">Create user</p>
        <h3>创建账号</h3>
        <p className="admin-panel-note">管理员可在这里直接创建标注员、审核员或任务管理员账号。</p>
      </div>
      <label>
        <span>用户名</span>
        <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="annotator01" autoComplete="off" />
      </label>
      <label>
        <span>显示名称</span>
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="标注员 1" />
      </label>
      <label>
        <span>初始密码</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="建议使用强密码"
          autoComplete="new-password"
        />
      </label>
      <div className="role-choice-grid">
        {USER_ROLE_OPTIONS.map((role) => (
          <label key={role.value} className={`role-choice ${roles.includes(role.value) ? "is-selected" : ""}`}>
            <input type="checkbox" checked={roles.includes(role.value)} onChange={() => toggleRole(role.value)} />
            <span>
              <strong>{role.label}</strong>
              <small>{role.description}</small>
            </span>
          </label>
        ))}
      </div>
      <button type="submit" className="primary-button" disabled={submitting}>
        {submitting ? "创建中..." : "创建账号"}
      </button>
      {message ? <p className="inline-message">{message}</p> : null}
    </form>
  );
}

function UserPermissionCard({
  token,
  user,
  currentUserId,
  onSaved
}: {
  token: string;
  user: User;
  currentUserId: string;
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [displayName, setDisplayName] = useState(user.display_name);
  const [isActive, setIsActive] = useState(user.is_active);
  const [roles, setRoles] = useState<string[]>(user.roles);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isCurrentUser = user.id === currentUserId;

  useEffect(() => {
    setDisplayName(user.display_name);
    setIsActive(user.is_active);
    setRoles(user.roles);
  }, [user.display_name, user.id, user.is_active, user.roles]);

  function toggleRole(role: string) {
    if (isCurrentUser && role === "admin" && roles.includes("admin")) {
      setMessage("不能移除当前登录账号的管理员权限");
      return;
    }
    setRoles((current) => (current.includes(role) ? current.filter((item) => item !== role) : [...current, role]));
  }

  function cancel() {
    setEditing(false);
    setMessage(null);
    setDisplayName(user.display_name);
    setIsActive(user.is_active);
    setRoles(user.roles);
  }

  async function save() {
    const cleanDisplayName = displayName.trim() || user.username;
    if (!roles.length) {
      setMessage("请至少保留一个角色");
      return;
    }
    if (isCurrentUser && !roles.includes("admin")) {
      setMessage("不能移除当前登录账号的管理员权限");
      return;
    }
    if (isCurrentUser && !isActive) {
      setMessage("不能禁用当前登录账号");
      return;
    }

    setSaving(true);
    try {
      await api.patchUser(token, user.id, {
        display_name: cleanDisplayName,
        is_active: isActive,
        roles
      });
      setEditing(false);
      setMessage("权限已保存");
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存权限失败");
    } finally {
      setSaving(false);
    }
  }

  async function removeUser() {
    if (isCurrentUser) {
      setMessage("不能删除当前登录账号");
      return;
    }
    const confirmed = window.confirm(
      `确认删除账号「${user.username}」？\n\n仅当账号没有任务与标注历史关联时才允许删除。`
    );
    if (!confirmed) {
      return;
    }

    setDeleting(true);
    try {
      await api.deleteUser(token, user.id);
      setMessage(`已删除账号：${user.username}`);
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除账号失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={`admin-row permission-card ${editing ? "is-editing" : ""}`}>
      <div className="admin-row__meta">
        <strong>{user.display_name}</strong>
        <span className={`admin-row__status ${user.is_active ? "is-active" : "is-disabled"}`}>
          {user.is_active ? "启用" : "禁用"}
        </span>
      </div>
      <span>{user.username}</span>
      <small>{user.roles.join(", ") || "未分配角色"}</small>

      {editing ? (
        <div className="permission-editor">
          <label>
            <span>显示名称</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label className={`permission-toggle ${isCurrentUser ? "is-disabled" : ""}`}>
            <input
              type="checkbox"
              checked={isActive}
              disabled={isCurrentUser}
              onChange={(event) => setIsActive(event.target.checked)}
            />
            <span>{isCurrentUser ? "当前登录账号保持启用" : "账号启用"}</span>
          </label>
          <div className="role-choice-grid compact">
            {USER_ROLE_OPTIONS.map((role) => {
              const selected = roles.includes(role.value);
              const locked = isCurrentUser && role.value === "admin" && selected;
              return (
                <label key={role.value} className={`role-choice ${selected ? "is-selected" : ""} ${locked ? "is-locked" : ""}`}>
                  <input type="checkbox" checked={selected} disabled={locked} onChange={() => toggleRole(role.value)} />
                  <span>
                    <strong>{role.label}</strong>
                    <small>{locked ? "当前账号必须保留 admin 权限" : role.description}</small>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="button-cluster">
            <button type="button" className="primary-button" onClick={save} disabled={saving}>
              {saving ? "保存中..." : "保存权限"}
            </button>
            <button type="button" className="ghost-button" onClick={cancel} disabled={saving}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div className="button-cluster">
          <button type="button" className="ghost-button permission-edit-button" onClick={() => setEditing(true)}>
            修改权限
          </button>
          {!isCurrentUser ? (
            <button type="button" className="danger-button" onClick={removeUser} disabled={deleting}>
              {deleting ? "删除中..." : "删除账号"}
            </button>
          ) : null}
        </div>
      )}
      {message ? <p className="inline-message">{message}</p> : null}
    </div>
  );
}

function LoginScreen() {
  const { login, loading } = useAuth();
  const rememberedLogin = useMemo(loadRememberedLogin, []);
  const [username, setUsername] = useState(rememberedLogin.username);
  const [password, setPassword] = useState(rememberedLogin.password);
  const [rememberPassword, setRememberPassword] = useState(rememberedLogin.rememberPassword);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cleanUsername = username.trim();
    try {
      await login(cleanUsername, password);
      persistRememberedLogin(cleanUsername, password, rememberPassword);
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败");
    }
  }

  return (
    <div className="login-screen">
      <div className="login-stage">
        <div className="login-copy">
          <p className="eyebrow">Industrial Editorial UI</p>
          <h1>LabelWe</h1>
          <p>
            从任务分发到逐张审核的一体化检测标注平台。它保留了 LabelImg 的画框效率，同时把权限、审核和审计都搬到一个协同工作台里。
          </p>
        </div>
        <form className="login-card" onSubmit={submit} autoComplete="off">
          <label>
            <span>用户名</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              placeholder="请输入用户名"
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              placeholder="请输入密码"
            />
          </label>
          <label className="permission-toggle">
            <input
              type="checkbox"
              checked={rememberPassword}
              onChange={(event) => {
                const nextChecked = event.target.checked;
                setRememberPassword(nextChecked);
                if (!nextChecked) {
                  persistRememberedLogin("", "", false);
                }
              }}
            />
            <span>记住密码（仅当前浏览器）</span>
          </label>
          <button type="submit" className="primary-button" disabled={loading}>
            登录
          </button>
          {error ? <p className="inline-message">{error}</p> : null}
          <div className="login-hints">
            <strong>登录提示</strong>
            <small>请使用管理员分配的账号与密码登录</small>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const { token, user, loading } = useAuth();

  if (loading) {
    return <div className="splash-screen">正在连接 LabelWe...</div>;
  }

  if (!token || !user) {
    return <LoginScreen />;
  }

  return <AppShell />;
}


