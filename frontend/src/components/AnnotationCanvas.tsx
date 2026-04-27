import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { AnnotationBox, AnnotationPayload, LabelClass } from "../lib/api";

type InteractionState =
  | null
  | {
      mode: "draw" | "move" | "resize";
      index: number;
      handle?: "nw" | "ne" | "sw" | "se";
      startX: number;
      startY: number;
      origin: AnnotationBox;
    };

type PanState =
  | null
  | {
      startClientX: number;
      startClientY: number;
      startScrollLeft: number;
      startScrollTop: number;
    };

type Props = {
  imageUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  payload: AnnotationPayload;
  classes: LabelClass[];
  selectedClassId: string | null;
  readOnly?: boolean;
  zoom: number;
  showLabels: boolean;
  showBoxes: boolean;
  backgroundPayload?: AnnotationPayload | null;
  backgroundLabel?: string;
  payloadBoxStyle?: "solid" | "example";
  payloadLabelPrefix?: string;
  onChange: (payload: AnnotationPayload) => void;
  onBoxDrawn?: (boxId: string) => void;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeBox(box: AnnotationBox, imageWidth: number, imageHeight: number): AnnotationBox {
  const x1 = clamp(Math.min(box.x_min, box.x_max), 0, imageWidth);
  const y1 = clamp(Math.min(box.y_min, box.y_max), 0, imageHeight);
  const x2 = clamp(Math.max(box.x_min, box.x_max), 0, imageWidth);
  const y2 = clamp(Math.max(box.y_min, box.y_max), 0, imageHeight);
  return { ...box, x_min: x1, y_min: y1, x_max: x2, y_max: y2 };
}

function colorForBox(box: AnnotationBox, classes: LabelClass[]) {
  return box.color ?? classes.find((item) => item.id === box.class_id)?.color ?? "#ff7a18";
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
}

export function AnnotationCanvas({
  imageUrl,
  imageWidth,
  imageHeight,
  payload,
  classes,
  selectedClassId,
  readOnly = false,
  zoom,
  showLabels,
  showBoxes,
  backgroundPayload = null,
  backgroundLabel = "参考标注",
  payloadBoxStyle = "solid",
  payloadLabelPrefix = "",
  onChange,
  onBoxDrawn
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [interaction, setInteraction] = useState<InteractionState>(null);
  const [panState, setPanState] = useState<PanState>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const examplePayloadMode = payloadBoxStyle === "example";

  useEffect(() => {
    if (!wrapRef.current) {
      return;
    }
    const target = wrapRef.current;
    const updateViewport = () => {
      const rect = target.getBoundingClientRect();
      setViewportSize({
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height)
      });
    };
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(target);
    return () => observer.disconnect();
  }, [imageUrl, imageWidth, imageHeight]);

  const fitScale =
    imageWidth > 0 && imageHeight > 0 && viewportSize.width > 0 && viewportSize.height > 0
      ? Math.min(viewportSize.width / imageWidth, viewportSize.height / imageHeight)
      : 1;
  const stageScale = Math.max(0.01, fitScale * zoom);
  const panReady = spacePressed || readOnly;
  const topEdgeLabelThresholdPx = 32;

  function labelPlacementClass(box: AnnotationBox) {
    return box.y_min * stageScale < topEdgeLabelThresholdPx ? "canvas-box__label--inside" : "";
  }

  function beginPan(clientX: number, clientY: number) {
    if (!wrapRef.current) {
      return false;
    }
    setPanState({
      startClientX: clientX,
      startClientY: clientY,
      startScrollLeft: wrapRef.current.scrollLeft,
      startScrollTop: wrapRef.current.scrollTop
    });
    return true;
  }

  useEffect(() => {
    if (!panState) {
      return;
    }

    function handlePanMove(event: PointerEvent) {
      if (!wrapRef.current) {
        return;
      }
      const dx = event.clientX - panState.startClientX;
      const dy = event.clientY - panState.startClientY;
      wrapRef.current.scrollLeft = panState.startScrollLeft - dx;
      wrapRef.current.scrollTop = panState.startScrollTop - dy;
    }

    function handlePanEnd() {
      setPanState(null);
    }

    window.addEventListener("pointermove", handlePanMove);
    window.addEventListener("pointerup", handlePanEnd, { once: true });
    window.addEventListener("pointercancel", handlePanEnd, { once: true });
    return () => {
      window.removeEventListener("pointermove", handlePanMove);
      window.removeEventListener("pointerup", handlePanEnd);
      window.removeEventListener("pointercancel", handlePanEnd);
    };
  }, [panState]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.code !== "Space" || isTypingTarget(event.target)) {
        return;
      }
      setSpacePressed(true);
      event.preventDefault();
    }

    function handleKeyUp(event: KeyboardEvent) {
      if (event.code === "Space") {
        setSpacePressed(false);
      }
    }

    function clearSpaceState() {
      setSpacePressed(false);
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearSpaceState);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearSpaceState);
    };
  }, []);

  useEffect(() => {
    setSelectedIndex(null);
  }, [imageUrl]);

  useEffect(() => {
    if (!interaction) {
      return;
    }
    const activeInteraction = interaction;

    function getStagePoint(event: PointerEvent) {
      if (!stageRef.current) {
        return { x: 0, y: 0 };
      }
      const rect = stageRef.current.getBoundingClientRect();
      return {
        x: clamp((event.clientX - rect.left) / stageScale, 0, imageWidth),
        y: clamp((event.clientY - rect.top) / stageScale, 0, imageHeight)
      };
    }

    function handleMove(event: PointerEvent) {
      const point = getStagePoint(event);
      const boxes = payload.boxes.slice();
      const active = boxes[activeInteraction.index];
      if (!active) {
        return;
      }

      if (activeInteraction.mode === "draw") {
        boxes[activeInteraction.index] = normalizeBox(
          {
            ...active,
            x_max: point.x,
            y_max: point.y
          },
          imageWidth,
          imageHeight
        );
      }

      if (activeInteraction.mode === "move") {
        const dx = point.x - activeInteraction.startX;
        const dy = point.y - activeInteraction.startY;
        const width = activeInteraction.origin.x_max - activeInteraction.origin.x_min;
        const height = activeInteraction.origin.y_max - activeInteraction.origin.y_min;
        const nextX = clamp(activeInteraction.origin.x_min + dx, 0, imageWidth - width);
        const nextY = clamp(activeInteraction.origin.y_min + dy, 0, imageHeight - height);
        boxes[activeInteraction.index] = {
          ...activeInteraction.origin,
          x_min: nextX,
          y_min: nextY,
          x_max: nextX + width,
          y_max: nextY + height
        };
      }

      if (activeInteraction.mode === "resize") {
        const next = { ...activeInteraction.origin };
        if (activeInteraction.handle === "nw" || activeInteraction.handle === "sw") {
          next.x_min = point.x;
        }
        if (activeInteraction.handle === "ne" || activeInteraction.handle === "se") {
          next.x_max = point.x;
        }
        if (activeInteraction.handle === "nw" || activeInteraction.handle === "ne") {
          next.y_min = point.y;
        }
        if (activeInteraction.handle === "sw" || activeInteraction.handle === "se") {
          next.y_max = point.y;
        }
        boxes[activeInteraction.index] = normalizeBox(next, imageWidth, imageHeight);
      }

      onChange({
        ...payload,
        boxes,
        annotation_state: payload.is_no_object ? "no_object" : boxes.length ? "annotated" : "not_started"
      });
    }

    function handleUp() {
      const boxes = payload.boxes.slice();
      const active = boxes[activeInteraction.index];
      if (active) {
        const width = active.x_max - active.x_min;
        const height = active.y_max - active.y_min;
        if (width < 6 || height < 6) {
          boxes.splice(activeInteraction.index, 1);
          onChange({
            ...payload,
            boxes,
            annotation_state: payload.is_no_object ? "no_object" : boxes.length ? "annotated" : "not_started"
          });
        } else if (activeInteraction.mode === "draw" && active.id) {
          onBoxDrawn?.(active.id);
        }
      }
      setInteraction(null);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [imageHeight, imageWidth, interaction, onBoxDrawn, onChange, payload, stageScale]);

  function startDraw(event: ReactPointerEvent<HTMLDivElement>) {
    const shouldPan = event.button === 1 || (event.button === 0 && panReady);
    if (shouldPan) {
      event.preventDefault();
      beginPan(event.clientX, event.clientY);
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (readOnly || payload.is_no_object) {
      return;
    }
    if (!stageRef.current) {
      return;
    }
    const rect = stageRef.current.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / stageScale, 0, imageWidth);
    const y = clamp((event.clientY - rect.top) / stageScale, 0, imageHeight);
    const next: AnnotationBox = {
      id: `box-${Date.now()}`,
      x_min: x,
      y_min: y,
      x_max: x,
      y_max: y
    };
    const boxes = [...payload.boxes, next];
    const nextIndex = boxes.length - 1;
    setSelectedIndex(nextIndex);
    onChange({
      annotation_state: "annotated",
      is_no_object: false,
      boxes
    });
    setInteraction({
      mode: "draw",
      index: nextIndex,
      startX: x,
      startY: y,
      origin: next
    });
  }

  function startMove(event: ReactPointerEvent, index: number) {
    event.stopPropagation();
    const shouldPan = event.button === 1 || (event.button === 0 && panReady);
    if (shouldPan) {
      event.preventDefault();
      beginPan(event.clientX, event.clientY);
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (readOnly) {
      return;
    }
    if (!stageRef.current) {
      return;
    }
    const rect = stageRef.current.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / stageScale, 0, imageWidth);
    const y = clamp((event.clientY - rect.top) / stageScale, 0, imageHeight);
    setSelectedIndex(index);
    setInteraction({
      mode: "move",
      index,
      startX: x,
      startY: y,
      origin: { ...payload.boxes[index] }
    });
  }

  function startResize(event: ReactPointerEvent, index: number, handle: "nw" | "ne" | "sw" | "se") {
    event.stopPropagation();
    const shouldPan = event.button === 1 || (event.button === 0 && panReady);
    if (shouldPan) {
      event.preventDefault();
      beginPan(event.clientX, event.clientY);
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (readOnly) {
      return;
    }
    if (!stageRef.current) {
      return;
    }
    const rect = stageRef.current.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / stageScale, 0, imageWidth);
    const y = clamp((event.clientY - rect.top) / stageScale, 0, imageHeight);
    setSelectedIndex(index);
    setInteraction({
      mode: "resize",
      index,
      handle,
      startX: x,
      startY: y,
      origin: { ...payload.boxes[index] }
    });
  }

  function deleteSelected() {
    if (selectedIndex === null || readOnly) {
      return;
    }
    const boxes = payload.boxes.slice();
    boxes.splice(selectedIndex, 1);
    setSelectedIndex(null);
    onChange({
      annotation_state: boxes.length ? "annotated" : "not_started",
      is_no_object: false,
      boxes
    });
  }

  function updateSelectedClass(classId: string) {
    if (selectedIndex === null || readOnly) {
      return;
    }
    const label = classes.find((item) => item.id === classId);
    const boxes = payload.boxes.slice();
    const current = boxes[selectedIndex];
    if (!current) {
      return;
    }
    boxes[selectedIndex] = {
      ...current,
      class_id: label?.id,
      class_name: label?.name,
      color: label?.color
    };
    onChange({
      ...payload,
      boxes,
      annotation_state: payload.is_no_object ? "no_object" : boxes.length ? "annotated" : "not_started"
    });
  }

  const selectedBox = selectedIndex !== null ? payload.boxes[selectedIndex] : null;
  const selectedBoxClassId =
    selectedBox?.class_id && classes.some((item) => item.id === selectedBox.class_id) ? selectedBox.class_id : "";

  useEffect(() => {
    function onKeydown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedIndex !== null) {
        event.preventDefault();
        deleteSelected();
      }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  });

  return (
    <div className="canvas-shell">
      <div className="canvas-toolbar">
        <div className="canvas-toolbar__summary">
          <span>{payload.is_no_object ? "当前图片已标记为无目标" : `框数量 ${payload.boxes.length}`}</span>
          <span>
            {readOnly
              ? "只读模式"
              : selectedClassId
                ? `当前类别 ${classes.find((item) => item.id === selectedClassId)?.name ?? "未选中"}`
                : "未预选类别，画框后将自动弹窗补充类别"}
          </span>
        </div>
        <div className="canvas-toolbar__controls">
          <label className="canvas-class-picker">
            <span>选中框类别</span>
            <select
              value={selectedBoxClassId}
              onChange={(event) => updateSelectedClass(event.target.value)}
              disabled={readOnly || selectedIndex === null || !classes.length}
            >
              <option value="">未分类</option>
              {classes.map((label) => (
                <option key={label.id} value={label.id}>
                  {label.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost-button"
            type="button"
            onClick={() => updateSelectedClass(selectedClassId ?? "")}
            disabled={readOnly || selectedIndex === null || !selectedClassId}
          >
            套用当前类别
          </button>
          <button className="ghost-button" type="button" onClick={deleteSelected} disabled={selectedIndex === null || readOnly}>
            删除选中框
          </button>
        </div>
      </div>

      <div ref={wrapRef} className={`canvas-stage-wrap ${panReady ? "is-pan-ready" : ""} ${panState ? "is-panning" : ""}`}>
        <div
          ref={stageRef}
          className={`canvas-stage ${readOnly ? "is-readonly" : ""}`}
          style={{ width: imageWidth * stageScale, height: imageHeight * stageScale }}
          onPointerDown={startDraw}
        >
          {imageUrl ? <img className="canvas-stage__image" src={imageUrl} alt="task asset" draggable={false} /> : null}

          {showBoxes
            ? backgroundPayload?.boxes.map((box, index) => {
                const color = colorForBox(box, classes);
                const backgroundClassText = box.class_name ?? "未分类";
                const backgroundLabelText = backgroundLabel ? `${backgroundLabel} / ${backgroundClassText}` : backgroundClassText;
                return (
                  <div
                    key={`background-${box.id ?? `${index}-${box.x_min}-${box.y_min}`}`}
                    className="canvas-box canvas-box--reference"
                    style={{
                      left: box.x_min * stageScale,
                      top: box.y_min * stageScale,
                      width: (box.x_max - box.x_min) * stageScale,
                      height: (box.y_max - box.y_min) * stageScale,
                      borderColor: color
                    }}
                  >
                    {showLabels ? (
                      <div
                        className={["canvas-box__label", "canvas-box__label--reference", labelPlacementClass(box)]
                          .filter(Boolean)
                          .join(" ")}
                        style={{ backgroundColor: color }}
                      >
                        {backgroundLabelText}
                      </div>
                    ) : null}
                  </div>
                );
              })
            : null}

          {backgroundPayload?.is_no_object ? (
            <div className="canvas-reference-note">{backgroundLabel ? `${backgroundLabel}：无目标` : "无目标"}</div>
          ) : null}

          {showBoxes
            ? payload.boxes.map((box, index) => {
                const isSelected = selectedIndex === index;
                const color = colorForBox(box, classes);
                const payloadClassText = box.class_name ?? "";
                const payloadLabelText = payloadLabelPrefix
                  ? payloadClassText
                    ? `${payloadLabelPrefix} / ${payloadClassText}`
                    : payloadLabelPrefix
                  : payloadClassText || "待设置类别";
                return (
                  <div
                    key={box.id ?? `${index}-${box.x_min}-${box.y_min}`}
                    className={`canvas-box ${examplePayloadMode ? "canvas-box--example" : ""} ${isSelected ? "is-selected" : ""}`}
                    style={{
                      left: box.x_min * stageScale,
                      top: box.y_min * stageScale,
                      width: (box.x_max - box.x_min) * stageScale,
                      height: (box.y_max - box.y_min) * stageScale,
                      borderColor: color
                    }}
                    onPointerDown={(event) => startMove(event, index)}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedIndex(index);
                    }}
                  >
                    {showLabels ? (
                      <div
                        className={["canvas-box__label", examplePayloadMode ? "canvas-box__label--example" : "", labelPlacementClass(box)]
                          .filter(Boolean)
                          .join(" ")}
                        style={{ backgroundColor: color }}
                      >
                        {payloadLabelText}
                      </div>
                    ) : null}
                    {!readOnly && isSelected ? (
                      <>
                        <button className="canvas-handle handle-nw" type="button" onPointerDown={(event) => startResize(event, index, "nw")} />
                        <button className="canvas-handle handle-ne" type="button" onPointerDown={(event) => startResize(event, index, "ne")} />
                        <button className="canvas-handle handle-sw" type="button" onPointerDown={(event) => startResize(event, index, "sw")} />
                        <button className="canvas-handle handle-se" type="button" onPointerDown={(event) => startResize(event, index, "se")} />
                      </>
                    ) : null}
                  </div>
                );
              })
            : null}

          {payload.is_no_object ? <div className="canvas-no-object">NO OBJECT</div> : null}
        </div>
      </div>
    </div>
  );
}
