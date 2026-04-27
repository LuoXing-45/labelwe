import { useEffect, useState } from "react";
import { api, type StorageFile, type User } from "../lib/api";

type Props = {
  token: string;
  users: User[];
  onCreated: () => Promise<void>;
};

function parentPathOf(path: string) {
  const parts = path.split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}

export function TaskComposer({ token, users, onCreated }: Props) {
  const [rootName, setRootName] = useState("workspace-samples");
  const [browsePath, setBrowsePath] = useState("");
  const [directories, setDirectories] = useState<Array<{ name: string; path: string }>>([]);
  const [files, setFiles] = useState<StorageFile[]>([]);
  const [fileTotal, setFileTotal] = useState(0);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [title, setTitle] = useState("现场协同标注任务");
  const [description, setDescription] = useState("由 LabelWe 创建的协同检测标注任务");
  const [assigneeUserId, setAssigneeUserId] = useState("");
  const [reviewerUserId, setReviewerUserId] = useState("");
  const [creating, setCreating] = useState(false);
  const [batchSelecting, setBatchSelecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const annotators = users.filter((item) => item.roles.includes("annotator") || item.roles.includes("admin"));
  const reviewers = users.filter((item) => item.roles.includes("reviewer") || item.roles.includes("admin"));

  useEffect(() => {
    if (!assigneeUserId && annotators[0]) {
      setAssigneeUserId(annotators[0].id);
    }
  }, [annotators, assigneeUserId]);

  useEffect(() => {
    if (!reviewerUserId && reviewers[0]) {
      setReviewerUserId(reviewers[0].id);
    }
  }, [reviewers, reviewerUserId]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const roots = await api.storageRoots(token);
        if (active && roots[0]) {
          setRootName(roots[0].name);
        }
      } catch {
        // keep defaults
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    let active = true;
    async function browse() {
      try {
        const response = await api.storageBrowse(token, rootName, browsePath);
        if (active) {
          setDirectories(response.directories);
          setFiles(response.files);
          setFileTotal(response.total);
        }
      } catch (error) {
        if (active) {
          setMessage(error instanceof Error ? error.message : "目录浏览失败");
        }
      }
    }
    browse();
    return () => {
      active = false;
    };
  }, [browsePath, rootName, token]);

  async function submit() {
    if (!selectedPaths.length || !assigneeUserId || !reviewerUserId) {
      setMessage("请先选择图像、标注员和审核员");
      return;
    }

    setCreating(true);
    setMessage(null);
    try {
      await api.createTask(token, {
        title,
        description,
        assignee_user_id: assigneeUserId,
        reviewer_user_id: reviewerUserId,
        storage_root_ref: rootName,
        priority: "high",
        images: selectedPaths.map((path) => ({ relative_path: path })),
        label_classes: []
      });
      setSelectedPaths([]);
      setMessage("任务已创建");
      await onCreated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "任务创建失败");
    } finally {
      setCreating(false);
    }
  }

  function togglePath(path: string) {
    setSelectedPaths((previous) =>
      previous.includes(path) ? previous.filter((item) => item !== path) : [...previous, path]
    );
  }

  function mergeSelectedPaths(paths: string[]) {
    setSelectedPaths((previous) => Array.from(new Set([...previous, ...paths])));
  }

  function removeSelectedPaths(paths: string[]) {
    const removing = new Set(paths);
    setSelectedPaths((previous) => previous.filter((item) => !removing.has(item)));
  }

  async function updateFolderSelection(mode: "select" | "unselect", recursive: boolean) {
    setBatchSelecting(true);
    setMessage(null);
    try {
      const response = await api.storageFolderImages(token, rootName, browsePath, recursive, 20000);
      const paths = response.files.map((file) => file.path);
      if (!paths.length) {
        setMessage(recursive ? "当前文件夹及子目录没有可分发的图片" : "当前文件夹没有可分发的图片");
        return;
      }

      if (mode === "select") {
        mergeSelectedPaths(paths);
      } else {
        removeSelectedPaths(paths);
      }

      const scope = recursive ? "当前文件夹及子目录" : "当前文件夹";
      const action = mode === "select" ? "选择" : "取消";
      const limitHint =
        response.total > response.files.length
          ? `（命中上限，已处理 ${response.files.length}/${response.total} 张）`
          : "";
      setMessage(`已${action}${scope}中的 ${paths.length} 张图片${limitHint}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "文件夹批量选择失败");
    } finally {
      setBatchSelecting(false);
    }
  }

  function selectCurrentFolder() {
    void updateFolderSelection("select", false);
  }

  function selectCurrentFolderRecursively() {
    void updateFolderSelection("select", true);
  }

  function unselectCurrentFolder() {
    void updateFolderSelection("unselect", false);
  }

  function unselectCurrentFolderRecursively() {
    void updateFolderSelection("unselect", true);
  }

  const selectedSet = new Set(selectedPaths);
  const currentFolderSelectedCount = files.filter((file) => selectedSet.has(file.path)).length;
  const visibleFileLabel = files.length === fileTotal ? `${fileTotal} 张` : `显示 ${files.length}/${fileTotal} 张`;
  const pathParts = browsePath.split("/").filter(Boolean);
  const breadcrumbs = [
    { label: "根目录", path: "" },
    ...pathParts.map((part, index) => ({ label: part, path: pathParts.slice(0, index + 1).join("/") }))
  ];

  return (
    <section className="panel composer-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Manager Console</p>
          <h2>任务分发工作台</h2>
        </div>
        <span className="badge badge-highlight">{selectedPaths.length} 张已选</span>
      </div>
      <div className="composer-grid">
        <div className="composer-browser">
          <div className="composer-browser__path">
            <button type="button" className="ghost-button" onClick={() => setBrowsePath("")}>
              根目录
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setBrowsePath(parentPathOf(browsePath))}
              disabled={!browsePath}
            >
              上一级
            </button>
            <div className="path-crumbs" aria-label="当前目录路径">
              {breadcrumbs.map((crumb, index) => (
                <button
                  key={crumb.path || "root"}
                  type="button"
                  className={`path-crumb ${crumb.path === browsePath ? "is-current" : ""}`}
                  onClick={() => setBrowsePath(crumb.path)}
                >
                  {index > 0 ? "/" : ""}
                  {crumb.label}
                </button>
              ))}
            </div>
          </div>

          <div className="folder-toolbar">
            <div>
              <strong>当前文件夹</strong>
              <small>{visibleFileLabel}，当前列表 {currentFolderSelectedCount} 张已选（支持递归子目录批量）</small>
            </div>
            <div className="button-cluster">
              <button type="button" className="ghost-button" onClick={selectCurrentFolder} disabled={batchSelecting}>
                全选当前层
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={selectCurrentFolderRecursively}
                disabled={batchSelecting}
              >
                全选含子目录
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={unselectCurrentFolder}
                disabled={batchSelecting}
              >
                取消当前层
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={unselectCurrentFolderRecursively}
                disabled={batchSelecting}
              >
                取消含子目录
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setSelectedPaths([])}
                disabled={!selectedPaths.length || batchSelecting}
              >
                清空全部
              </button>
            </div>
          </div>

          {message ? <p className="inline-message composer-browser-message">{message}</p> : null}

          <div className="composer-browser__dirs">
            {directories.map((directory) => (
              <div key={directory.path} className="directory-card">
                <button type="button" className="directory-pill" onClick={() => setBrowsePath(directory.path)}>
                  {directory.name}
                </button>
              </div>
            ))}
          </div>

          {files.length ? (
            <div className="selection-summary">
              <span>单张选择</span>
              <small>也可以直接勾选下面的图片，已选图片会跨文件夹保留。</small>
            </div>
          ) : (
            <div className="empty-state compact">当前文件夹没有可选图片，可进入子文件夹或选择其他目录。</div>
          )}

          <div className="composer-browser__files">
            {files.map((file) => (
              <label key={file.path} className={`file-card ${selectedSet.has(file.path) ? "is-selected" : ""}`}>
                <input type="checkbox" checked={selectedSet.has(file.path)} onChange={() => togglePath(file.path)} />
                <div>
                  <strong>{file.name}</strong>
                  <small>
                    {file.width} x {file.height}
                  </small>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="composer-form">
          <label>
            <span>任务标题</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            <span>任务说明</span>
            <textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label>
            <span>标注员</span>
            <select value={assigneeUserId} onChange={(event) => setAssigneeUserId(event.target.value)}>
              {annotators.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.display_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>审核员</span>
            <select value={reviewerUserId} onChange={(event) => setReviewerUserId(event.target.value)}>
              {reviewers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.display_name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="primary-button" onClick={submit} disabled={creating}>
            {creating ? "创建中..." : "创建任务"}
          </button>
        </div>
      </div>
    </section>
  );
}
