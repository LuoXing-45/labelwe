import { useEffect, useMemo, useRef, useState } from "react";
import { AnnotationCanvas } from "./AnnotationCanvas";
import {
  api,
  fetchImageBlob,
  type AnnotationPayload,
  type LabelClass,
  type SubmissionDetail,
  type TaskDetail
} from "../lib/api";

type DecisionState = {
  decision: "passed" | "failed";
  comment: string;
  example_payload: AnnotationPayload;
};

type Props = {
  token: string;
  task: TaskDetail;
  currentUserId: string;
  onReviewed: () => Promise<void>;
};

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 6;
const ZOOM_STEP = 0.1;
const ALL_FOLDERS_KEY = "__all_folders__";

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
}

function normalizeClassName(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

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

export function ReviewWorkbench({ token, task, currentUserId, onReviewed }: Props) {
  const [submission, setSubmission] = useState<SubmissionDetail | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, DecisionState>>({});
  const [overallComment, setOverallComment] = useState("");
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [activeFolderPath, setActiveFolderPath] = useState<string>(ALL_FOLDERS_KEY);
  const [zoom, setZoom] = useState(1);
  const [showLabels, setShowLabels] = useState(true);
  const [showBoxes, setShowBoxes] = useState(true);
  const [pendingClassBoxId, setPendingClassBoxId] = useState<string | null>(null);
  const [pendingClassInput, setPendingClassInput] = useState("");
  const sampleListRef = useRef<HTMLDivElement | null>(null);
  const classAssignInputRef = useRef<HTMLInputElement | null>(null);

  const reviewerMode = task.reviewer_user_id === currentUserId;

  function cloneEmptyPayload(): AnnotationPayload {
    return { annotation_state: "not_started", is_no_object: false, boxes: [] };
  }

  const submissionEntries = useMemo(() => {
    if (!submission) {
      return [] as Array<{
        submissionImage: SubmissionDetail["images"][number];
        taskImage: TaskDetail["images"][number] | undefined;
        task_image_id: string;
        filePath: string;
        folderPath: string;
        folderLabel: string;
        fileName: string;
      }>;
    }

    const taskImageById = new Map(task.images.map((image) => [image.id, image]));
    return submission.images
      .map((item) => {
        const taskImage = taskImageById.get(item.task_image_id);
        const filePath = taskImage?.file_path ?? item.task_image_id;
        const folderPath = folderPathOf(filePath);
        return {
          submissionImage: item,
          taskImage,
          task_image_id: item.task_image_id,
          filePath,
          folderPath,
          folderLabel: folderLabelOf(folderPath),
          fileName: filePath.split("/").pop() ?? filePath
        };
      })
      .sort((left, right) =>
        normalizeImagePath(left.filePath).localeCompare(normalizeImagePath(right.filePath), "zh-CN", {
          numeric: true,
          sensitivity: "base"
        })
      );
  }, [submission, task.images]);

  const folderGroups = useMemo(() => {
    const grouped = new Map<string, typeof submissionEntries>();
    submissionEntries.forEach((entry) => {
      const bucket = grouped.get(entry.folderPath);
      if (bucket) {
        bucket.push(entry);
      } else {
        grouped.set(entry.folderPath, [entry]);
      }
    });
    return Array.from(grouped.entries()).map(([folderPath, entries]) => ({
      folderPath,
      folderLabel: folderLabelOf(folderPath),
      entries
    }));
  }, [submissionEntries]);

  const filteredEntries = useMemo(
    () =>
      activeFolderPath === ALL_FOLDERS_KEY
        ? submissionEntries
        : submissionEntries.filter((entry) => entry.folderPath === activeFolderPath),
    [activeFolderPath, submissionEntries]
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
      Object.fromEntries(filteredEntries.map((entry, index) => [entry.task_image_id, index + 1])) as Record<string, number>,
    [filteredEntries]
  );

  useEffect(() => {
    if (!selectedClassId && task.classes[0]) {
      setSelectedClassId(task.classes[0].id);
    }
  }, [selectedClassId, task.classes]);

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
    if (!filteredEntries.length) {
      setSelectedImageId(null);
      return;
    }
    if (!selectedImageId || !filteredEntries.some((entry) => entry.task_image_id === selectedImageId)) {
      setSelectedImageId(filteredEntries[0].task_image_id);
    }
  }, [filteredEntries, selectedImageId]);

  useEffect(() => {
    if (!selectedImageId) {
      return;
    }
    const container = sampleListRef.current;
    if (!container) {
      return;
    }
    const selectedItem = container.querySelector<HTMLButtonElement>(`.image-list__item[data-image-id="${selectedImageId}"]`);
    selectedItem?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedImageId, submission?.id, focusMode]);

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
    function selectRelativeImage(step: number) {
      if (!filteredEntries.length) {
        return;
      }
      const currentIndex = filteredEntries.findIndex((entry) => entry.task_image_id === selectedImageId);
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = Math.min(Math.max(baseIndex + step, 0), filteredEntries.length - 1);
      setSelectedImageId(filteredEntries[nextIndex]?.task_image_id ?? null);
    }

    function onKeydown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }

      if (pendingClassBoxId) {
        if (event.key === "Escape") {
          closeClassAssignDialog(true);
          event.preventDefault();
        }
        return;
      }

      if (event.key === "Escape" && focusMode) {
        setFocusMode(false);
        event.preventDefault();
        return;
      }

      const key = event.key.toLowerCase();
      let handled = true;
      if (key === "+" || key === "=") {
        setZoom((value) => clampZoom(value + ZOOM_STEP));
      } else if (key === "-" || key === "_") {
        setZoom((value) => clampZoom(value - ZOOM_STEP));
      } else if (key === "0") {
        setZoom(1);
      } else if (key === "b") {
        setShowBoxes((value) => !value);
      } else if (key === "l") {
        setShowLabels((value) => !value);
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
  }, [filteredEntries, focusMode, pendingClassBoxId, selectedImageId]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const submissions = await api.submissions(token, task.id);
        const pending = submissions.find((item) => item.status === "pending_review");
        if (!pending) {
          if (active) {
            setSubmission(null);
            setLoading(false);
          }
          return;
        }

        const detail = await api.submission(token, pending.id);
        if (!active) {
          return;
        }

        setSubmission(detail);
        setSelectedImageId(detail.images[0]?.task_image_id ?? null);
        setFocusMode(false);
        setZoom(1);
        setShowLabels(true);
        setShowBoxes(true);
        setPendingClassBoxId(null);
        setPendingClassInput("");
        const initial: Record<string, DecisionState> = {};
        detail.images.forEach((item) => {
          initial[item.task_image_id] = {
            decision: item.review?.decision ?? "passed",
            comment: item.review?.comment ?? "",
            example_payload: item.review?.example_payload ?? cloneEmptyPayload()
          };
        });
        setDecisions(initial);
        setLoading(false);
      } catch (error) {
        if (active) {
          setMessage(error instanceof Error ? error.message : "加载审核数据失败");
          setLoading(false);
        }
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [task.id, token]);

  useEffect(() => {
    let active = true;
    async function loadPreview() {
      if (!selectedImageId) {
        setPreviewUrl(null);
        return;
      }
      try {
        const url = await fetchImageBlob(token, task.id, selectedImageId);
        if (!active) {
          URL.revokeObjectURL(url);
          return;
        }
        setPreviewUrl((previous) => {
          if (previous) {
            URL.revokeObjectURL(previous);
          }
          return url;
        });
      } catch {
        if (active) {
          setPreviewUrl(null);
        }
      }
    }
    loadPreview();
    return () => {
      active = false;
    };
  }, [selectedImageId, task.id, token]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  if (loading) {
    return <section className="panel review-panel">加载审核工作台中...</section>;
  }

  if (!submission) {
    return (
      <section className="panel review-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Review Queue</p>
            <h2>当前没有待审核提交</h2>
          </div>
        </div>
      </section>
    );
  }

  const activeSubmission = submission;
  const selectedEntry =
    filteredEntries.find((entry) => entry.task_image_id === selectedImageId) ??
    filteredEntries[0] ??
    submissionEntries[0];

  if (!selectedEntry) {
    return (
      <section className="panel review-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Review Queue</p>
            <h2>本次提交没有图像</h2>
          </div>
        </div>
      </section>
    );
  }

  const selected = selectedEntry.submissionImage;
  const selectedTaskImage = selectedEntry.taskImage;
  const selectedDecision = decisions[selected.task_image_id] ?? {
    decision: "passed",
    comment: "",
    example_payload: cloneEmptyPayload()
  };
  const selectedIndex = sampleIndexByImageId[selected.task_image_id] ?? 0;
  const totalCount = filteredEntries.length;
  const totalSubmissionCount = submissionEntries.length;
  const selectedFileName = selectedEntry.fileName;
  const selectedFolderLabel = selectedEntry.folderLabel;

  const submitterName =
    activeSubmission.submitter?.display_name?.trim() ||
    activeSubmission.submitter?.username?.trim() ||
    activeSubmission.submitter_id;
  const parsedCreatedAt = Date.parse(activeSubmission.created_at);
  const submittedAtText = Number.isNaN(parsedCreatedAt)
    ? activeSubmission.created_at
    : new Date(parsedCreatedAt).toLocaleString("zh-CN", { hour12: false });

  function updateDecision(taskImageId: string, next: Partial<DecisionState>) {
    setDecisions((current) => ({
      ...current,
      [taskImageId]: {
        ...(current[taskImageId] ?? { decision: "passed", comment: "", example_payload: cloneEmptyPayload() }),
        ...next
      }
    }));
  }

  function findClassByName(name: string) {
    const normalized = normalizeClassName(name).toLowerCase();
    return task.classes.find((item) => item.name.trim().toLowerCase() === normalized) ?? null;
  }

  function updateExamplePayload(mutator: (payload: AnnotationPayload) => AnnotationPayload) {
    const currentPayload = selectedDecision.example_payload ?? cloneEmptyPayload();
    const nextPayload = mutator(currentPayload);
    updateDecision(selected.task_image_id, { example_payload: nextPayload });
  }

  function removeExampleBoxById(boxId: string) {
    updateExamplePayload((current) => {
      const boxes = current.boxes.filter((box) => box.id !== boxId);
      return {
        ...current,
        boxes,
        annotation_state: current.is_no_object ? "no_object" : boxes.length ? "annotated" : "not_started"
      };
    });
  }

  function applyClassToExampleBox(boxId: string, name: string, color: string, classId?: string) {
    updateExamplePayload((current) => {
      const boxes = current.boxes.map((box) =>
        box.id === boxId
          ? {
              ...box,
              class_id: classId,
              class_name: name,
              color
            }
          : box
      );
      return {
        ...current,
        boxes,
        annotation_state: current.is_no_object ? "no_object" : boxes.length ? "annotated" : "not_started"
      };
    });
  }

  function openClassAssignDialog(boxId: string) {
    if (!reviewerMode || !boxId) {
      return;
    }
    const preset = selectedClassId ? task.classes.find((item) => item.id === selectedClassId)?.name ?? "" : "";
    setPendingClassBoxId(boxId);
    setPendingClassInput(preset);
  }

  function closeClassAssignDialog(removePendingBox: boolean) {
    if (removePendingBox && pendingClassBoxId) {
      removeExampleBoxById(pendingClassBoxId);
      setMessage("已取消类别输入，示例框已移除");
    }
    setPendingClassBoxId(null);
    setPendingClassInput("");
  }

  function pickPendingClass(label: LabelClass) {
    if (!pendingClassBoxId) {
      return;
    }
    setSelectedClassId(label.id);
    applyClassToExampleBox(pendingClassBoxId, label.name, label.color, label.id);
    setPendingClassBoxId(null);
    setPendingClassInput("");
    setMessage(`示例框已设置为类别：${label.name}`);
  }

  function confirmPendingClass(nameOverride?: string) {
    if (!pendingClassBoxId) {
      return;
    }

    const normalized = normalizeClassName(nameOverride ?? pendingClassInput);
    if (!normalized) {
      setMessage("类别名称不能为空");
      return;
    }

    const existing = findClassByName(normalized);
    if (existing) {
      setSelectedClassId(existing.id);
      applyClassToExampleBox(pendingClassBoxId, existing.name, existing.color, existing.id);
    } else {
      const selectedColor = task.classes.find((item) => item.id === selectedClassId)?.color ?? "#ff7a18";
      applyClassToExampleBox(pendingClassBoxId, normalized, selectedColor);
    }
    setPendingClassBoxId(null);
    setPendingClassInput("");
    setMessage(`示例框已设置类别：${normalized}`);
  }

  function handleExampleBoxDrawn(boxId: string) {
    openClassAssignDialog(boxId);
  }

  async function submitReview(nextDecisions: Record<string, DecisionState>, successMessage: string, errorMessage: string) {
    try {
      const decisionsPayload = activeSubmission.images.map((item) => ({
        task_image_id: item.task_image_id,
        decision: nextDecisions[item.task_image_id]?.decision ?? "passed",
        comment: nextDecisions[item.task_image_id]?.comment || undefined,
        example_payload:
          nextDecisions[item.task_image_id]?.decision === "failed" ? nextDecisions[item.task_image_id]?.example_payload : undefined
      }));
      await api.reviewComplete(token, activeSubmission.id, {
        overall_comment: overallComment,
        decisions: decisionsPayload
      });
      setMessage(successMessage);
      await onReviewed();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : errorMessage);
    }
  }

  async function complete() {
    await submitReview(decisions, "审核已完成", "审核提交失败");
  }

  async function approveAll() {
    const confirmed = window.confirm(
      `确认批量通过当前提交的 ${activeSubmission.images.length} 张图片吗？\n\n此操作将直接完成本次审核。`
    );
    if (!confirmed) {
      return;
    }
    try {
      await api.batchApprove(token, activeSubmission.id);
      setMessage("已批量通过全部图片");
      await onReviewed();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "批量通过失败");
    }
  }

  async function rejectAll() {
    const confirmed = window.confirm(
      `确认批量打回当前提交的 ${activeSubmission.images.length} 张图片吗？\n\n此操作将把全部图片标记为打回并完成审核。`
    );
    if (!confirmed) {
      return;
    }

    const rejected: Record<string, DecisionState> = {};
    activeSubmission.images.forEach((item) => {
      const current = decisions[item.task_image_id];
      rejected[item.task_image_id] = {
        decision: "failed",
        comment: current?.comment ?? "",
        example_payload: current?.example_payload ?? cloneEmptyPayload()
      };
    });
    setDecisions(rejected);
    await submitReview(rejected, "已批量打回全部图片", "批量打回失败");
  }

  function renderSampleList(isFocusCompact = false) {
    return (
      <div
        className={`sample-list-window sample-list-window--review ${isFocusCompact ? "sample-list-window--focus-compact" : ""}`}
        ref={sampleListRef}
      >
        <div className="sample-current-meta" title={`${selectedFileName} / ${selectedFolderLabel}`}>
          {`当前样本：${selectedFileName} / 目录：${selectedFolderLabel} (${selectedIndex}/${totalCount})`}
        </div>
        {!isFocusCompact ? (
          <div className="sample-folder-filter" aria-label="目录筛选">
            <button
              type="button"
              className={`sample-folder-chip ${activeFolderPath === ALL_FOLDERS_KEY ? "is-active" : ""}`}
              onClick={() => setActiveFolderPath(ALL_FOLDERS_KEY)}
            >
              全部目录 ({totalSubmissionCount})
            </button>
            {folderGroups.map((group) => (
              <button
                key={group.folderPath || "__root__"}
                type="button"
                className={`sample-folder-chip ${activeFolderPath === group.folderPath ? "is-active" : ""}`}
                onClick={() => setActiveFolderPath(group.folderPath)}
                title={group.folderLabel}
              >
                {folderNameOf(group.folderPath)} ({group.entries.length})
              </button>
            ))}
          </div>
        ) : null}
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
                  <small>{group.entries.length} 张</small>
                </header>
                <div className="image-list image-list--line">
                  {group.entries.map((entry) => {
                    const decision = decisions[entry.task_image_id];
                    const boxText =
                      entry.submissionImage.payload.annotation_state === "no_object"
                        ? "无目标"
                        : `${entry.submissionImage.payload.boxes.length}框`;
                    return (
                      <button
                        key={entry.task_image_id}
                        type="button"
                        data-image-id={entry.task_image_id}
                        className={`image-list__item image-list__item--line review-list-row ${selected.task_image_id === entry.task_image_id ? "is-active" : ""}`}
                        onClick={() => setSelectedImageId(entry.task_image_id)}
                        title={`${entry.filePath} / ${boxText}`}
                      >
                        <span className="sample-line-index">{sampleIndexByImageId[entry.task_image_id] ?? "-"}</span>
                        <span className="sample-line-name">
                          {entry.fileName} / {boxText}
                        </span>
                        <span className={`badge ${decision?.decision === "failed" ? "badge-danger" : "badge-success"}`}>
                          {decision?.decision === "failed" ? "打回" : "通过"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className={`panel review-panel ${focusMode ? "is-focus-mode" : ""}`}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Review Queue</p>
          <h2>审核工作台</h2>
          <p className="review-submission-meta">{`标注者：${submitterName} / 提交时间：${submittedAtText}`}</p>
        </div>
        {reviewerMode ? (
          <div className="button-cluster">
            <button
              type="button"
              className={focusMode ? "primary-button" : "ghost-button"}
              onClick={() => setFocusMode((value) => !value)}
            >
              {focusMode ? "退出专注" : "专注评审"}
            </button>
            <button type="button" className="ghost-button" onClick={approveAll}>
              批量通过
            </button>
            <button type="button" className="decision-button danger" onClick={rejectAll}>
              批量打回
            </button>
            <button type="button" className="primary-button" onClick={complete}>
              完成审核
            </button>
          </div>
        ) : null}
      </div>

      <div className={`review-grid ${focusMode ? "is-focus-layout" : ""}`}>
        {!focusMode ? <aside className="review-sidebar">{renderSampleList()}</aside> : null}

        <div className="review-detail">
          <div className="review-preview">
            {previewUrl && selectedTaskImage ? (
              <AnnotationCanvas
                imageUrl={previewUrl}
                imageWidth={selectedTaskImage.width}
                imageHeight={selectedTaskImage.height}
                payload={selectedDecision.example_payload}
                backgroundPayload={selected.payload}
                backgroundLabel=""
                payloadBoxStyle="example"
                payloadLabelPrefix="示例标注"
                classes={task.classes}
                selectedClassId={selectedClassId}
                readOnly={!reviewerMode}
                zoom={zoom}
                showLabels={showLabels}
                showBoxes={showBoxes}
                onChange={(payload) => updateDecision(selected.task_image_id, { example_payload: payload })}
                onBoxDrawn={handleExampleBoxDrawn}
              />
            ) : (
              <div className="empty-state">预览加载中...</div>
            )}
          </div>

          <div className={`review-controls ${focusMode ? "is-focus-controls" : ""}`}>
            <div className={`review-controls-main ${focusMode ? "is-focus-main" : ""}`}>
              <div className="review-canvas-tools">
                <div className="button-cluster">
                  <button type="button" className="ghost-button" onClick={() => setShowLabels((value) => !value)}>
                    {showLabels ? "隐藏标签" : "显示标签"}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => setShowBoxes((value) => !value)}>
                    {showBoxes ? "隐藏框" : "显示框"}
                  </button>
                  <button type="button" className="ghost-button" onClick={() => setZoom(1)}>
                    缩放重置
                  </button>
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

              <div className="decision-row">
                <button
                  type="button"
                  className={`decision-button ${selectedDecision.decision === "passed" ? "is-active" : ""}`}
                  onClick={() => updateDecision(selected.task_image_id, { decision: "passed" })}
                  disabled={!reviewerMode}
                >
                  通过
                </button>
                <button
                  type="button"
                  className={`decision-button ${selectedDecision.decision === "failed" ? "is-active danger" : ""}`}
                  onClick={() => updateDecision(selected.task_image_id, { decision: "failed" })}
                  disabled={!reviewerMode}
                >
                  打回
                </button>
              </div>

              <div className="review-example-tools">
                {!focusMode ? (
                  <div>
                    <strong>评审示例标注</strong>
                    <small>示例框不会直接覆盖标注结果。打回时会把示例一起返回给标注员参考。</small>
                  </div>
                ) : null}
                <div className="class-list compact">
                  {task.classes.map((label) => (
                    <button
                      key={label.id}
                      type="button"
                      className={`class-chip ${selectedClassId === label.id ? "is-selected" : ""}`}
                      onClick={() => setSelectedClassId(label.id)}
                      style={{ borderColor: label.color }}
                      disabled={!reviewerMode}
                    >
                      <span className="class-chip__dot" style={{ backgroundColor: label.color }} />
                      {label.name}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => updateDecision(selected.task_image_id, { example_payload: cloneEmptyPayload() })}
                  disabled={!reviewerMode}
                >
                  清空示例标注
                </button>
              </div>

              <label className="review-comment-field">
                <span>当前图片原因</span>
                {focusMode ? (
                  <input
                    value={selectedDecision.comment}
                    onChange={(event) => updateDecision(selected.task_image_id, { comment: event.target.value })}
                    disabled={!reviewerMode}
                    placeholder="输入当前图片的审核意见"
                  />
                ) : (
                  <textarea
                    rows={4}
                    value={selectedDecision.comment}
                    onChange={(event) => updateDecision(selected.task_image_id, { comment: event.target.value })}
                    disabled={!reviewerMode}
                  />
                )}
              </label>

              <label className="review-overall-field">
                <span>总体审核意见</span>
                {focusMode ? (
                  <input
                    value={overallComment}
                    onChange={(event) => setOverallComment(event.target.value)}
                    disabled={!reviewerMode}
                    placeholder="输入整体审核意见"
                  />
                ) : (
                  <textarea
                    rows={4}
                    value={overallComment}
                    onChange={(event) => setOverallComment(event.target.value)}
                    disabled={!reviewerMode}
                  />
                )}
              </label>

              {message ? <p className="inline-message">{message}</p> : null}
            </div>

            {focusMode ? (
              <aside className="review-focus-samples">
                <p className="eyebrow">Samples</p>
                {renderSampleList(true)}
              </aside>
            ) : null}
          </div>
        </div>
      </div>

      {pendingClassBoxId && reviewerMode ? (
        <div className="class-assign-overlay" role="dialog" aria-modal="true">
          <div className="panel class-assign-dialog">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Class Assign</p>
                <h3>为示例框设置类别</h3>
              </div>
            </div>
            <p className="class-assign-tip">可直接点击已有类别，或输入类别名称后确认。</p>
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
              <div className="empty-state compact">当前没有可选类别，请输入新类别名称。</div>
            )}
            <form
              className="class-assign-form"
              onSubmit={(event) => {
                event.preventDefault();
                confirmPendingClass();
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
                  取消并删除示例框
                </button>
                <button type="submit" className="primary-button">
                  确认并应用
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
