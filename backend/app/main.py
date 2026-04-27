from __future__ import annotations

import hashlib
import json
import mimetypes
import struct
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import HTTPException as FastAPIHTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import and_, func, inspect, or_, select, text
from sqlalchemy.orm import Session

from .bootstrap import seed_users
from .config import settings
from .database import Base, SessionLocal, engine, get_db
from .models import (
    AnnotationTask,
    AuditLog,
    EffectiveAnnotation,
    ImageReviewDetail,
    LabelClass,
    ReviewRecord,
    SourceImage,
    Submission,
    SubmissionImageSnapshot,
    TaskImage,
    TaskReviewer,
    User,
    UserRole,
    WorkingAnnotation,
)
from .schemas import (
    ExportRequest,
    LabelClassInput,
    LoginRequest,
    ReviewCompleteRequest,
    TaskCreateRequest,
    TaskPatchRequest,
    UserCreateRequest,
    UserPatchRequest,
    WorkingAnnotationRequest,
)
from .security import create_access_token, decode_access_token, hash_password, verify_password


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def error_response(code: str, message: str, details: dict[str, Any] | None = None, status_code: int = 400) -> None:
    raise HTTPException(status_code=status_code, detail={"code": code, "message": message, "details": details or {}})


def annotation_payload_default() -> dict[str, Any]:
    return {"annotation_state": "not_started", "is_no_object": False, "boxes": []}


def normalize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    boxes = payload.get("boxes") or []
    is_no_object = bool(payload.get("is_no_object", False))
    annotation_state = payload.get("annotation_state", "annotated" if boxes else "not_started")

    if is_no_object and boxes:
        error_response(
            "INVALID_EMPTY_ANNOTATION",
            "无目标标注不能同时包含检测框",
            status_code=400,
        )

    if is_no_object:
        annotation_state = "no_object"
    elif boxes:
        annotation_state = "annotated"
    else:
        annotation_state = "not_started"

    normalized_boxes = []
    for box in boxes:
        normalized_boxes.append(
            {
                "id": box.get("id"),
                "class_id": box.get("class_id"),
                "class_name": box.get("class_name"),
                "color": box.get("color"),
                "x_min": float(box.get("x_min", 0)),
                "y_min": float(box.get("y_min", 0)),
                "x_max": float(box.get("x_max", 0)),
                "y_max": float(box.get("y_max", 0)),
            }
        )
    return {
        "annotation_state": annotation_state,
        "is_no_object": annotation_state == "no_object",
        "boxes": normalized_boxes,
    }


def summarize_payload(payload: dict[str, Any]) -> str:
    return f"{payload.get('annotation_state', 'not_started')}:{len(payload.get('boxes', []))}"


def ensure_runtime_schema() -> None:
    inspector = inspect(engine)
    if inspector.has_table("image_review_details"):
        detail_columns = {column["name"] for column in inspector.get_columns("image_review_details")}
        if "example_payload_json" not in detail_columns:
            with engine.begin() as connection:
                connection.execute(text("ALTER TABLE image_review_details ADD COLUMN example_payload_json JSON"))

    if inspector.has_table("annotation_tasks"):
        task_columns = {column["name"] for column in inspector.get_columns("annotation_tasks")}
        if "deleted_at" not in task_columns:
            deleted_at_type = "TIMESTAMPTZ" if engine.dialect.name.startswith("postgres") else "DATETIME"
            with engine.begin() as connection:
                connection.execute(text(f"ALTER TABLE annotation_tasks ADD COLUMN deleted_at {deleted_at_type}"))


def audit(
    db: Session,
    actor_user_id: str | None,
    action_type: str,
    target_type: str,
    target_id: str | None,
    summary: str,
    before_json: dict[str, Any] | None = None,
    after_json: dict[str, Any] | None = None,
) -> None:
    db.add(
        AuditLog(
            actor_user_id=actor_user_id,
            action_type=action_type,
            target_type=target_type,
            target_id=target_id,
            result="success",
            summary=summary,
            before_json=before_json,
            after_json=after_json,
            timestamp=utcnow(),
        )
    )


def user_roles(user: User, db: Session) -> set[str]:
    return {
        role
        for role in db.scalars(select(UserRole.role).where(UserRole.user_id == user.id)).all()
    }


def serialize_user(user: User, db: Session) -> dict[str, Any]:
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "is_active": user.is_active,
        "roles": sorted(user_roles(user, db)),
    }


def serialize_submission_actor(user: User | None, fallback_id: str) -> dict[str, Any]:
    if not user:
        return {"id": fallback_id, "username": None, "display_name": None}
    return {"id": user.id, "username": user.username, "display_name": user.display_name}


def serialize_task_actor(user_id: str | None, db: Session) -> dict[str, Any] | None:
    if not user_id:
        return None
    user = db.get(User, user_id)
    if user:
        return serialize_submission_actor(user, user_id)

    delete_audit = db.scalar(
        select(AuditLog)
        .where(
            AuditLog.action_type == "USER_DELETE",
            AuditLog.target_id == user_id,
        )
        .order_by(AuditLog.timestamp.desc())
    )
    before_json = delete_audit.before_json if delete_audit and isinstance(delete_audit.before_json, dict) else {}
    username = before_json.get("username")
    display_name = before_json.get("display_name")
    return {
        "id": user_id,
        "username": str(username).strip() if isinstance(username, str) and username.strip() else None,
        "display_name": str(display_name).strip() if isinstance(display_name, str) and display_name.strip() else None,
    }


def user_activity_references(user_id: str, db: Session) -> dict[str, int]:
    references = {
        "tasks_created": db.scalar(select(func.count(AnnotationTask.id)).where(AnnotationTask.created_by == user_id)) or 0,
        "tasks_assigned": db.scalar(select(func.count(AnnotationTask.id)).where(AnnotationTask.assignee_user_id == user_id)) or 0,
        "task_reviews": db.scalar(select(func.count(TaskReviewer.id)).where(TaskReviewer.reviewer_user_id == user_id)) or 0,
        "working_updates": db.scalar(select(func.count(WorkingAnnotation.id)).where(WorkingAnnotation.updated_by == user_id)) or 0,
        "submissions": db.scalar(select(func.count(Submission.id)).where(Submission.submitter_id == user_id)) or 0,
        "review_records": db.scalar(select(func.count(ReviewRecord.id)).where(ReviewRecord.reviewer_id == user_id)) or 0,
    }
    return {key: value for key, value in references.items() if value > 0}


def current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if not authorization or not authorization.lower().startswith("bearer "):
        error_response("UNAUTHORIZED", "缺少访问令牌", status_code=401)
    token = authorization.split(" ", 1)[1]
    payload = decode_access_token(token)
    if not payload:
        error_response("UNAUTHORIZED", "访问令牌无效或已过期", status_code=401)
    user = db.get(User, payload.get("sub"))
    if not user or not user.is_active:
        error_response("UNAUTHORIZED", "用户不存在或已禁用", status_code=401)
    return user


def require_role(user: User, db: Session, *roles: str) -> set[str]:
    owned_roles = user_roles(user, db)
    if not any(role in owned_roles for role in roles):
        error_response("FORBIDDEN", "当前用户角色无权执行此操作", status_code=403)
    return owned_roles


def primary_reviewer_id(task_id: str, db: Session) -> str | None:
    reviewer = db.scalar(
        select(TaskReviewer.reviewer_user_id).where(
            TaskReviewer.task_id == task_id,
            TaskReviewer.is_primary.is_(True),
        )
    )
    return reviewer


def get_task_or_404(task_id: str, db: Session) -> AnnotationTask:
    task = db.scalar(
        select(AnnotationTask).where(
            AnnotationTask.id == task_id,
            AnnotationTask.deleted_at.is_(None),
        )
    )
    if not task:
        error_response("NOT_FOUND", "任务不存在", status_code=404)
    return task


def user_can_view_task(user: User, task: AnnotationTask, db: Session) -> bool:
    roles = user_roles(user, db)
    if "admin" in roles:
        return True
    if task.created_by == user.id:
        return True
    if task.assignee_user_id == user.id:
        return True
    return primary_reviewer_id(task.id, db) == user.id


def user_can_manage_task(user: User, task: AnnotationTask, db: Session) -> bool:
    roles = user_roles(user, db)
    return "admin" in roles or task.created_by == user.id


def ensure_task_visible(user: User, task: AnnotationTask, db: Session) -> None:
    if not user_can_view_task(user, task, db):
        error_response("NOT_FOUND", "任务不存在", status_code=404)


def ensure_task_editable(user: User, task: AnnotationTask, db: Session) -> None:
    if task.assignee_user_id != user.id:
        error_response(
            "FORBIDDEN_NOT_ASSIGNEE",
            "只有任务标注责任人可保存该图像标注",
            {"task_id": task.id, "required_user_id": task.assignee_user_id},
            status_code=403,
        )
    pending = db.scalar(
        select(Submission.id).where(
            Submission.task_id == task.id,
            Submission.status == "pending_review",
        )
    )
    if pending:
        error_response("TASK_IN_REVIEW", "当前任务存在待审核提交，工作副本已锁定", status_code=409)


def ensure_primary_reviewer(user: User, task: AnnotationTask, db: Session) -> None:
    reviewer_id = primary_reviewer_id(task.id, db)
    if reviewer_id != user.id:
        error_response("FORBIDDEN_NOT_REVIEWER", "只有主审核员可以完成审核", status_code=403)


def ensure_no_pending_submission(task_id: str, db: Session) -> None:
    pending = db.scalar(
        select(Submission.id).where(
            Submission.task_id == task_id,
            Submission.status == "pending_review",
        )
    )
    if pending:
        error_response("TASK_IN_REVIEW", "任务当前存在待审核提交", status_code=409)


def safe_join_storage(root_name: str, relative_path: str = "") -> Path:
    if root_name != settings.storage_root_name:
        error_response("NOT_FOUND", "存储根不存在", status_code=404)
    root_path = settings.storage_root_path.resolve()
    candidate = (root_path / relative_path).resolve()
    if not candidate.is_relative_to(root_path):
        error_response("FORBIDDEN", "非法路径访问", status_code=403)
    return candidate


STORAGE_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".svg"}
SOURCE_IMAGE_LOCK_STATUSES = {"draft", "in_progress", "submitted", "in_review", "rejected"}


def image_dimensions_for(path: Path) -> tuple[int, int]:
    suffix = path.suffix.lower()
    if suffix == ".svg":
        text = path.read_text(encoding="utf-8")
        width = 1280
        height = 720
        for key in ("width", "height"):
            marker = f'{key}="'
            if marker in text:
                segment = text.split(marker, 1)[1].split('"', 1)[0]
                value = "".join(ch for ch in segment if ch.isdigit())
                if value:
                    if key == "width":
                        width = int(value)
                    else:
                        height = int(value)
        return width, height

    with path.open("rb") as handle:
        header = handle.read(64)
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        width, height = struct.unpack(">II", header[16:24])
        return int(width), int(height)
    if header[:2] == b"BM":
        width, height = struct.unpack("<II", header[18:26])
        return int(width), int(height)
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return 1280, 720
    if header[:2] == b"\xff\xd8":
        with path.open("rb") as handle:
            handle.read(2)
            while True:
                marker, = struct.unpack("B", handle.read(1))
                while marker != 0xFF:
                    marker, = struct.unpack("B", handle.read(1))
                code, = struct.unpack("B", handle.read(1))
                while code == 0xFF:
                    code, = struct.unpack("B", handle.read(1))
                if code in {0xC0, 0xC2}:
                    _size = struct.unpack(">H", handle.read(2))[0]
                    handle.read(1)
                    height, width = struct.unpack(">HH", handle.read(4))
                    return int(width), int(height)
                if code in {0xD8, 0xD9}:
                    continue
                size = struct.unpack(">H", handle.read(2))[0]
                handle.seek(size - 2, 1)
    return 1280, 720


def serialize_storage_file(path: Path) -> dict[str, Any]:
    width, height = image_dimensions_for(path)
    return {
        "name": path.name,
        "path": path.relative_to(settings.storage_root_path).as_posix(),
        "width": width,
        "height": height,
    }


def file_hash_for(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clamp_int(value: float, lower: int, upper: int) -> int:
    if upper < lower:
        return lower
    return max(lower, min(upper, int(round(value))))


def build_pascal_voc_xml(
    image: TaskImage,
    payload: dict[str, Any],
    source_file: Path,
    label_name_by_id: dict[str, str],
) -> str:
    root = ET.Element("annotation")
    ET.SubElement(root, "folder").text = source_file.parent.name
    ET.SubElement(root, "filename").text = source_file.name
    ET.SubElement(root, "path").text = str(source_file)

    source = ET.SubElement(root, "source")
    ET.SubElement(source, "database").text = "LabelWe"

    size = ET.SubElement(root, "size")
    ET.SubElement(size, "width").text = str(image.width)
    ET.SubElement(size, "height").text = str(image.height)
    ET.SubElement(size, "depth").text = "3"
    ET.SubElement(root, "segmented").text = "0"

    max_x = max(0, image.width - 1)
    max_y = max(0, image.height - 1)
    boxes = payload.get("boxes") or []
    for box in boxes:
        class_id = str(box.get("class_id") or "")
        class_name = str(box.get("class_name") or label_name_by_id.get(class_id) or "object")
        x_min = clamp_int(float(box.get("x_min", 0)), 0, max_x)
        y_min = clamp_int(float(box.get("y_min", 0)), 0, max_y)
        x_max = clamp_int(float(box.get("x_max", 0)), 0, max_x)
        y_max = clamp_int(float(box.get("y_max", 0)), 0, max_y)
        if x_max < x_min:
            x_min, x_max = x_max, x_min
        if y_max < y_min:
            y_min, y_max = y_max, y_min

        node = ET.SubElement(root, "object")
        ET.SubElement(node, "name").text = class_name
        ET.SubElement(node, "pose").text = "Unspecified"
        ET.SubElement(node, "truncated").text = "0"
        ET.SubElement(node, "difficult").text = "0"
        bnd = ET.SubElement(node, "bndbox")
        ET.SubElement(bnd, "xmin").text = str(x_min)
        ET.SubElement(bnd, "ymin").text = str(y_min)
        ET.SubElement(bnd, "xmax").text = str(x_max)
        ET.SubElement(bnd, "ymax").text = str(y_max)

    tree = ET.ElementTree(root)
    if hasattr(ET, "indent"):
        ET.indent(tree, space="  ")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True).decode("utf-8")


def normalize_label_name(name: str) -> str:
    return " ".join(name.strip().lower().split())


def task_label_lookup_by_name(task_id: str, db: Session) -> dict[str, LabelClass]:
    labels = db.scalars(
        select(LabelClass)
        .where(LabelClass.task_id == task_id, LabelClass.deleted_at.is_(None))
        .order_by(LabelClass.sort_order, LabelClass.created_at)
    ).all()
    lookup: dict[str, LabelClass] = {}
    for label in labels:
        key = normalize_label_name(label.name)
        if key:
            lookup[key] = label
    return lookup


def parse_sidecar_xml_payload(
    task: AnnotationTask,
    image: TaskImage,
    label_by_name: dict[str, LabelClass],
) -> dict[str, Any] | None:
    source_file = safe_join_storage(task.storage_root_ref, image.file_path)
    xml_file = source_file.with_suffix(".xml")
    if not xml_file.exists():
        return None

    try:
        root = ET.parse(xml_file).getroot()
    except (ET.ParseError, OSError) as exc:
        error_response(
            "PREANNOTATION_XML_INVALID",
            f"预标注 XML 解析失败：{xml_file.relative_to(settings.storage_root_path).as_posix()}",
            {"error": str(exc)},
            status_code=400,
        )

    max_x = max(0, image.width - 1)
    max_y = max(0, image.height - 1)
    boxes: list[dict[str, Any]] = []
    for index, node in enumerate(root.findall("object"), start=1):
        bnd = node.find("bndbox")
        if bnd is None:
            continue

        raw_name = (node.findtext("name") or "").strip()
        class_name = raw_name or "object"
        class_key = normalize_label_name(class_name)
        matched_label = label_by_name.get(class_key)

        def bnd_float(tag: str) -> float:
            text = (bnd.findtext(tag) or "").strip()
            if not text:
                raise ValueError(tag)
            return float(text)

        try:
            x_min = clamp_int(bnd_float("xmin"), 0, max_x)
            y_min = clamp_int(bnd_float("ymin"), 0, max_y)
            x_max = clamp_int(bnd_float("xmax"), 0, max_x)
            y_max = clamp_int(bnd_float("ymax"), 0, max_y)
        except ValueError:
            continue

        if x_max < x_min:
            x_min, x_max = x_max, x_min
        if y_max < y_min:
            y_min, y_max = y_max, y_min
        if x_max == x_min or y_max == y_min:
            continue

        boxes.append(
            {
                "id": f"xml-{index}",
                "class_id": str(matched_label.id) if matched_label else None,
                "class_name": matched_label.name if matched_label else class_name,
                "color": matched_label.color if matched_label else None,
                "x_min": x_min,
                "y_min": y_min,
                "x_max": x_max,
                "y_max": y_max,
            }
        )

    if not boxes:
        return None

    return normalize_payload(
        {
            "annotation_state": "annotated",
            "is_no_object": False,
            "boxes": boxes,
        }
    )


def seed_working_annotation_from_sidecar(
    task: AnnotationTask,
    image: TaskImage,
    actor_user_id: str,
    label_by_name: dict[str, LabelClass],
    db: Session,
) -> bool:
    payload = parse_sidecar_xml_payload(task, image, label_by_name)
    if not payload:
        return False

    existing = db.scalar(select(WorkingAnnotation).where(WorkingAnnotation.task_image_id == image.id))
    if existing:
        existing.payload_json = payload
        existing.version += 1
        existing.updated_by = actor_user_id
        existing.updated_at = utcnow()
    else:
        db.add(
            WorkingAnnotation(
                task_image_id=image.id,
                payload_json=payload,
                version=1,
                updated_by=actor_user_id,
                updated_at=utcnow(),
            )
        )

    image.per_image_status = {
        "not_started": "not_started",
        "annotated": "in_progress",
        "no_object": "no_object_marked",
    }[payload["annotation_state"]]
    return True


def ensure_submission_boxes_classified(task: AnnotationTask, snapshots_by_image_id: dict[str, dict[str, Any]], db: Session) -> None:
    labels = db.scalars(
        select(LabelClass.id).where(LabelClass.task_id == task.id, LabelClass.deleted_at.is_(None))
    ).all()
    label_ids = {str(item) for item in labels}

    unclassified_total = 0
    affected_images: list[str] = []
    for task_image_id, payload in snapshots_by_image_id.items():
        boxes = payload.get("boxes") or []
        missing_count = 0
        for box in boxes:
            class_id = str(box.get("class_id") or "").strip()
            class_name = str(box.get("class_name") or "").strip()
            if class_id and class_id in label_ids:
                continue
            if class_name:
                continue
            missing_count += 1
        if missing_count:
            unclassified_total += missing_count
            affected_images.append(task_image_id)

    if unclassified_total:
        error_response(
            "UNCLASSIFIED_BOXES",
            "存在未分类的标注框，请先补全类别后再提交审核",
            {
                "unclassified_box_count": unclassified_total,
                "affected_image_ids": affected_images,
            },
            status_code=400,
        )


def write_submission_xml_files(
    task: AnnotationTask,
    images: list[TaskImage],
    snapshots_by_image_id: dict[str, dict[str, Any]],
    db: Session,
) -> list[str]:
    labels = db.scalars(
        select(LabelClass)
        .where(LabelClass.task_id == task.id, LabelClass.deleted_at.is_(None))
        .order_by(LabelClass.sort_order, LabelClass.created_at)
    ).all()
    label_name_by_id = {str(label.id): label.name for label in labels}
    written_files: list[str] = []

    for image in images:
        source_file = safe_join_storage(task.storage_root_ref, image.file_path)
        xml_file = source_file.with_suffix(".xml")
        payload = snapshots_by_image_id.get(image.id) or annotation_payload_default()
        xml_content = build_pascal_voc_xml(image, payload, source_file, label_name_by_id)
        xml_file.write_text(xml_content, encoding="utf-8")
        written_files.append(xml_file.relative_to(settings.storage_root_path).as_posix())

    return written_files


def get_or_create_source_image(root_name: str, relative_path: str, db: Session) -> SourceImage:
    canonical_path = relative_path.replace("\\", "/")
    existing = db.scalar(
        select(SourceImage).where(
            SourceImage.storage_root_ref == root_name,
            SourceImage.canonical_path == canonical_path,
        )
    )
    full_path = safe_join_storage(root_name, canonical_path)
    file_hash = file_hash_for(full_path)
    width, height = image_dimensions_for(full_path)

    if existing:
        existing.file_hash = file_hash
        existing.width = width
        existing.height = height
        existing.exif_orientation = 1
        return existing

    source = SourceImage(
        storage_root_ref=root_name,
        canonical_path=canonical_path,
        file_hash=file_hash,
        width=width,
        height=height,
        exif_orientation=1,
    )
    db.add(source)
    db.flush()
    return source


def ensure_sources_not_in_open_tasks(sources: list[SourceImage], db: Session) -> None:
    seen: set[str] = set()
    duplicates: list[str] = []
    for source in sources:
        if source.id in seen:
            duplicates.append(source.canonical_path)
        seen.add(source.id)
    if duplicates:
        error_response(
            "DUPLICATE_TASK_IMAGE",
            f"同一任务中不能重复选择同一图片：{', '.join(duplicates[:5])}",
            {"paths": duplicates},
            status_code=400,
        )

    source_ids = [source.id for source in sources]
    if not source_ids:
        return

    conflicts = db.execute(
        select(TaskImage, AnnotationTask)
        .join(AnnotationTask, TaskImage.task_id == AnnotationTask.id)
        .where(
            TaskImage.source_image_id.in_(source_ids),
            AnnotationTask.deleted_at.is_(None),
            AnnotationTask.status.in_(SOURCE_IMAGE_LOCK_STATUSES),
        )
    ).all()
    if not conflicts:
        return

    details = [
        {
            "path": task_image.file_path,
            "task_id": task.id,
            "task_title": task.title,
            "task_status": task.status,
            "assignee_user_id": task.assignee_user_id,
        }
        for task_image, task in conflicts
    ]
    preview = "、".join(item["path"] for item in details[:5])
    error_response(
        "SOURCE_IMAGE_ALREADY_ASSIGNED",
        f"图片已被未完成任务占用，不能重复分发：{preview}",
        {"conflicts": details},
        status_code=409,
    )


def serialize_task(task: AnnotationTask, db: Session) -> dict[str, Any]:
    images = db.scalars(
        select(TaskImage).where(TaskImage.task_id == task.id).order_by(TaskImage.sort_order, TaskImage.created_at)
    ).all()
    completed = sum(1 for image in images if image.per_image_status in {"approved", "no_object_approved"})
    rejected = sum(1 for image in images if image.per_image_status == "changes_requested")
    reviewer_id = primary_reviewer_id(task.id, db)
    return {
        "id": task.id,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "assignee_user_id": task.assignee_user_id,
        "assignee_user": serialize_task_actor(task.assignee_user_id, db),
        "created_by": task.created_by,
        "created_by_user": serialize_task_actor(task.created_by, db),
        "storage_root_ref": task.storage_root_ref,
        "due_at": task.due_at.isoformat() if task.due_at else None,
        "priority": task.priority,
        "reviewer_user_id": reviewer_id,
        "reviewer_user": serialize_task_actor(reviewer_id, db),
        "image_count": len(images),
        "completed_count": completed,
        "changes_requested_count": rejected,
    }


def serialize_task_image(image: TaskImage, db: Session) -> dict[str, Any]:
    working = db.scalar(select(WorkingAnnotation).where(WorkingAnnotation.task_image_id == image.id))
    effective = db.scalar(
        select(EffectiveAnnotation)
        .where(EffectiveAnnotation.task_image_id == image.id, EffectiveAnnotation.superseded_at.is_(None))
        .order_by(EffectiveAnnotation.created_at.desc())
    )
    latest_review = db.scalar(
        select(ImageReviewDetail)
        .join(ReviewRecord, ImageReviewDetail.review_record_id == ReviewRecord.id)
        .join(Submission, ReviewRecord.submission_id == Submission.id)
        .where(ImageReviewDetail.task_image_id == image.id)
        .order_by(ReviewRecord.created_at.desc())
    )
    payload = working.payload_json if working else annotation_payload_default()
    return {
        "id": image.id,
        "file_path": image.file_path,
        "width": image.width,
        "height": image.height,
        "per_image_status": image.per_image_status,
        "working_version": working.version if working else 0,
        "annotation_state": payload.get("annotation_state", "not_started"),
        "boxes_count": len(payload.get("boxes", [])),
        "is_no_object": payload.get("is_no_object", False),
        "effective_annotation_state": (effective.payload_json if effective else annotation_payload_default()).get(
            "annotation_state"
        ),
        "review_comment": latest_review.comment if latest_review else None,
        "review_example_payload": latest_review.example_payload_json if latest_review else None,
    }


def recompute_task_status(task: AnnotationTask, db: Session) -> None:
    pending = db.scalar(
        select(Submission.id).where(Submission.task_id == task.id, Submission.status == "pending_review")
    )
    if pending:
        task.status = "in_review"
        return
    images = db.scalars(select(TaskImage).where(TaskImage.task_id == task.id)).all()
    if images and all(image.per_image_status in {"approved", "no_object_approved"} for image in images):
        task.status = "approved"
    elif any(image.per_image_status == "changes_requested" for image in images):
        task.status = "rejected"
    else:
        task.status = "in_progress"


def active_effective_payload(task_image_id: str, db: Session) -> dict[str, Any] | None:
    effective = db.scalar(
        select(EffectiveAnnotation)
        .where(EffectiveAnnotation.task_image_id == task_image_id, EffectiveAnnotation.superseded_at.is_(None))
        .order_by(EffectiveAnnotation.created_at.desc())
    )
    return effective.payload_json if effective else None


def delete_task_graph(task: AnnotationTask, db: Session) -> None:
    """Remove a task and its workflow records, while keeping source images reusable."""
    task_image_ids = db.scalars(select(TaskImage.id).where(TaskImage.task_id == task.id)).all()
    submission_ids = db.scalars(select(Submission.id).where(Submission.task_id == task.id)).all()
    review_record_ids = (
        db.scalars(select(ReviewRecord.id).where(ReviewRecord.submission_id.in_(submission_ids))).all()
        if submission_ids
        else []
    )

    review_detail_filters = []
    if review_record_ids:
        review_detail_filters.append(ImageReviewDetail.review_record_id.in_(review_record_ids))
    if task_image_ids:
        review_detail_filters.append(ImageReviewDetail.task_image_id.in_(task_image_ids))
    if review_detail_filters:
        db.query(ImageReviewDetail).filter(or_(*review_detail_filters)).delete(synchronize_session=False)

    if review_record_ids:
        db.query(ReviewRecord).filter(ReviewRecord.id.in_(review_record_ids)).delete(synchronize_session=False)

    if task_image_ids:
        db.query(EffectiveAnnotation).filter(EffectiveAnnotation.task_image_id.in_(task_image_ids)).delete(
            synchronize_session=False
        )
        db.query(SubmissionImageSnapshot).filter(SubmissionImageSnapshot.task_image_id.in_(task_image_ids)).delete(
            synchronize_session=False
        )
        db.query(WorkingAnnotation).filter(WorkingAnnotation.task_image_id.in_(task_image_ids)).delete(
            synchronize_session=False
        )

    if submission_ids:
        db.query(EffectiveAnnotation).filter(EffectiveAnnotation.submission_id.in_(submission_ids)).delete(
            synchronize_session=False
        )
        db.query(SubmissionImageSnapshot).filter(SubmissionImageSnapshot.submission_id.in_(submission_ids)).delete(
            synchronize_session=False
        )
        db.query(Submission).filter(Submission.id.in_(submission_ids)).delete(synchronize_session=False)

    db.query(LabelClass).filter(LabelClass.task_id == task.id).delete(synchronize_session=False)
    db.query(TaskReviewer).filter(TaskReviewer.task_id == task.id).delete(synchronize_session=False)
    db.query(TaskImage).filter(TaskImage.task_id == task.id).delete(synchronize_session=False)
    db.delete(task)


def app_factory() -> FastAPI:
    app = FastAPI(title=settings.app_name, version="1.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        request.state.request_id = hashlib.sha1(str(utcnow().timestamp()).encode("utf-8")).hexdigest()[:12]
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    @app.exception_handler(FastAPIHTTPException)
    async def http_exception_handler(request: Request, exc: FastAPIHTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "ERROR", "message": str(exc.detail), "details": {}}
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": detail, "request_id": getattr(request.state, "request_id", None)},
        )

    @app.on_event("startup")
    def on_startup():
        Base.metadata.create_all(bind=engine)
        ensure_runtime_schema()
        with SessionLocal() as db:
            seed_users(db)

    @app.get("/")
    def root():
        return {"name": settings.app_name, "status": "ok"}

    @app.post(f"{settings.api_prefix}/auth/login")
    def login(payload: LoginRequest, db: Session = Depends(get_db)):
        user = db.scalar(select(User).where(User.username == payload.username))
        if not user or not verify_password(payload.password, user.password_hash):
            error_response("UNAUTHORIZED", "用户名或密码错误", status_code=401)
        token = create_access_token({"sub": user.id, "username": user.username})
        audit(db, user.id, "AUTH_LOGIN", "user", user.id, f"{user.username} 登录")
        db.commit()
        return {"access_token": token, "token_type": "bearer", "user": serialize_user(user, db)}

    @app.post(f"{settings.api_prefix}/auth/logout")
    def logout(user: User = Depends(current_user), db: Session = Depends(get_db)):
        audit(db, user.id, "AUTH_LOGOUT", "user", user.id, f"{user.username} 登出")
        db.commit()
        return {"ok": True}

    @app.get(f"{settings.api_prefix}/auth/me")
    def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
        return serialize_user(user, db)

    @app.get(f"{settings.api_prefix}/users")
    def list_users(user: User = Depends(current_user), db: Session = Depends(get_db)):
        require_role(user, db, "admin", "manager")
        return [serialize_user(item, db) for item in db.scalars(select(User).order_by(User.created_at)).all()]

    @app.post(f"{settings.api_prefix}/users")
    def create_user(payload: UserCreateRequest, user: User = Depends(current_user), db: Session = Depends(get_db)):
        require_role(user, db, "admin")
        existing = db.scalar(select(User).where(User.username == payload.username))
        if existing:
            error_response("VALIDATION_ERROR", "用户名已存在", status_code=400)
        created = User(
            username=payload.username,
            password_hash=hash_password(payload.password),
            display_name=payload.display_name,
            is_active=True,
        )
        db.add(created)
        db.flush()
        for role in payload.roles:
            db.add(UserRole(user_id=created.id, role=role))
        audit(db, user.id, "USER_CREATE", "user", created.id, f"创建用户 {created.username}")
        db.commit()
        db.refresh(created)
        return serialize_user(created, db)

    @app.patch(f"{settings.api_prefix}/users/{{user_id}}")
    def patch_user(user_id: str, payload: UserPatchRequest, actor: User = Depends(current_user), db: Session = Depends(get_db)):
        require_role(actor, db, "admin")
        target = db.get(User, user_id)
        if not target:
            error_response("NOT_FOUND", "用户不存在", status_code=404)
        before = serialize_user(target, db)
        if payload.display_name is not None:
            target.display_name = payload.display_name
        if payload.is_active is not None:
            target.is_active = payload.is_active
        if payload.roles is not None:
            db.query(UserRole).filter(UserRole.user_id == target.id).delete()
            for role in payload.roles:
                db.add(UserRole(user_id=target.id, role=role))
        audit(db, actor.id, "USER_UPDATE", "user", target.id, f"更新用户 {target.username}", before, serialize_user(target, db))
        db.commit()
        return serialize_user(target, db)

    @app.delete(f"{settings.api_prefix}/users/{{user_id}}")
    def delete_user(user_id: str, actor: User = Depends(current_user), db: Session = Depends(get_db)):
        require_role(actor, db, "admin")
        target = db.get(User, user_id)
        if not target:
            error_response("NOT_FOUND", "用户不存在", status_code=404)
        if target.id == actor.id:
            error_response("CANNOT_DELETE_SELF", "不能删除当前登录账号", status_code=400)

        references = user_activity_references(target.id, db)
        if references:
            error_response(
                "USER_HAS_ACTIVITY",
                "该账号已关联任务或标注记录，不能删除。请先禁用该账号。",
                {"references": references},
                status_code=409,
            )

        before = serialize_user(target, db)
        username = target.username
        db.query(UserRole).filter(UserRole.user_id == target.id).delete(synchronize_session=False)
        db.query(AuditLog).filter(AuditLog.actor_user_id == target.id).update(
            {AuditLog.actor_user_id: None},
            synchronize_session=False,
        )
        db.delete(target)
        audit(db, actor.id, "USER_DELETE", "user", user_id, f"删除用户 {username}", before, None)
        db.commit()
        return {"ok": True}

    @app.get(f"{settings.api_prefix}/storage/roots")
    def storage_roots(user: User = Depends(current_user), db: Session = Depends(get_db)):
        require_role(user, db, "admin", "manager")
        return settings.storage_roots()

    @app.get(f"{settings.api_prefix}/storage/browse")
    def storage_browse(
        root: str = Query(...),
        path: str = Query(default=""),
        keyword: str | None = Query(default=None),
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=100, ge=1, le=500),
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ):
        require_role(user, db, "admin", "manager")
        folder = safe_join_storage(root, path)
        if not folder.exists() or not folder.is_dir():
            error_response("NOT_FOUND", "目录不存在", status_code=404)

        directories = []
        files = []
        for item in sorted(folder.iterdir(), key=lambda value: (not value.is_dir(), value.name.lower())):
            relative = item.relative_to(settings.storage_root_path).as_posix()
            if item.is_dir():
                directories.append({"name": item.name, "path": relative})
                continue
            if item.suffix.lower() not in STORAGE_IMAGE_EXTENSIONS:
                continue
            if keyword and keyword.lower() not in item.name.lower():
                continue
            files.append(serialize_storage_file(item))
        start = (page - 1) * page_size
        end = start + page_size
        return {
            "root": root,
            "path": path.replace("\\", "/"),
            "directories": directories,
            "files": files[start:end],
            "total": len(files),
        }

    @app.get(f"{settings.api_prefix}/storage/folder-images")
    def storage_folder_images(
        root: str = Query(...),
        path: str = Query(default=""),
        recursive: bool = Query(default=False),
        max_files: int = Query(default=5000, ge=1, le=20000),
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ):
        require_role(user, db, "admin", "manager")
        folder = safe_join_storage(root, path)
        if not folder.exists() or not folder.is_dir():
            error_response("NOT_FOUND", "目录不存在", status_code=404)

        candidates = folder.rglob("*") if recursive else folder.iterdir()
        image_paths = [
            item
            for item in candidates
            if item.is_file() and item.suffix.lower() in STORAGE_IMAGE_EXTENSIONS
        ]
        image_paths = sorted(image_paths, key=lambda value: value.relative_to(settings.storage_root_path).as_posix().lower())
        limited = image_paths[:max_files]
        return {
            "root": root,
            "path": path.replace("\\", "/"),
            "recursive": recursive,
            "files": [serialize_storage_file(item) for item in limited],
            "total": len(image_paths),
        }

    @app.get(f"{settings.api_prefix}/tasks")
    def list_tasks(
        status: str | None = Query(default=None),
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ):
        roles = user_roles(user, db)
        query = select(AnnotationTask).where(AnnotationTask.deleted_at.is_(None))
        if "admin" not in roles:
            reviewer_id = select(TaskReviewer.task_id).where(
                TaskReviewer.reviewer_user_id == user.id,
                TaskReviewer.is_primary.is_(True),
            )
            query = query.where(
                or_(
                    AnnotationTask.created_by == user.id,
                    AnnotationTask.assignee_user_id == user.id,
                    AnnotationTask.id.in_(reviewer_id),
                )
            )
        if status:
            query = query.where(AnnotationTask.status == status)
        tasks = db.scalars(query.order_by(AnnotationTask.updated_at.desc())).all()
        return [serialize_task(task, db) for task in tasks]

    @app.post(f"{settings.api_prefix}/tasks")
    def create_task(payload: TaskCreateRequest, actor: User = Depends(current_user), db: Session = Depends(get_db)):
        require_role(actor, db, "admin", "manager")
        assignee = db.get(User, payload.assignee_user_id)
        reviewer = db.get(User, payload.reviewer_user_id)
        if not assignee or not reviewer:
            error_response("VALIDATION_ERROR", "标注员或审核员不存在", status_code=400)
        image_sources = [
            get_or_create_source_image(payload.storage_root_ref, image.relative_path, db)
            for image in payload.images
        ]
        ensure_sources_not_in_open_tasks(image_sources, db)
        task = AnnotationTask(
            title=payload.title,
            description=payload.description,
            assignee_user_id=payload.assignee_user_id,
            created_by=actor.id,
            storage_root_ref=payload.storage_root_ref,
            due_at=payload.due_at,
            priority=payload.priority,
            status="in_progress",
        )
        db.add(task)
        db.flush()
        db.add(TaskReviewer(task_id=task.id, reviewer_user_id=payload.reviewer_user_id, is_primary=True))

        labels = payload.label_classes
        for index, label in enumerate(labels):
            db.add(LabelClass(task_id=task.id, name=label.name, color=label.color, sort_order=index))

        created_task_images: list[TaskImage] = []
        for index, (image, source) in enumerate(zip(payload.images, image_sources)):
            task_image = TaskImage(
                task_id=task.id,
                source_image_id=source.id,
                sort_order=image.sort_order if image.sort_order else index,
                file_path=source.canonical_path,
                file_hash=source.file_hash,
                width=source.width,
                height=source.height,
                thumb_url=None,
                per_image_status="not_started",
            )
            created_task_images.append(task_image)
            db.add(task_image)

        db.flush()
        label_by_name = task_label_lookup_by_name(task.id, db)
        for task_image in created_task_images:
            seed_working_annotation_from_sidecar(task, task_image, actor.id, label_by_name, db)

        audit(db, actor.id, "TASK_CREATE", "task", task.id, f"创建任务 {task.title}")
        db.commit()
        db.refresh(task)
        return serialize_task(task, db)

    @app.get(f"{settings.api_prefix}/tasks/{{task_id}}")
    def get_task(task_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
        task = get_task_or_404(task_id, db)
        ensure_task_visible(user, task, db)
        task_info = serialize_task(task, db)
        task_info["images"] = [
            serialize_task_image(image, db)
            for image in db.scalars(select(TaskImage).where(TaskImage.task_id == task.id).order_by(TaskImage.sort_order)).all()
        ]
        task_info["classes"] = [
            {
                "id": label.id,
                "name": label.name,
                "color": label.color,
                "sort_order": label.sort_order,
            }
            for label in db.scalars(
                select(LabelClass)
                .where(LabelClass.task_id == task.id, LabelClass.deleted_at.is_(None))
                .order_by(LabelClass.sort_order)
            ).all()
        ]
        return task_info

    @app.patch(f"{settings.api_prefix}/tasks/{{task_id}}")
    def patch_task(task_id: str, payload: TaskPatchRequest, actor: User = Depends(current_user), db: Session = Depends(get_db)):
        task = get_task_or_404(task_id, db)
        if not user_can_manage_task(actor, task, db):
            error_response("FORBIDDEN", "仅任务创建者或管理员可更新任务", status_code=403)
        before = serialize_task(task, db)
        if payload.assignee_user_id or payload.reviewer_user_id:
            ensure_no_pending_submission(task.id, db)
        if payload.title is not None:
            task.title = payload.title
        if payload.description is not None:
            task.description = payload.description
        if payload.due_at is not None:
            task.due_at = payload.due_at
        if payload.priority is not None:
            task.priority = payload.priority
        if payload.assignee_user_id is not None:
            task.assignee_user_id = payload.assignee_user_id
        if payload.reviewer_user_id is not None:
            db.query(TaskReviewer).filter(TaskReviewer.task_id == task.id).delete()
            db.add(TaskReviewer(task_id=task.id, reviewer_user_id=payload.reviewer_user_id, is_primary=True))
        recompute_task_status(task, db)
        audit(db, actor.id, "TASK_UPDATE", "task", task.id, f"更新任务 {task.title}", before, serialize_task(task, db))
        db.commit()
        return serialize_task(task, db)

    @app.delete(f"{settings.api_prefix}/tasks/{{task_id}}")
    def delete_task(task_id: str, actor: User = Depends(current_user), db: Session = Depends(get_db)):
        require_role(actor, db, "admin", "manager")
        task = get_task_or_404(task_id, db)
        before = serialize_task(task, db)
        task_title = task.title
        if task.status == "approved":
            task.deleted_at = utcnow()
            audit(db, actor.id, "TASK_DELETE", "task", task_id, f"hide approved task record {task_title}", before, None)
            db.commit()
            return {"ok": True}
        delete_task_graph(task, db)
        audit(db, actor.id, "TASK_DELETE", "task", task_id, f"delete task record {task_title}", before, None)
        db.commit()
        return {"ok": True}

    @app.get(f"{settings.api_prefix}/tasks/{{task_id}}/images")
    def list_task_images(task_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
        task = get_task_or_404(task_id, db)
        ensure_task_visible(user, task, db)
        return [
            serialize_task_image(image, db)
            for image in db.scalars(select(TaskImage).where(TaskImage.task_id == task_id).order_by(TaskImage.sort_order)).all()
        ]

    @app.post(f"{settings.api_prefix}/tasks/{{task_id}}/images")
    def add_task_images(task_id: str, images: list[dict[str, Any]], actor: User = Depends(current_user), db: Session = Depends(get_db)):
        task = get_task_or_404(task_id, db)
        if not user_can_manage_task(actor, task, db):
            error_response("FORBIDDEN", "仅任务创建者或管理员可追加图像", status_code=403)
        ensure_no_pending_submission(task.id, db)
        current_count = db.scalar(select(func.count(TaskImage.id)).where(TaskImage.task_id == task.id)) or 0
        prepared_images: list[tuple[dict[str, Any], SourceImage]] = []
        for image in images:
            relative_path = image.get("relative_path")
            if not relative_path:
                error_response("VALIDATION_ERROR", "图像路径不能为空", status_code=400)
            source = get_or_create_source_image(task.storage_root_ref, relative_path, db)
            prepared_images.append((image, source))
        ensure_sources_not_in_open_tasks([source for _, source in prepared_images], db)
        created_task_images: list[TaskImage] = []
        for offset, (image, source) in enumerate(prepared_images):
            task_image = TaskImage(
                task_id=task.id,
                source_image_id=source.id,
                sort_order=current_count + offset,
                file_path=source.canonical_path,
                file_hash=source.file_hash,
                width=source.width,
                height=source.height,
                per_image_status="not_started",
            )
            created_task_images.append(task_image)
            db.add(task_image)

        db.flush()
        label_by_name = task_label_lookup_by_name(task.id, db)
        for task_image in created_task_images:
            seed_working_annotation_from_sidecar(task, task_image, actor.id, label_by_name, db)

        recompute_task_status(task, db)
        audit(db, actor.id, "TASK_IMAGES_ADD", "task", task.id, f"任务 {task.title} 追加图像 {len(images)} 张")
        db.commit()
        return {"ok": True}

    @app.get(f"{settings.api_prefix}/tasks/{{task_id}}/classes")
    def list_label_classes(task_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
        task = get_task_or_404(task_id, db)
        ensure_task_visible(user, task, db)
        return [
            {
                "id": label.id,
                "name": label.name,
                "color": label.color,
                "sort_order": label.sort_order,
            }
            for label in db.scalars(
                select(LabelClass)
                .where(LabelClass.task_id == task.id, LabelClass.deleted_at.is_(None))
                .order_by(LabelClass.sort_order)
            ).all()
        ]

    @app.post(f"{settings.api_prefix}/tasks/{{task_id}}/classes")
    def create_label_class(task_id: str, payload: LabelClassInput, actor: User = Depends(current_user), db: Session = Depends(get_db)):
        task = get_task_or_404(task_id, db)
        if not (user_can_manage_task(actor, task, db) or task.assignee_user_id == actor.id):
            error_response("FORBIDDEN", "当前用户不能新增类别", status_code=403)
        ensure_no_pending_submission(task.id, db)
        order = db.scalar(select(func.count(LabelClass.id)).where(LabelClass.task_id == task.id)) or 0
        label = LabelClass(task_id=task.id, name=payload.name, color=payload.color, sort_order=order)
        db.add(label)
        audit(db, actor.id, "LABEL_CLASS_CREATE", "task", task.id, f"任务 {task.title} 新增类别 {payload.name}")
        db.commit()
        return {"id": label.id, "name": label.name, "color": label.color, "sort_order": label.sort_order}

    @app.patch(f"{settings.api_prefix}/tasks/{{task_id}}/classes/{{class_id}}")
    def patch_label_class(
        task_id: str,
        class_id: str,
        payload: LabelClassInput,
        actor: User = Depends(current_user),
        db: Session = Depends(get_db),
    ):
        task = get_task_or_404(task_id, db)
        if not (user_can_manage_task(actor, task, db) or task.assignee_user_id == actor.id):
            error_response("FORBIDDEN", "当前用户不能修改类别", status_code=403)
        ensure_no_pending_submission(task.id, db)
        label = db.get(LabelClass, class_id)
        if not label or label.task_id != task.id or label.deleted_at is not None:
            error_response("NOT_FOUND", "类别不存在", status_code=404)
        before = {"name": label.name, "color": label.color}
        label.name = payload.name
        label.color = payload.color
        audit(db, actor.id, "LABEL_CLASS_UPDATE", "label_class", label.id, f"修改类别 {label.name}", before, {"name": label.name, "color": label.color})
        db.commit()
        return {"id": label.id, "name": label.name, "color": label.color, "sort_order": label.sort_order}

    @app.delete(f"{settings.api_prefix}/tasks/{{task_id}}/classes/{{class_id}}")
    def delete_label_class(task_id: str, class_id: str, actor: User = Depends(current_user), db: Session = Depends(get_db)):
        task = get_task_or_404(task_id, db)
        if not (user_can_manage_task(actor, task, db) or task.assignee_user_id == actor.id):
            error_response("FORBIDDEN", "当前用户不能删除类别", status_code=403)
        ensure_no_pending_submission(task.id, db)
        label = db.get(LabelClass, class_id)
        if not label or label.task_id != task.id or label.deleted_at is not None:
            error_response("NOT_FOUND", "类别不存在", status_code=404)
        label.deleted_at = utcnow()
        audit(db, actor.id, "LABEL_CLASS_DELETE", "label_class", label.id, f"删除类别 {label.name}")
        db.commit()
        return {"ok": True}

    @app.get(f"{settings.api_prefix}/tasks/{{task_id}}/images/{{image_id}}/file")
    def image_file(task_id: str, image_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
        task = get_task_or_404(task_id, db)
        ensure_task_visible(user, task, db)
        image = db.get(TaskImage, image_id)
        if not image or image.task_id != task.id:
            error_response("NOT_FOUND", "图像不存在", status_code=404)
        file_path = safe_join_storage(task.storage_root_ref, image.file_path)
        media_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        return FileResponse(file_path, media_type=media_type, filename=file_path.name)

    @app.get(f"{settings.api_prefix}/tasks/{{task_id}}/images/{{image_id}}/annotations/working")
    def get_working_annotation(task_id: str, image_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
        task = get_task_or_404(task_id, db)
        ensure_task_visible(user, task, db)
        image = db.get(TaskImage, image_id)
        if not image or image.task_id != task.id:
            error_response("NOT_FOUND", "图像不存在", status_code=404)
        working = db.scalar(select(WorkingAnnotation).where(WorkingAnnotation.task_image_id == image.id))
        return {
            "version": working.version if working else 0,
            "payload": working.payload_json if working else annotation_payload_default(),
            "updated_at": working.updated_at.isoformat() if working else None,
        }

    @app.put(f"{settings.api_prefix}/tasks/{{task_id}}/images/{{image_id}}/annotations/working")
    def put_working_annotation(
        task_id: str,
        image_id: str,
        payload: WorkingAnnotationRequest,
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ):
        task = get_task_or_404(task_id, db)
        ensure_task_visible(user, task, db)
        ensure_task_editable(user, task, db)
        image = db.get(TaskImage, image_id)
        if not image or image.task_id != task.id:
            error_response("NOT_FOUND", "图像不存在", status_code=404)

        normalized = normalize_payload(payload.payload.model_dump())
        working = db.scalar(select(WorkingAnnotation).where(WorkingAnnotation.task_image_id == image.id))
        current_version = working.version if working else 0
        if payload.expected_version != current_version:
            error_response(
                "ANNOTATION_VERSION_CONFLICT",
                "标注版本冲突，请刷新后重试",
                {"expected_version": payload.expected_version, "current_version": current_version},
                status_code=409,
            )

        before = working.payload_json if working else None
        if working:
            working.payload_json = normalized
            working.version += 1
            working.updated_by = user.id
            working.updated_at = utcnow()
        else:
            working = WorkingAnnotation(
                task_image_id=image.id,
                payload_json=normalized,
                version=1,
                updated_by=user.id,
                updated_at=utcnow(),
            )
            db.add(working)
        image.per_image_status = {
            "not_started": "not_started",
            "annotated": "in_progress",
            "no_object": "no_object_marked",
        }[normalized["annotation_state"]]
        task.status = "in_progress"
        audit(
            db,
            user.id,
            "ANNOTATION_SAVE",
            "task_image",
            image.id,
            f"工作副本 {summarize_payload(normalized)}",
            before,
            normalized,
        )
        db.commit()
        return {"version": working.version, "payload": normalized, "updated_at": working.updated_at.isoformat()}

    @app.get(f"{settings.api_prefix}/tasks/{{task_id}}/images/{{image_id}}/annotations/effective")
    def get_effective_annotation(task_id: str, image_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
        task = get_task_or_404(task_id, db)
        ensure_task_visible(user, task, db)
        image = db.get(TaskImage, image_id)
        if not image or image.task_id != task.id:
            error_response("NOT_FOUND", "图像不存在", status_code=404)
        payload = active_effective_payload(image.id, db) or annotation_payload_default()
        return {"payload": payload}

    @app.post(f"{settings.api_prefix}/tasks/{{task_id}}/submissions")
    def create_submission(task_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
        task = get_task_or_404(task_id, db)
        ensure_task_visible(user, task, db)
        if task.assignee_user_id != user.id:
            error_response("FORBIDDEN_NOT_ASSIGNEE", "只有任务标注责任人可以提交审核", status_code=403)
        ensure_no_pending_submission(task.id, db)
        submission = Submission(task_id=task.id, submitter_id=user.id, status="pending_review", created_at=utcnow())
        db.add(submission)
        db.flush()
        images = db.scalars(select(TaskImage).where(TaskImage.task_id == task.id).order_by(TaskImage.sort_order)).all()
        snapshots_by_image_id: dict[str, dict[str, Any]] = {}
        for image in images:
            working = db.scalar(select(WorkingAnnotation).where(WorkingAnnotation.task_image_id == image.id))
            snapshot = working.payload_json if working else annotation_payload_default()
            snapshots_by_image_id[image.id] = snapshot
            db.add(
                SubmissionImageSnapshot(
                    submission_id=submission.id,
                    task_image_id=image.id,
                    payload_json=snapshot,
                )
            )
            image.per_image_status = "in_review"

        ensure_submission_boxes_classified(task, snapshots_by_image_id, db)

        task.status = "in_review"
        audit(
            db,
            user.id,
            "TASK_SUBMIT",
            "submission",
            submission.id,
            f"提交任务 {task.title} 审核",
        )
        db.commit()
        return {"id": submission.id, "status": submission.status}

    @app.get(f"{settings.api_prefix}/tasks/{{task_id}}/submissions")
    def list_submissions(task_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
        task = get_task_or_404(task_id, db)
        ensure_task_visible(user, task, db)
        submissions = db.scalars(select(Submission).where(Submission.task_id == task.id).order_by(Submission.created_at.desc())).all()
        submitter_ids = {item.submitter_id for item in submissions}
        submitters_by_id: dict[str, User] = {}
        if submitter_ids:
            submitters = db.scalars(select(User).where(User.id.in_(submitter_ids))).all()
            submitters_by_id = {item.id: item for item in submitters}
        return [
            {
                "id": item.id,
                "status": item.status,
                "submitter_id": item.submitter_id,
                "submitter": serialize_submission_actor(submitters_by_id.get(item.submitter_id), item.submitter_id),
                "created_at": item.created_at.isoformat(),
                "closed_at": item.closed_at.isoformat() if item.closed_at else None,
            }
            for item in submissions
        ]

    @app.get(f"{settings.api_prefix}/submissions/{{submission_id}}")
    def get_submission(submission_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
        submission = db.get(Submission, submission_id)
        if not submission:
            error_response("NOT_FOUND", "提交不存在", status_code=404)
        task = get_task_or_404(submission.task_id, db)
        ensure_task_visible(user, task, db)
        submitter = db.get(User, submission.submitter_id)
        snapshots = db.scalars(
            select(SubmissionImageSnapshot).where(SubmissionImageSnapshot.submission_id == submission.id)
        ).all()
        review_record = db.scalar(select(ReviewRecord).where(ReviewRecord.submission_id == submission.id))
        review_details = {}
        if review_record:
            review_details = {
                detail.task_image_id: {
                    "decision": detail.decision,
                    "comment": detail.comment,
                    "example_payload": detail.example_payload_json,
                }
                for detail in db.scalars(
                    select(ImageReviewDetail).where(ImageReviewDetail.review_record_id == review_record.id)
                ).all()
            }
        return {
            "id": submission.id,
            "task_id": submission.task_id,
            "status": submission.status,
            "submitter_id": submission.submitter_id,
            "submitter": serialize_submission_actor(submitter, submission.submitter_id),
            "created_at": submission.created_at.isoformat(),
            "closed_at": submission.closed_at.isoformat() if submission.closed_at else None,
            "overall_comment": review_record.overall_comment if review_record else None,
            "images": [
                {
                    "task_image_id": snapshot.task_image_id,
                    "payload": snapshot.payload_json,
                    "review": review_details.get(snapshot.task_image_id),
                }
                for snapshot in snapshots
            ],
        }

    @app.post(f"{settings.api_prefix}/submissions/{{submission_id}}/review/batch-approve")
    def batch_approve(submission_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
        submission = db.get(Submission, submission_id)
        if not submission:
            error_response("NOT_FOUND", "提交不存在", status_code=404)
        task = get_task_or_404(submission.task_id, db)
        ensure_task_visible(user, task, db)
        ensure_primary_reviewer(user, task, db)
        snapshots = db.scalars(select(SubmissionImageSnapshot).where(SubmissionImageSnapshot.submission_id == submission.id)).all()
        payload = ReviewCompleteRequest(
            decisions=[{"task_image_id": snapshot.task_image_id, "decision": "passed"} for snapshot in snapshots],
            overall_comment=None,
        )
        return review_complete(submission_id, payload, user, db)

    @app.post(f"{settings.api_prefix}/submissions/{{submission_id}}/review/complete")
    def review_complete(
        submission_id: str,
        payload: ReviewCompleteRequest,
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ):
        submission = db.get(Submission, submission_id)
        if not submission:
            error_response("NOT_FOUND", "提交不存在", status_code=404)
        if submission.status != "pending_review":
            error_response("SUBMISSION_NOT_PENDING", "提交单不处于待审核状态", status_code=409)
        task = get_task_or_404(submission.task_id, db)
        ensure_task_visible(user, task, db)
        ensure_primary_reviewer(user, task, db)

        snapshots = db.scalars(select(SubmissionImageSnapshot).where(SubmissionImageSnapshot.submission_id == submission.id)).all()
        decisions_map = {item.task_image_id: item for item in payload.decisions}
        if len(decisions_map) != len(snapshots):
            error_response("VALIDATION_ERROR", "审核完成时必须给出所有图像的审核结论", status_code=400)

        review_record = ReviewRecord(
            submission_id=submission.id,
            reviewer_id=user.id,
            overall_comment=payload.overall_comment,
            outcome="approved",
            created_at=utcnow(),
        )
        db.add(review_record)
        db.flush()

        has_failed = False
        passed_images: list[TaskImage] = []
        passed_snapshots_by_image_id: dict[str, dict[str, Any]] = {}
        for snapshot in snapshots:
            decision = decisions_map.get(snapshot.task_image_id)
            if not decision:
                error_response("VALIDATION_ERROR", "缺少图像审核结论", status_code=400)
            db.add(
                ImageReviewDetail(
                    review_record_id=review_record.id,
                    task_image_id=snapshot.task_image_id,
                    decision=decision.decision,
                    comment=decision.comment,
                    example_payload_json=(
                        normalize_payload(decision.example_payload.model_dump())
                        if decision.decision == "failed" and decision.example_payload
                        else None
                    ),
                )
            )
            task_image = db.get(TaskImage, snapshot.task_image_id)
            if decision.decision == "passed":
                current_effective = db.scalar(
                    select(EffectiveAnnotation)
                    .where(
                        EffectiveAnnotation.task_image_id == snapshot.task_image_id,
                        EffectiveAnnotation.superseded_at.is_(None),
                    )
                    .order_by(EffectiveAnnotation.created_at.desc())
                )
                if current_effective:
                    current_effective.superseded_at = utcnow()
                db.add(
                    EffectiveAnnotation(
                        task_image_id=snapshot.task_image_id,
                        submission_id=submission.id,
                        payload_json=snapshot.payload_json,
                    )
                )
                task_image.per_image_status = (
                    "no_object_approved"
                    if snapshot.payload_json.get("annotation_state") == "no_object"
                    else "approved"
                )
                passed_images.append(task_image)
                passed_snapshots_by_image_id[snapshot.task_image_id] = snapshot.payload_json
            else:
                has_failed = True
                task_image.per_image_status = "changes_requested"

        written_xml_files: list[str] = []
        if passed_images:
            try:
                written_xml_files = write_submission_xml_files(task, passed_images, passed_snapshots_by_image_id, db)
            except OSError as exc:
                details: dict[str, Any] = {}
                if getattr(exc, "filename", None):
                    details["filename"] = str(exc.filename)
                error_response(
                    "XML_WRITE_FAILED",
                    f"写入审核通过标注 XML 失败：{exc}",
                    details,
                    status_code=500,
                )

        review_record.outcome = "changes_requested" if has_failed else "approved"
        submission.status = "completed"
        submission.closed_at = utcnow()
        # SessionLocal disables autoflush, so make the completed submission and
        # per-image decisions visible to the status recomputation query.
        db.flush()
        recompute_task_status(task, db)
        audit(
            db,
            user.id,
            "TASK_REVIEW_COMPLETE",
            "submission",
            submission.id,
            f"审核提交 {submission.id}，写入 XML {len(written_xml_files)} 份",
        )
        db.commit()
        return {"id": review_record.id, "outcome": review_record.outcome}

    @app.post(f"{settings.api_prefix}/tasks/{{task_id}}/export")
    def export_task(
        task_id: str,
        payload: ExportRequest,
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ):
        task = get_task_or_404(task_id, db)
        ensure_task_visible(user, task, db)
        export_time = utcnow().strftime("%Y%m%d%H%M%S")
        export_name = f"task-{task.id}-{payload.format}-{export_time}.zip"
        export_path = settings.export_root / export_name

        labels = db.scalars(
            select(LabelClass)
            .where(LabelClass.task_id == task.id, LabelClass.deleted_at.is_(None))
            .order_by(LabelClass.sort_order)
        ).all()
        class_index = {label.id: idx for idx, label in enumerate(labels)}
        class_names = [label.name for label in labels]
        images = db.scalars(select(TaskImage).where(TaskImage.task_id == task.id).order_by(TaskImage.sort_order)).all()

        with zipfile.ZipFile(export_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            if payload.format == "yolo":
                archive.writestr("labels/classes.txt", "\n".join(class_names))
            manifest = {
                "task_id": task.id,
                "title": task.title,
                "format": payload.format,
                "generated_at": utcnow().isoformat(),
                "images": [],
            }

            for image in images:
                effective = active_effective_payload(image.id, db)
                if not effective:
                    continue
                image_path = safe_join_storage(task.storage_root_ref, image.file_path)
                stem = Path(image.file_path).stem
                if payload.include_images:
                    archive.write(image_path, arcname=f"images/{Path(image.file_path).name}")
                if payload.format == "yolo":
                    lines = []
                    if effective.get("annotation_state") != "no_object":
                        for box in effective.get("boxes", []):
                            width = max(box["x_max"] - box["x_min"], 1)
                            height = max(box["y_max"] - box["y_min"], 1)
                            x_center = box["x_min"] + width / 2
                            y_center = box["y_min"] + height / 2
                            class_id = str(box.get("class_id"))
                            resolved_index = class_index.get(class_id, 0)
                            lines.append(
                                f"{resolved_index} {x_center / image.width:.6f} {y_center / image.height:.6f} {width / image.width:.6f} {height / image.height:.6f}"
                            )
                    archive.writestr(f"labels/{stem}.txt", "\n".join(lines))
                else:
                    archive.writestr(
                        f"labels/{stem}.json",
                        json.dumps(
                            {
                                "image_id": image.id,
                                "source_path": image.file_path,
                                "image_width": image.width,
                                "image_height": image.height,
                                "is_no_object": effective.get("is_no_object", False),
                                "boxes": effective.get("boxes", []),
                            },
                            ensure_ascii=False,
                            indent=2,
                        ),
                    )
                manifest["images"].append({"task_image_id": image.id, "file_path": image.file_path})
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))

        audit(db, user.id, "TASK_EXPORT", "task", task.id, f"导出任务 {task.title} 为 {payload.format}")
        db.commit()
        return {
            "filename": export_name,
            "download_url": f"{settings.api_prefix}/exports/{export_name}",
        }

    @app.get(f"{settings.api_prefix}/exports/{{filename}}")
    def download_export(filename: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
        _ = user
        _ = db
        path = (settings.export_root / filename).resolve()
        if not path.exists() or not path.is_relative_to(settings.export_root.resolve()):
            error_response("NOT_FOUND", "导出文件不存在", status_code=404)
        return FileResponse(path, media_type="application/zip", filename=filename)

    @app.get(f"{settings.api_prefix}/audit")
    def get_audit_logs(
        action_type: str | None = Query(default=None),
        actor_user_id: str | None = Query(default=None),
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ):
        require_role(user, db, "admin")
        query = select(AuditLog)
        if action_type:
            query = query.where(AuditLog.action_type == action_type)
        if actor_user_id:
            query = query.where(AuditLog.actor_user_id == actor_user_id)
        logs = db.scalars(query.order_by(AuditLog.timestamp.desc()).limit(300)).all()
        return [
            {
                "id": log.id,
                "actor_user_id": log.actor_user_id,
                "action_type": log.action_type,
                "target_type": log.target_type,
                "target_id": log.target_id,
                "summary": log.summary,
                "timestamp": log.timestamp.isoformat(),
                "before_json": log.before_json,
                "after_json": log.after_json,
            }
            for log in logs
        ]

    return app


app = app_factory()
