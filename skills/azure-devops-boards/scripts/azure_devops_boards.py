#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"
DEFAULT_FIELDS = [
    "System.Id",
    "System.TeamProject",
    "System.WorkItemType",
    "System.Title",
    "System.State",
    "System.AssignedTo",
    "System.Description",
    "System.AreaPath",
    "System.IterationPath",
]


def run(cmd: List[str]) -> str:
    return subprocess.check_output(cmd, text=True)


def get_token() -> str:
    out = run(["az", "account", "get-access-token", "--resource", RESOURCE, "-o", "json"])
    return json.loads(out)["accessToken"]


def resolve_org(args_org: Optional[str]) -> str:
    org = args_org or os.environ.get("AZDO_ORG")
    if not org:
        raise SystemExit("Missing org. Pass --org or set AZDO_ORG.")
    return org.rstrip("/")


def api_request(org: str, path: str, *, method: str = "GET", data: Any = None, content_type: str = "application/json") -> Any:
    url = path if path.startswith("http://") or path.startswith("https://") else org + path
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {get_token()}")
    req.add_header("Content-Type", content_type)
    body = None
    if data is not None:
        if isinstance(data, (bytes, bytearray)):
            body = data
        else:
            body = json.dumps(data).encode()
    with urllib.request.urlopen(req, data=body, timeout=60) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw else {}


def normalize_assigned_to(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        return value.get("displayName") or value.get("uniqueName")
    return value


def quote_project(project: str) -> str:
    return urllib.parse.quote(project)


def workitems_batch(org: str, ids: List[int], fields: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    if not ids:
        return []
    payload = {"ids": ids, "fields": fields or DEFAULT_FIELDS}
    return api_request(org, "/_apis/wit/workitemsbatch?api-version=7.1", method="POST", data=payload).get("value", [])


def simplify_comment(comment: Dict[str, Any]) -> Dict[str, Any]:
    created_by = comment.get("createdBy") or {}
    modified_by = comment.get("modifiedBy") or {}
    return {
        "id": comment.get("id"),
        "text": comment.get("text"),
        "createdBy": created_by.get("displayName") or created_by.get("uniqueName"),
        "createdDate": comment.get("createdDate"),
        "modifiedBy": modified_by.get("displayName") or modified_by.get("uniqueName"),
        "modifiedDate": comment.get("modifiedDate"),
    }


def get_comments(org: str, project: str, work_item_id: int, top: int = 50) -> List[Dict[str, Any]]:
    result = api_request(
        org,
        f"/{quote_project(project)}/_apis/wit/workItems/{work_item_id}/comments?$top={top}&api-version=7.1-preview.4",
        method="GET",
    )
    return [simplify_comment(comment) for comment in result.get("comments", [])]


def add_comment(org: str, project: str, work_item_id: int, text: str, dry_run: bool = False) -> Dict[str, Any]:
    payload = {"text": text}
    if dry_run:
        return {"action": "add-comment", "project": project, "workItemId": work_item_id, "text": text}
    result = api_request(
        org,
        f"/{quote_project(project)}/_apis/wit/workItems/{work_item_id}/comments?api-version=7.1-preview.4",
        method="POST",
        data=payload,
    )
    return {"action": "add-comment", "comment": simplify_comment(result)}


def list_stories(org: str, project: str, include_closed: bool = False) -> List[Dict[str, Any]]:
    state_filter = "" if include_closed else " And [System.State] <> 'Closed'"
    wiql = {
        "query": (
            "Select [System.Id], [System.Title], [System.State], [System.AssignedTo], [System.Description] "
            f"From WorkItems Where [System.TeamProject] = '{project}' And [System.WorkItemType] = 'User Story'{state_filter} "
            "Order By [System.Id] Asc"
        )
    }
    query = api_request(org, "/_apis/wit/wiql?api-version=7.1", method="POST", data=wiql)
    ids = [item["id"] for item in query.get("workItems", [])]
    items = workitems_batch(org, ids)
    stories = []
    for item in items:
        fields = item.get("fields", {})
        stories.append(
            {
                "id": fields.get("System.Id"),
                "project": fields.get("System.TeamProject"),
                "type": fields.get("System.WorkItemType"),
                "title": fields.get("System.Title"),
                "state": fields.get("System.State"),
                "assignedTo": normalize_assigned_to(fields.get("System.AssignedTo")),
                "description": fields.get("System.Description"),
                "areaPath": fields.get("System.AreaPath"),
                "iterationPath": fields.get("System.IterationPath"),
            }
        )
    return stories


def create_story(org: str, project: str, story: Dict[str, Any], dry_run: bool = False) -> Dict[str, Any]:
    title = story["title"]
    description = story.get("description")
    assigned_to = story.get("assignedTo")
    state = story.get("state")
    area_path = story.get("areaPath") or project
    iteration_path = story.get("iterationPath") or project
    ops = [
        {"op": "add", "path": "/fields/System.Title", "value": title},
        {"op": "add", "path": "/fields/System.AreaPath", "value": area_path},
        {"op": "add", "path": "/fields/System.IterationPath", "value": iteration_path},
    ]
    if description is not None:
        ops.append({"op": "add", "path": "/fields/System.Description", "value": description})
    if assigned_to is not None:
        ops.append({"op": "add", "path": "/fields/System.AssignedTo", "value": assigned_to})
    if state is not None:
        ops.append({"op": "add", "path": "/fields/System.State", "value": state})
    if dry_run:
        return {"action": "create", "project": project, "title": title, "ops": ops}
    return api_request(
        org,
        f"/{quote_project(project)}/_apis/wit/workitems/$User%20Story?api-version=7.1",
        method="POST",
        data=json.dumps(ops).encode(),
        content_type="application/json-patch+json",
    )


def patch_work_item(org: str, work_item_id: int, ops: List[Dict[str, Any]], dry_run: bool = False) -> Dict[str, Any]:
    if dry_run:
        return {"action": "update", "id": work_item_id, "ops": ops}
    return api_request(
        org,
        f"/_apis/wit/workitems/{work_item_id}?api-version=7.1",
        method="PATCH",
        data=json.dumps(ops).encode(),
        content_type="application/json-patch+json",
    )


def maybe_add_op(ops: List[Dict[str, Any]], path: str, old: Any, new: Any) -> None:
    if new is None:
        return
    if old != new:
        ops.append({"op": "add", "path": path, "value": new})


def upsert_story(org: str, project: str, story: Dict[str, Any], dry_run: bool = False) -> Dict[str, Any]:
    current = {item["title"]: item for item in list_stories(org, project, include_closed=True)}
    existing = current.get(story["title"])
    if not existing:
        created = create_story(org, project, story, dry_run=dry_run)
        return {"action": "created", "item": created if dry_run else simplify_item(created)}

    ops: List[Dict[str, Any]] = []
    maybe_add_op(ops, "/fields/System.Description", existing.get("description"), story.get("description"))
    maybe_add_op(ops, "/fields/System.AssignedTo", existing.get("assignedTo"), story.get("assignedTo"))
    maybe_add_op(ops, "/fields/System.State", existing.get("state"), story.get("state"))
    maybe_add_op(ops, "/fields/System.AreaPath", existing.get("areaPath"), story.get("areaPath") or project)
    maybe_add_op(ops, "/fields/System.IterationPath", existing.get("iterationPath"), story.get("iterationPath") or project)
    if not ops:
        return {"action": "unchanged", "item": existing}
    updated = patch_work_item(org, existing["id"], ops, dry_run=dry_run)
    return {"action": "updated", "item": updated if dry_run else simplify_item(updated)}


def close_story(org: str, work_item_id: int, dry_run: bool = False) -> Dict[str, Any]:
    ops = [{"op": "add", "path": "/fields/System.State", "value": "Closed"}]
    updated = patch_work_item(org, work_item_id, ops, dry_run=dry_run)
    return {"action": "closed", "item": updated if dry_run else simplify_item(updated)}


def simplify_item(item: Dict[str, Any]) -> Dict[str, Any]:
    fields = item.get("fields", {})
    return {
        "id": fields.get("System.Id"),
        "project": fields.get("System.TeamProject"),
        "type": fields.get("System.WorkItemType"),
        "title": fields.get("System.Title"),
        "state": fields.get("System.State"),
        "assignedTo": normalize_assigned_to(fields.get("System.AssignedTo")),
        "areaPath": fields.get("System.AreaPath"),
        "iterationPath": fields.get("System.IterationPath"),
    }


def sync_stories(org: str, project: str, spec: Dict[str, Any], close_missing: bool, dry_run: bool = False) -> Dict[str, Any]:
    desired = spec.get("stories", [])
    current_items = list_stories(org, project, include_closed=True)
    current_by_title = {item["title"]: item for item in current_items}
    results = {"project": project, "created": [], "updated": [], "unchanged": [], "closed": []}

    desired_titles = []
    for story in desired:
        desired_titles.append(story["title"])
        result = upsert_story(org, project, story, dry_run=dry_run)
        results[result["action"]].append(result["item"])

    if close_missing:
        for title, item in current_by_title.items():
            if item.get("state") == "Closed":
                continue
            if title not in desired_titles:
                result = close_story(org, item["id"], dry_run=dry_run)
                results["closed"].append(result["item"])

    return results


def cmd_list(args: argparse.Namespace) -> None:
    org = resolve_org(args.org)
    stories = list_stories(org, args.project, include_closed=args.include_closed)
    print(json.dumps(stories, indent=2))


def cmd_get_comments(args: argparse.Namespace) -> None:
    org = resolve_org(args.org)
    comments = get_comments(org, args.project, args.work_item_id, top=args.top)
    print(json.dumps(comments, indent=2))


def cmd_add_comment(args: argparse.Namespace) -> None:
    org = resolve_org(args.org)
    result = add_comment(org, args.project, args.work_item_id, args.text, dry_run=args.dry_run)
    print(json.dumps(result, indent=2))


def cmd_upsert(args: argparse.Namespace) -> None:
    org = resolve_org(args.org)
    story = {
        "title": args.title,
        "description": args.description,
        "assignedTo": args.assigned_to,
        "state": args.state,
        "areaPath": args.area_path,
        "iterationPath": args.iteration_path,
    }
    result = upsert_story(org, args.project, story, dry_run=args.dry_run)
    print(json.dumps(result, indent=2))


def cmd_sync(args: argparse.Namespace) -> None:
    org = resolve_org(args.org)
    with open(args.spec, "r", encoding="utf-8") as f:
        spec = json.load(f)
    project = args.project or spec.get("project")
    if not project:
        raise SystemExit("Missing project. Put it in the spec or pass --project.")
    result = sync_stories(org, project, spec, close_missing=args.close_missing, dry_run=args.dry_run)
    print(json.dumps(result, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage Azure DevOps Boards with User Stories as the visible board cards.")
    parser.add_argument("--org", help="Azure DevOps org URL, e.g. https://dev.azure.com/dialogixhq")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list-stories", help="List User Stories for a project")
    p_list.add_argument("--project", required=True)
    p_list.add_argument("--include-closed", action="store_true")
    p_list.set_defaults(func=cmd_list)

    p_get_comments = sub.add_parser("get-comments", help="List comments for a work item")
    p_get_comments.add_argument("--project", required=True)
    p_get_comments.add_argument("--work-item-id", type=int, required=True)
    p_get_comments.add_argument("--top", type=int, default=50)
    p_get_comments.set_defaults(func=cmd_get_comments)

    p_add_comment = sub.add_parser("add-comment", help="Add a comment to a work item")
    p_add_comment.add_argument("--project", required=True)
    p_add_comment.add_argument("--work-item-id", type=int, required=True)
    p_add_comment.add_argument("--text", required=True)
    p_add_comment.add_argument("--dry-run", action="store_true")
    p_add_comment.set_defaults(func=cmd_add_comment)

    p_upsert = sub.add_parser("upsert-story", help="Create or update one User Story by title")
    p_upsert.add_argument("--project", required=True)
    p_upsert.add_argument("--title", required=True)
    p_upsert.add_argument("--description")
    p_upsert.add_argument("--assigned-to")
    p_upsert.add_argument("--state")
    p_upsert.add_argument("--area-path")
    p_upsert.add_argument("--iteration-path")
    p_upsert.add_argument("--dry-run", action="store_true")
    p_upsert.set_defaults(func=cmd_upsert)

    p_sync = sub.add_parser("sync-stories", help="Bulk sync User Stories from a JSON spec")
    p_sync.add_argument("--project")
    p_sync.add_argument("--spec", required=True)
    p_sync.add_argument("--close-missing", action="store_true")
    p_sync.add_argument("--dry-run", action="store_true")
    p_sync.set_defaults(func=cmd_sync)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
