from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str
    password: str


class UserCreateRequest(BaseModel):
    username: str
    password: str
    display_name: str
    roles: list[str] = Field(default_factory=list)


class UserPatchRequest(BaseModel):
    display_name: str | None = None
    is_active: bool | None = None
    roles: list[str] | None = None


class LabelClassInput(BaseModel):
    name: str
    color: str


class TaskImageInput(BaseModel):
    relative_path: str
    sort_order: int = 0


class TaskCreateRequest(BaseModel):
    title: str
    description: str | None = None
    assignee_user_id: str
    reviewer_user_id: str
    storage_root_ref: str
    due_at: datetime | None = None
    priority: str = "normal"
    images: list[TaskImageInput]
    label_classes: list[LabelClassInput] = Field(default_factory=list)


class TaskPatchRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    assignee_user_id: str | None = None
    reviewer_user_id: str | None = None
    due_at: datetime | None = None
    priority: str | None = None


class AnnotationPayloadModel(BaseModel):
    annotation_state: Literal["not_started", "annotated", "no_object"] = "not_started"
    is_no_object: bool = False
    boxes: list[dict[str, Any]] = Field(default_factory=list)


class WorkingAnnotationRequest(BaseModel):
    expected_version: int
    payload: AnnotationPayloadModel


class ReviewDecisionInput(BaseModel):
    task_image_id: str
    decision: Literal["passed", "failed"]
    comment: str | None = None
    example_payload: AnnotationPayloadModel | None = None


class ReviewCompleteRequest(BaseModel):
    overall_comment: str | None = None
    decisions: list[ReviewDecisionInput]


class ExportRequest(BaseModel):
    format: Literal["yolo", "platform_json"] = "yolo"
    include_images: bool = True
