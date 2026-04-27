from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path
from uuid import uuid4
from xml.etree import ElementTree as ET

from fastapi.testclient import TestClient


TEST_RUNTIME_DIR = Path(tempfile.mkdtemp(prefix="labelwe-tests-"))
TEST_DB = TEST_RUNTIME_DIR / "test.db"
TEST_STORAGE_ROOT = TEST_RUNTIME_DIR / "images"
TEST_EXPORT_ROOT = TEST_RUNTIME_DIR / "exports"
SAMPLE_STORAGE_ROOT = (Path(__file__).resolve().parents[2] / "sample-data" / "images").resolve()
shutil.copytree(SAMPLE_STORAGE_ROOT, TEST_STORAGE_ROOT)
TEST_EXPORT_ROOT.mkdir(parents=True, exist_ok=True)

os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB.as_posix()}"
os.environ["STORAGE_ROOT"] = str(TEST_STORAGE_ROOT.resolve())
os.environ["EXPORT_ROOT"] = str(TEST_EXPORT_ROOT.resolve())
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.models import (  # noqa: E402
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
    WorkingAnnotation,
)


def reset_workflow_data() -> None:
    with SessionLocal() as db:
        for model in [
            EffectiveAnnotation,
            ImageReviewDetail,
            ReviewRecord,
            SubmissionImageSnapshot,
            Submission,
            WorkingAnnotation,
            LabelClass,
            TaskReviewer,
            TaskImage,
            AnnotationTask,
            SourceImage,
            AuditLog,
        ]:
            db.query(model).delete()
        db.commit()

    for xml_file in TEST_STORAGE_ROOT.rglob("*.xml"):
        xml_file.unlink(missing_ok=True)
    for zip_file in TEST_EXPORT_ROOT.glob("*.zip"):
        zip_file.unlink(missing_ok=True)


def login(client: TestClient, username: str, password: str) -> dict[str, str]:
    response = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    token = response.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def create_task(client: TestClient, manager_headers: dict[str, str]) -> str:
    browse = client.get("/api/v1/storage/browse", params={"root": "workspace-samples"}, headers=manager_headers)
    assert browse.status_code == 200, browse.text
    files = browse.json()["files"][:2]

    users = client.get("/api/v1/users", headers=manager_headers).json()
    annotator = next(item for item in users if item["username"] == "annotator")
    reviewer = next(item for item in users if item["username"] == "reviewer")

    response = client.post(
        "/api/v1/tasks",
        headers=manager_headers,
        json={
            "title": "Smoke Task",
            "description": "Permission and review flow",
            "assignee_user_id": annotator["id"],
            "reviewer_user_id": reviewer["id"],
            "storage_root_ref": "workspace-samples",
            "priority": "high",
            "images": [{"relative_path": item["path"]} for item in files],
            "label_classes": [
                {"name": "car", "color": "#ff7a18"},
                {"name": "person", "color": "#00a6fb"},
            ],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def create_task_without_classes(client: TestClient, manager_headers: dict[str, str]) -> str:
    browse = client.get("/api/v1/storage/browse", params={"root": "workspace-samples"}, headers=manager_headers)
    assert browse.status_code == 200, browse.text
    files = browse.json()["files"][:1]

    users = client.get("/api/v1/users", headers=manager_headers).json()
    annotator = next(item for item in users if item["username"] == "annotator")
    reviewer = next(item for item in users if item["username"] == "reviewer")

    response = client.post(
        "/api/v1/tasks",
        headers=manager_headers,
        json={
            "title": "Empty Class Task",
            "description": "No default class",
            "assignee_user_id": annotator["id"],
            "reviewer_user_id": reviewer["id"],
            "storage_root_ref": "workspace-samples",
            "priority": "high",
            "images": [{"relative_path": item["path"]} for item in files],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_storage_folder_images_supports_recursive_lookup():
    with TestClient(app) as client:
        reset_workflow_data()
        manager_headers = login(client, "manager", "manager123")

        folder_name = f"recursive-folder-{uuid4().hex[:8]}"
        folder = TEST_STORAGE_ROOT / folder_name
        deep_folder = folder / "nested" / "level2"
        deep_folder.mkdir(parents=True, exist_ok=True)

        source_svg = TEST_STORAGE_ROOT / "assembly-line.svg"
        shallow_image = folder / "shallow.svg"
        deep_image = deep_folder / "deep.svg"
        shutil.copy2(source_svg, shallow_image)
        shutil.copy2(source_svg, deep_image)

        non_recursive = client.get(
            "/api/v1/storage/folder-images",
            params={"root": "workspace-samples", "path": folder_name, "recursive": False},
            headers=manager_headers,
        )
        assert non_recursive.status_code == 200, non_recursive.text
        non_recursive_paths = {item["path"] for item in non_recursive.json()["files"]}
        assert non_recursive.json()["total"] == 1
        assert non_recursive_paths == {shallow_image.relative_to(TEST_STORAGE_ROOT).as_posix()}

        recursive = client.get(
            "/api/v1/storage/folder-images",
            params={"root": "workspace-samples", "path": folder_name, "recursive": True},
            headers=manager_headers,
        )
        assert recursive.status_code == 200, recursive.text
        recursive_paths = {item["path"] for item in recursive.json()["files"]}
        assert recursive.json()["total"] == 2
        assert recursive_paths == {
            shallow_image.relative_to(TEST_STORAGE_ROOT).as_posix(),
            deep_image.relative_to(TEST_STORAGE_ROOT).as_posix(),
        }


def test_create_task_imports_sidecar_xml_as_working_annotation():
    with TestClient(app) as client:
        reset_workflow_data()
        manager_headers = login(client, "manager", "manager123")

        folder_name = f"xml-seed-{uuid4().hex[:8]}"
        folder = TEST_STORAGE_ROOT / folder_name
        folder.mkdir(parents=True, exist_ok=True)
        image_path = folder / "seed.svg"
        shutil.copy2(TEST_STORAGE_ROOT / "assembly-line.svg", image_path)
        xml_path = image_path.with_suffix(".xml")
        xml_path.write_text(
            """<?xml version="1.0" encoding="utf-8"?>
<annotation>
  <object>
    <name>car</name>
    <bndbox>
      <xmin>16</xmin>
      <ymin>24</ymin>
      <xmax>180</xmax>
      <ymax>220</ymax>
    </bndbox>
  </object>
</annotation>
""",
            encoding="utf-8",
        )

        users = client.get("/api/v1/users", headers=manager_headers).json()
        annotator = next(item for item in users if item["username"] == "annotator")
        reviewer = next(item for item in users if item["username"] == "reviewer")

        created = client.post(
            "/api/v1/tasks",
            headers=manager_headers,
            json={
                "title": "XML Seed Task",
                "description": "import sidecar xml",
                "assignee_user_id": annotator["id"],
                "reviewer_user_id": reviewer["id"],
                "storage_root_ref": "workspace-samples",
                "priority": "high",
                "images": [{"relative_path": image_path.relative_to(TEST_STORAGE_ROOT).as_posix()}],
                "label_classes": [{"name": "car", "color": "#ff7a18"}],
            },
        )
        assert created.status_code == 200, created.text
        task_id = created.json()["id"]

        task_detail = client.get(f"/api/v1/tasks/{task_id}", headers=login(client, "annotator", "annotator123"))
        assert task_detail.status_code == 200, task_detail.text
        image = task_detail.json()["images"][0]
        assert image["working_version"] == 1
        assert image["annotation_state"] == "annotated"
        assert image["boxes_count"] == 1
        assert image["per_image_status"] == "in_progress"

        working = client.get(
            f"/api/v1/tasks/{task_id}/images/{image['id']}/annotations/working",
            headers=login(client, "annotator", "annotator123"),
        )
        assert working.status_code == 200, working.text
        box = working.json()["payload"]["boxes"][0]
        assert box["class_name"] == "car"
        assert box["x_min"] == 16
        assert box["y_min"] == 24
        assert box["x_max"] == 180
        assert box["y_max"] == 220


def test_add_task_images_imports_sidecar_xml_as_working_annotation():
    with TestClient(app) as client:
        reset_workflow_data()
        manager_headers = login(client, "manager", "manager123")
        task_id = create_task(client, manager_headers)

        folder_name = f"xml-add-{uuid4().hex[:8]}"
        folder = TEST_STORAGE_ROOT / folder_name
        folder.mkdir(parents=True, exist_ok=True)
        image_path = folder / "added.svg"
        shutil.copy2(TEST_STORAGE_ROOT / "yard-overview.svg", image_path)
        xml_path = image_path.with_suffix(".xml")
        xml_path.write_text(
            """<?xml version="1.0" encoding="utf-8"?>
<annotation>
  <object>
    <name>person</name>
    <bndbox>
      <xmin>30</xmin>
      <ymin>36</ymin>
      <xmax>210</xmax>
      <ymax>260</ymax>
    </bndbox>
  </object>
</annotation>
""",
            encoding="utf-8",
        )

        added = client.post(
            f"/api/v1/tasks/{task_id}/images",
            headers=manager_headers,
            json=[{"relative_path": image_path.relative_to(TEST_STORAGE_ROOT).as_posix()}],
        )
        assert added.status_code == 200, added.text

        annotator_headers = login(client, "annotator", "annotator123")
        task_detail = client.get(f"/api/v1/tasks/{task_id}", headers=annotator_headers)
        assert task_detail.status_code == 200, task_detail.text
        added_image = next(item for item in task_detail.json()["images"] if item["file_path"].endswith("/added.svg"))
        assert added_image["working_version"] == 1
        assert added_image["annotation_state"] == "annotated"
        assert added_image["boxes_count"] == 1

        working = client.get(
            f"/api/v1/tasks/{task_id}/images/{added_image['id']}/annotations/working",
            headers=annotator_headers,
        )
        assert working.status_code == 200, working.text
        box = working.json()["payload"]["boxes"][0]
        assert box["class_name"] == "person"
        assert box["x_min"] == 30
        assert box["y_min"] == 36
        assert box["x_max"] == 210
        assert box["y_max"] == 260


def test_admin_can_disable_and_delete_inactive_user():
    with TestClient(app) as client:
        reset_workflow_data()
        admin_headers = login(client, "admin", "admin123")
        username = f"delete_target_{uuid4().hex[:8]}"

        created = client.post(
            "/api/v1/users",
            headers=admin_headers,
            json={
                "username": username,
                "password": "TempPass123!",
                "display_name": "Delete Target",
                "roles": ["annotator"],
            },
        )
        assert created.status_code == 200, created.text
        user_id = created.json()["id"]

        disabled = client.patch(
            f"/api/v1/users/{user_id}",
            headers=admin_headers,
            json={
                "is_active": False,
                "roles": ["annotator"],
                "display_name": "Delete Target",
            },
        )
        assert disabled.status_code == 200, disabled.text
        assert disabled.json()["is_active"] is False

        deleted = client.delete(f"/api/v1/users/{user_id}", headers=admin_headers)
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["ok"] is True

        users = client.get("/api/v1/users", headers=admin_headers)
        assert users.status_code == 200, users.text
        assert all(item["id"] != user_id for item in users.json())

        audit = client.get("/api/v1/audit", headers=admin_headers)
        assert audit.status_code == 200, audit.text
        assert any(item["action_type"] == "USER_DELETE" and item["target_id"] == user_id for item in audit.json())


def test_admin_cannot_delete_self_or_user_with_activity():
    with TestClient(app) as client:
        reset_workflow_data()
        admin_headers = login(client, "admin", "admin123")
        manager_headers = login(client, "manager", "manager123")

        users = client.get("/api/v1/users", headers=admin_headers)
        assert users.status_code == 200, users.text
        observer = next(item for item in users.json() if item["username"] == "observer")

        forbidden = client.delete(f"/api/v1/users/{observer['id']}", headers=manager_headers)
        assert forbidden.status_code == 403, forbidden.text

        me = client.get("/api/v1/auth/me", headers=admin_headers)
        assert me.status_code == 200, me.text
        self_delete = client.delete(f"/api/v1/users/{me.json()['id']}", headers=admin_headers)
        assert self_delete.status_code == 400, self_delete.text
        assert self_delete.json()["error"]["code"] == "CANNOT_DELETE_SELF"

        _ = create_task(client, manager_headers)
        users_after_task = client.get("/api/v1/users", headers=admin_headers)
        assert users_after_task.status_code == 200, users_after_task.text
        annotator = next(item for item in users_after_task.json() if item["username"] == "annotator")
        blocked = client.delete(f"/api/v1/users/{annotator['id']}", headers=admin_headers)
        assert blocked.status_code == 409, blocked.text
        assert blocked.json()["error"]["code"] == "USER_HAS_ACTIVITY"


def test_source_images_cannot_be_assigned_to_multiple_open_tasks():
    with TestClient(app) as client:
        reset_workflow_data()
        manager_headers = login(client, "manager", "manager123")
        users = client.get("/api/v1/users", headers=manager_headers).json()
        annotator = next(item for item in users if item["username"] == "annotator")
        reviewer = next(item for item in users if item["username"] == "reviewer")
        browse = client.get("/api/v1/storage/browse", params={"root": "workspace-samples"}, headers=manager_headers)
        assert browse.status_code == 200, browse.text
        files = browse.json()["files"][:2]
        payload = {
            "title": "Exclusive Task",
            "description": "First owner keeps the source images locked",
            "assignee_user_id": annotator["id"],
            "reviewer_user_id": reviewer["id"],
            "storage_root_ref": "workspace-samples",
            "priority": "high",
            "images": [{"relative_path": item["path"]} for item in files],
            "label_classes": [{"name": "car", "color": "#ff7a18"}],
        }

        first = client.post("/api/v1/tasks", headers=manager_headers, json=payload)
        assert first.status_code == 200, first.text

        duplicate = client.post("/api/v1/tasks", headers=manager_headers, json={**payload, "title": "Duplicate Task"})
        assert duplicate.status_code == 409, duplicate.text
        assert duplicate.json()["error"]["code"] == "SOURCE_IMAGE_ALREADY_ASSIGNED"


def test_manager_and_admin_can_delete_task_and_release_sources():
    with TestClient(app) as client:
        reset_workflow_data()
        manager_headers = login(client, "manager", "manager123")
        admin_headers = login(client, "admin", "admin123")

        task_id = create_task(client, manager_headers)

        deleted_by_manager = client.delete(f"/api/v1/tasks/{task_id}", headers=manager_headers)
        assert deleted_by_manager.status_code == 200, deleted_by_manager.text
        assert deleted_by_manager.json()["ok"] is True

        second_task_id = create_task(client, manager_headers)
        deleted_by_admin = client.delete(f"/api/v1/tasks/{second_task_id}", headers=admin_headers)
        assert deleted_by_admin.status_code == 200, deleted_by_admin.text
        assert deleted_by_admin.json()["ok"] is True

        missing = client.get(f"/api/v1/tasks/{task_id}", headers=admin_headers)
        assert missing.status_code == 404

        recreated_task_id = create_task(client, manager_headers)
        assert recreated_task_id != task_id

        audit = client.get("/api/v1/audit", headers=admin_headers)
        assert audit.status_code == 200
        assert any(item["action_type"] == "TASK_DELETE" and item["target_id"] == task_id for item in audit.json())


def test_manager_can_delete_approved_task():
    with TestClient(app) as client:
        reset_workflow_data()
        manager_headers = login(client, "manager", "manager123")
        admin_headers = login(client, "admin", "admin123")
        annotator_headers = login(client, "annotator", "annotator123")
        reviewer_headers = login(client, "reviewer", "reviewer123")

        task_id = create_task(client, manager_headers)
        with SessionLocal() as db:
            task = db.get(AnnotationTask, task_id)
            assert task is not None
            task.status = "approved"
            db.commit()

        deleted = client.delete(f"/api/v1/tasks/{task_id}", headers=manager_headers)
        assert deleted.status_code == 200, deleted.text
        assert deleted.json()["ok"] is True

        missing = client.get(f"/api/v1/tasks/{task_id}", headers=manager_headers)
        assert missing.status_code == 404, missing.text

        manager_tasks = client.get("/api/v1/tasks", headers=manager_headers)
        assert manager_tasks.status_code == 200, manager_tasks.text
        assert all(item["id"] != task_id for item in manager_tasks.json())

        admin_tasks = client.get("/api/v1/tasks", headers=admin_headers)
        assert admin_tasks.status_code == 200, admin_tasks.text
        assert all(item["id"] != task_id for item in admin_tasks.json())

        annotator_tasks = client.get("/api/v1/tasks", headers=annotator_headers)
        assert annotator_tasks.status_code == 200, annotator_tasks.text
        assert all(item["id"] != task_id for item in annotator_tasks.json())

        reviewer_tasks = client.get("/api/v1/tasks", headers=reviewer_headers)
        assert reviewer_tasks.status_code == 200, reviewer_tasks.text
        assert all(item["id"] != task_id for item in reviewer_tasks.json())


def test_submission_requires_class_assignment_and_task_has_no_default_classes():
    with TestClient(app) as client:
        reset_workflow_data()
        manager_headers = login(client, "manager", "manager123")
        annotator_headers = login(client, "annotator", "annotator123")

        task_id = create_task_without_classes(client, manager_headers)
        task_detail = client.get(f"/api/v1/tasks/{task_id}", headers=annotator_headers)
        assert task_detail.status_code == 200, task_detail.text
        assert task_detail.json()["classes"] == []
        first_image = task_detail.json()["images"][0]

        save = client.put(
            f"/api/v1/tasks/{task_id}/images/{first_image['id']}/annotations/working",
            headers=annotator_headers,
            json={
                "expected_version": 0,
                "payload": {
                    "annotation_state": "annotated",
                    "is_no_object": False,
                    "boxes": [
                        {
                            "id": "box-unclassified",
                            "x_min": 50,
                            "y_min": 60,
                            "x_max": 180,
                            "y_max": 220,
                        }
                    ],
                },
            },
        )
        assert save.status_code == 200, save.text

        blocked_submission = client.post(f"/api/v1/tasks/{task_id}/submissions", headers=annotator_headers)
        assert blocked_submission.status_code == 400, blocked_submission.text
        assert blocked_submission.json()["error"]["code"] == "UNCLASSIFIED_BOXES"

        created_class = client.post(
            f"/api/v1/tasks/{task_id}/classes",
            headers=annotator_headers,
            json={"name": "defect", "color": "#ef476f"},
        )
        assert created_class.status_code == 200, created_class.text
        defect_class_id = created_class.json()["id"]

        save_fixed = client.put(
            f"/api/v1/tasks/{task_id}/images/{first_image['id']}/annotations/working",
            headers=annotator_headers,
            json={
                "expected_version": save.json()["version"],
                "payload": {
                    "annotation_state": "annotated",
                    "is_no_object": False,
                    "boxes": [
                        {
                            "id": "box-unclassified",
                            "class_id": defect_class_id,
                            "class_name": "defect",
                            "x_min": 50,
                            "y_min": 60,
                            "x_max": 180,
                            "y_max": 220,
                        }
                    ],
                },
            },
        )
        assert save_fixed.status_code == 200, save_fixed.text

        submitted = client.post(f"/api/v1/tasks/{task_id}/submissions", headers=annotator_headers)
        assert submitted.status_code == 200, submitted.text


def test_submission_keeps_valid_when_class_deleted_but_box_has_class_name():
    with TestClient(app) as client:
        reset_workflow_data()
        manager_headers = login(client, "manager", "manager123")
        annotator_headers = login(client, "annotator", "annotator123")

        task_id = create_task_without_classes(client, manager_headers)
        task_detail = client.get(f"/api/v1/tasks/{task_id}", headers=annotator_headers)
        assert task_detail.status_code == 200, task_detail.text
        first_image = task_detail.json()["images"][0]

        created_class = client.post(
            f"/api/v1/tasks/{task_id}/classes",
            headers=annotator_headers,
            json={"name": "defect", "color": "#ef476f"},
        )
        assert created_class.status_code == 200, created_class.text
        defect_class_id = created_class.json()["id"]

        save = client.put(
            f"/api/v1/tasks/{task_id}/images/{first_image['id']}/annotations/working",
            headers=annotator_headers,
            json={
                "expected_version": 0,
                "payload": {
                    "annotation_state": "annotated",
                    "is_no_object": False,
                    "boxes": [
                        {
                            "id": "box-keep-name",
                            "class_id": defect_class_id,
                            "class_name": "defect",
                            "x_min": 10,
                            "y_min": 20,
                            "x_max": 140,
                            "y_max": 180,
                        }
                    ],
                },
            },
        )
        assert save.status_code == 200, save.text

        deleted = client.delete(f"/api/v1/tasks/{task_id}/classes/{defect_class_id}", headers=annotator_headers)
        assert deleted.status_code == 200, deleted.text

        submitted = client.post(f"/api/v1/tasks/{task_id}/submissions", headers=annotator_headers)
        assert submitted.status_code == 200, submitted.text


def test_permission_and_review_flow():
    with TestClient(app) as client:
        reset_workflow_data()
        manager_headers = login(client, "manager", "manager123")
        annotator_headers = login(client, "annotator", "annotator123")
        reviewer_headers = login(client, "reviewer", "reviewer123")
        observer_headers = login(client, "observer", "observer123")

        task_id = create_task(client, manager_headers)
        task_detail = client.get(f"/api/v1/tasks/{task_id}", headers=annotator_headers)
        assert task_detail.status_code == 200, task_detail.text
        task_classes = task_detail.json()["classes"]
        car_class = next((item for item in task_classes if item["name"] == "car"), task_classes[0])
        images = task_detail.json()["images"]
        first_image = images[0]
        second_image = images[1]

        forbidden = client.put(
            f"/api/v1/tasks/{task_id}/images/{first_image['id']}/annotations/working",
            headers=observer_headers,
            json={
                "expected_version": 0,
                "payload": {"annotation_state": "annotated", "is_no_object": False, "boxes": []},
            },
        )
        assert forbidden.status_code == 404

        save_1 = client.put(
            f"/api/v1/tasks/{task_id}/images/{first_image['id']}/annotations/working",
            headers=annotator_headers,
            json={
                "expected_version": 0,
                "payload": {
                    "annotation_state": "annotated",
                    "is_no_object": False,
                        "boxes": [
                            {
                                "id": "box-1",
                                "class_id": car_class["id"],
                                "class_name": car_class["name"],
                                "x_min": 100,
                                "y_min": 120,
                                "x_max": 260,
                            "y_max": 320,
                        }
                    ],
                },
            },
        )
        assert save_1.status_code == 200, save_1.text

        save_2 = client.put(
            f"/api/v1/tasks/{task_id}/images/{second_image['id']}/annotations/working",
            headers=annotator_headers,
            json={
                "expected_version": 0,
                "payload": {"annotation_state": "no_object", "is_no_object": True, "boxes": []},
            },
        )
        assert save_2.status_code == 200, save_2.text

        submission = client.post(f"/api/v1/tasks/{task_id}/submissions", headers=annotator_headers)
        assert submission.status_code == 200, submission.text
        submission_id = submission.json()["id"]

        submission_rows = client.get(f"/api/v1/tasks/{task_id}/submissions", headers=reviewer_headers)
        assert submission_rows.status_code == 200, submission_rows.text
        latest_submission = submission_rows.json()[0]
        assert latest_submission["submitter_id"] == task_detail.json()["assignee_user_id"]
        assert latest_submission["submitter"]["username"] == "annotator"

        xml_path = TEST_STORAGE_ROOT / Path(first_image["file_path"]).with_suffix(".xml")
        assert not xml_path.exists(), f"Expected xml sidecar not to exist before review: {xml_path}"

        locked = client.put(
            f"/api/v1/tasks/{task_id}/images/{first_image['id']}/annotations/working",
            headers=annotator_headers,
            json={
                "expected_version": 1,
                "payload": {"annotation_state": "no_object", "is_no_object": True, "boxes": []},
            },
        )
        assert locked.status_code == 409
        assert locked.json()["error"]["code"] == "TASK_IN_REVIEW"

        review = client.post(
            f"/api/v1/submissions/{submission_id}/review/complete",
            headers=reviewer_headers,
            json={
                "overall_comment": "Looks good",
                "decisions": [
                    {"task_image_id": first_image["id"], "decision": "passed"},
                    {"task_image_id": second_image["id"], "decision": "passed"},
                ],
            },
        )
        assert review.status_code == 200, review.text

        assert xml_path.exists(), f"Expected xml sidecar to exist after review pass: {xml_path}"
        xml_root = ET.fromstring(xml_path.read_text(encoding="utf-8"))
        assert xml_root.findtext("filename") == Path(first_image["file_path"]).name
        assert any(item.findtext("name") == "car" for item in xml_root.findall("object"))

        approved_task = client.get(f"/api/v1/tasks/{task_id}", headers=manager_headers)
        assert approved_task.status_code == 200, approved_task.text
        assert approved_task.json()["status"] == "approved"

        effective = client.get(
            f"/api/v1/tasks/{task_id}/images/{second_image['id']}/annotations/effective",
            headers=annotator_headers,
        )
        assert effective.status_code == 200
        assert effective.json()["payload"]["is_no_object"] is True

        export = client.post(
            f"/api/v1/tasks/{task_id}/export",
            headers=manager_headers,
            json={"format": "platform_json", "include_images": False},
        )
        assert export.status_code == 200, export.text
        download = client.get(export.json()["download_url"], headers=manager_headers)
        assert download.status_code == 200

        audit = client.get("/api/v1/audit", headers=login(client, "admin", "admin123"))
        assert audit.status_code == 200
        assert any(item["action_type"] == "TASK_REVIEW_COMPLETE" for item in audit.json())


def test_review_rejection_releases_task_from_review_state():
    with TestClient(app) as client:
        reset_workflow_data()
        manager_headers = login(client, "manager", "manager123")
        annotator_headers = login(client, "annotator", "annotator123")
        reviewer_headers = login(client, "reviewer", "reviewer123")

        task_id = create_task(client, manager_headers)
        task_detail = client.get(f"/api/v1/tasks/{task_id}", headers=annotator_headers)
        assert task_detail.status_code == 200, task_detail.text
        images = task_detail.json()["images"]
        first_image = images[0]
        second_image = images[1]

        save = client.put(
            f"/api/v1/tasks/{task_id}/images/{first_image['id']}/annotations/working",
            headers=annotator_headers,
            json={
                "expected_version": 0,
                "payload": {"annotation_state": "no_object", "is_no_object": True, "boxes": []},
            },
        )
        assert save.status_code == 200, save.text

        submission = client.post(f"/api/v1/tasks/{task_id}/submissions", headers=annotator_headers)
        assert submission.status_code == 200, submission.text
        submission_id = submission.json()["id"]

        review = client.post(
            f"/api/v1/submissions/{submission_id}/review/complete",
            headers=reviewer_headers,
            json={
                "overall_comment": "需要补充检查",
                "decisions": [
                    {
                        "task_image_id": first_image["id"],
                        "decision": "failed",
                        "comment": "请重新确认目标",
                        "example_payload": {
                            "annotation_state": "annotated",
                            "is_no_object": False,
                            "boxes": [
                                {
                                    "id": "review-example-1",
                                    "class_id": "review-class",
                                    "class_name": "示例目标",
                                    "x_min": 10,
                                    "y_min": 20,
                                    "x_max": 80,
                                    "y_max": 120,
                                }
                            ],
                        },
                    },
                    {"task_image_id": second_image["id"], "decision": "passed"},
                ],
            },
        )
        assert review.status_code == 200, review.text
        assert review.json()["outcome"] == "changes_requested"

        rejected_task = client.get(f"/api/v1/tasks/{task_id}", headers=manager_headers)
        assert rejected_task.status_code == 200, rejected_task.text
        assert rejected_task.json()["status"] == "rejected"
        rejected_image = next(item for item in rejected_task.json()["images"] if item["id"] == first_image["id"])
        assert rejected_image["per_image_status"] == "changes_requested"
        assert rejected_image["review_example_payload"]["boxes"][0]["id"] == "review-example-1"

        submission_detail = client.get(f"/api/v1/submissions/{submission_id}", headers=annotator_headers)
        assert submission_detail.status_code == 200, submission_detail.text
        assert submission_detail.json()["submitter"]["username"] == "annotator"
        reviewed_image = next(item for item in submission_detail.json()["images"] if item["task_image_id"] == first_image["id"])
        assert reviewed_image["review"]["example_payload"]["boxes"][0]["class_name"] == "示例目标"

        effective = client.get(
            f"/api/v1/tasks/{task_id}/images/{first_image['id']}/annotations/effective",
            headers=annotator_headers,
        )
        assert effective.status_code == 200
        assert effective.json()["payload"]["boxes"] == []

        failed_xml_path = TEST_STORAGE_ROOT / Path(first_image["file_path"]).with_suffix(".xml")
        passed_xml_path = TEST_STORAGE_ROOT / Path(second_image["file_path"]).with_suffix(".xml")
        assert not failed_xml_path.exists(), f"Failed image xml should not be persisted: {failed_xml_path}"
        assert passed_xml_path.exists(), f"Passed image xml should be persisted: {passed_xml_path}"
